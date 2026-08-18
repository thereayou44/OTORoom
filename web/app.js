/* OTO — клиент комнаты.
 *
 * Протокол (JSON, поле type):
 *   клиент → сервер : join, offer, answer, ice, bye
 *   сервер → клиент : joined {initiator}, peer-joined, peer-left, error {message}
 *
 * Сервер пересылает offer/answer/ice не разбирая — payload для него непрозрачен.
 *
 * Три места, где WebRTC обычно ломается, и как здесь с ними:
 *   1. ICE-кандидаты приходят раньше setRemoteDescription → очередь pendingIce.
 *   2. Оба стороны шлют offer одновременно (glare) → offer шлёт только initiator,
 *      флаг приходит от сервера в joined.
 *   3. Вебсокет рвётся на мобильном интернете → переподключение с ростом паузы
 *      и повторный join.
 */

(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const el = {
        remote: $('remote'), local: $('local'), selfTile: $('selfTile'),
        camOff: $('camOff'), camOffSub: $('camOffSub'), camOffWave: $('camOffWave'),
        waiting: $('waiting'), roomName: $('roomName'), roomLink: $('roomLink'),
        copyBtn: $('copyBtn'), timer: $('timer'), route: $('route'),
        stateDot: $('stateDot'), micBtn: $('micBtn'), camBtn: $('camBtn'),
        hangBtn: $('hangBtn'), traceBtn: $('traceBtn'), traceClose: $('traceClose'),
        tracePanel: $('tracePanel'), traceLog: $('traceLog'), banner: $('banner'),
    };

    const roomId = (new URLSearchParams(location.search).get('room') || '').toLowerCase();
    if (!/^[a-z0-9-]{2,32}$/.test(roomId)) { location.replace('index.html'); return; }

    const prefs = readPrefs();

    const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

    let ws = null;
    let pc = null;
    let localStream = null;
    let iceServers = FALLBACK_ICE;

    let initiator = false;
    let pendingIce = [];          // кандидаты до setRemoteDescription
    let peerPresent = false;
    let leaving = false;

    let retry = 0, retryTimer = 0;
    let statsTimer = 0, clockTimer = 0, startedAt = 0;

    let remoteCam = true, remoteMic = true;
    let meta = null;                       // data channel для состояния камеры/микрофона
    let vizCtx = null, vizAnalyser = null, vizRaf = 0, vizLevel = 0;

    /* Состояние медиа передаём отдельным data channel, а не через сигналинг:
       это данные между браузерами, серверу про них знать незачем. Событие
       track.mute для этого не годится — Chrome при enabled=false продолжает
       слать чёрные кадры, и трек остаётся размьюченным. */
    function sendMediaState() {
        if (!meta || meta.readyState !== 'open') return;
        const cam = el.camBtn.getAttribute('aria-pressed') === 'true';
        const mic = el.micBtn.getAttribute('aria-pressed') === 'true';
        try { meta.send(JSON.stringify({ cam, mic })); } catch {}
    }

    function wireMeta(ch) {
        meta = ch;
        ch.addEventListener('open', () => { trace('канал состояния открыт', 'ok'); sendMediaState(); });
        ch.addEventListener('close', () => trace('канал состояния закрыт', 'warn'));
        ch.addEventListener('error', () => trace('ошибка канала состояния', 'err'));
        ch.addEventListener('message', (e) => {
            try {
                const s = JSON.parse(e.data);
                if (typeof s.cam === 'boolean') remoteCam = s.cam;
                if (typeof s.mic === 'boolean') remoteMic = s.mic;
                trace(`собеседник: камера ${remoteCam ? 'вкл' : 'выкл'}, микрофон ${remoteMic ? 'вкл' : 'выкл'}`);
                stopBlackProbe(); // канал работает — резерв больше не нужен
                paintRemoteState();
            } catch {}
        });
    }

    function paintRemoteState() {
        const show = !!pc && !remoteCam;

        el.camOff.hidden = !show;
        el.camOff.dataset.silent = String(!remoteMic);
        el.camOffSub.textContent = remoteMic ? 'слышно' : 'микрофон тоже выключен';

        if (show) startViz();
        else stopViz();
    }

    /* Резерв на случай, если канал состояния не открылся: раз в секунду
       семплим крошечный кадр из чужого видео и смотрим яркость. Чёрный кадр
       несколько раз подряд = камера выключена. Дёшево (192 пикселя) и работает
       всегда, независимо от data channel. */
    let probeTimer = 0, darkStreak = 0, probeCvs = null;

    function startBlackProbe() {
        if (probeTimer) return;
        probeCvs = document.createElement('canvas');
        probeCvs.width = 16;
        probeCvs.height = 12;
        const pctx = probeCvs.getContext('2d', { willReadFrequently: true });

        probeTimer = setInterval(() => {
            const v = el.remote;
            if (!v.videoWidth || v.readyState < 2) return;
            try {
                pctx.drawImage(v, 0, 0, 16, 12);
                const d = pctx.getImageData(0, 0, 16, 12).data;
                let sum = 0;
                for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
                const bright = sum / (d.length / 4) / 3;

                const dark = bright < 8;
                darkStreak = dark ? darkStreak + 1 : 0;

                const guess = darkStreak >= 2;
                if (guess !== !remoteCam) {
                    remoteCam = !guess;
                    trace('камера собеседника ' + (guess ? 'выключена' : 'включена') + ' (по кадру)');
                    paintRemoteState();
                }
            } catch {}
        }, 1000);
    }

    function stopBlackProbe() {
        clearInterval(probeTimer);
        probeTimer = 0;
        darkStreak = 0;
    }

    /* ---------- волны по голосу собеседника ---------- */

    function startViz() {
        if (vizRaf) return;

        const stream = el.remote.srcObject;
        const track = stream && stream.getAudioTracks()[0];

        if (track && !vizAnalyser) {
            try {
                if (!vizCtx) vizCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (vizCtx.state === 'suspended') vizCtx.resume();
                const src = vizCtx.createMediaStreamSource(new MediaStream([track]));
                vizAnalyser = vizCtx.createAnalyser();
                vizAnalyser.fftSize = 512;
                vizAnalyser.smoothingTimeConstant = 0.8;
                src.connect(vizAnalyser); // к destination не подключаем — звук идёт через <video>
            } catch (e) {
                trace('визуализация звука недоступна: ' + e.message, 'warn');
            }
        }

        const cvs = el.camOffWave;
        const ctx = cvs.getContext('2d');
        const buf = vizAnalyser ? new Uint8Array(vizAnalyser.frequencyBinCount) : null;
        const LINES = 7;
        const start = performance.now();

        const fit = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            cvs.width = cvs.clientWidth * dpr;
            cvs.height = cvs.clientHeight * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        fit();
        window.addEventListener('resize', fit);
        cvs._fit = fit;

        const loop = (now) => {
            const w = cvs.clientWidth, h = cvs.clientHeight;
            const t = (now - start) / 1000;

            // Громкость: берём нижнюю треть спектра — там речь.
            let target = 0;
            if (buf && vizAnalyser && remoteMic) {
                vizAnalyser.getByteFrequencyData(buf);
                const n = Math.floor(buf.length * 0.35);
                let sum = 0;
                for (let i = 0; i < n; i++) sum += buf[i];
                target = Math.min(1, (sum / n / 255) * 3.2);
            }
            // Инерция, чтобы волна дышала, а не дёргалась покадрово.
            vizLevel += (target - vizLevel) * 0.12;

            const idle = 0.10;                      // волна живёт даже в тишине
            const amp = (idle + vizLevel * 0.9) * h * 0.3;

            ctx.clearRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'lighter';
            ctx.lineWidth = 1.15;

            for (let k = 0; k < LINES; k++) {
                const p = k / (LINES - 1);            // 0..1 по пучку линий
                const hue = 188 + p * 78;             // бирюза → фиолет
                const alpha = 0.5 - Math.abs(p - 0.5) * 0.45;

                ctx.beginPath();
                for (let x = 0; x <= w; x += 3) {
                    const u = x / w;
                    const env = Math.pow(Math.sin(Math.PI * u), 1.6);  // затухание к краям
                    const y = h / 2
                        + Math.sin(u * 7.5 + t * 1.5 + k * 0.5) * amp * env
                        + Math.sin(u * 3.1 - t * 0.9 + k * 1.1) * amp * env * 0.45
                        + (p - 0.5) * amp * env * 0.55;
                    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                }
                ctx.strokeStyle = remoteMic
                    ? `hsla(${hue}, 85%, 62%, ${alpha})`
                    : `hsla(215, 18%, 52%, ${alpha * 0.5})`;
                ctx.shadowBlur = remoteMic ? 14 : 0;
                ctx.shadowColor = `hsla(${hue}, 90%, 60%, .5)`;
                ctx.stroke();
            }

            ctx.globalCompositeOperation = 'source-over';
            ctx.shadowBlur = 0;
            vizRaf = requestAnimationFrame(loop);
        };
        vizRaf = requestAnimationFrame(loop);
    }

    function stopViz() {
        cancelAnimationFrame(vizRaf);
        vizRaf = 0;
        const cvs = el.camOffWave;
        if (cvs && cvs._fit) { window.removeEventListener('resize', cvs._fit); cvs._fit = null; }
    }

    /* ---------- вывод ---------- */

    function trace(text, kind) {
        const p = document.createElement('p');
        if (kind) p.dataset.kind = kind;
        const t = document.createElement('time');
        t.textContent = new Date().toLocaleTimeString('ru-RU', { hour12: false }) ;
        const s = document.createElement('span');
        s.textContent = text;
        p.append(t, s);
        el.traceLog.append(p);
        el.traceLog.scrollTop = el.traceLog.scrollHeight;
        while (el.traceLog.children.length > 300) el.traceLog.firstChild.remove();
    }

    let bannerTimer = 0;
    function banner(text, ms = 4000) {
        el.banner.textContent = text;
        el.banner.dataset.show = 'true';
        clearTimeout(bannerTimer);
        if (ms) bannerTimer = setTimeout(() => { el.banner.dataset.show = 'false'; }, ms);
    }

    function setRoute(state, label) {
        el.stateDot.dataset.route = state;
        el.route.textContent = label;
    }

    /* ---------- подготовка ---------- */

    function readPrefs() {
        try {
            return Object.assign({ camOn: true, micOn: true, camId: null, micId: null },
                JSON.parse(sessionStorage.getItem('oto.prefs') || '{}'));
        } catch { return { camOn: true, micOn: true, camId: null, micId: null }; }
    }

    el.roomName.textContent = roomId;
    el.roomLink.textContent = location.href;
    document.title = roomId + ' — OTO';

    async function loadIce() {
        try {
            const r = await fetch('/api/ice', { cache: 'no-store' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const data = await r.json();
            if (Array.isArray(data.iceServers) && data.iceServers.length) {
                iceServers = data.iceServers;
                const hasTurn = iceServers.some((s) => String(s.urls).includes('turn:'));
                trace(hasTurn ? 'ICE-серверы получены: STUN + TURN' : 'ICE-серверы получены: только STUN', 'ok');
                if (!hasTurn) trace('без TURN соединение соберётся не во всех сетях', 'warn');
                return;
            }
            throw new Error('пустой список');
        } catch (e) {
            trace('/api/ice недоступен (' + e.message + '), берём публичный STUN', 'warn');
        }
    }

    async function openMedia() {
        const video = prefs.camOn ? {
            width:     { ideal: 1280 },
            height:    { ideal: 720 },
            frameRate: { ideal: 30 },
            ...(prefs.camId ? { deviceId: { ideal: prefs.camId } } : {}),
        } : false;

        const audio = prefs.micOn ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl:  true,
            ...(prefs.micId ? { deviceId: { ideal: prefs.micId } } : {}),
        } : false;

        const constraints = { video, audio };
        if (!video && !audio) constraints.audio = true;

        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            el.local.srcObject = localStream;
            const vt = localStream.getVideoTracks()[0];
            if (vt) {
                const s = vt.getSettings();
                trace(`камера: ${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)}fps`, 'ok');
            } else {
                trace('микрофон получен', 'ok');
            }
        } catch (err) {
            trace('нет доступа к устройствам: ' + err.name, 'err');
            banner('Браузер не дал доступ к камере или микрофону. Разреши доступ и обнови страницу.', 0);
            localStream = new MediaStream();     // всё равно входим — сможем видеть и слышать второго
        }

        applyTrackState('audio', prefs.micOn, el.micBtn);
        applyTrackState('video', prefs.camOn, el.camBtn);
    }

    function applyTrackState(kind, on, btn) {
        const tracks = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
        tracks.forEach((t) => { t.enabled = on; });
        btn.setAttribute('aria-pressed', String(on && tracks.length > 0));
        if (kind === 'video') el.selfTile.dataset.cam = (on && tracks.length) ? 'on' : 'off';
    }

    /* ---------- сигналинг ---------- */

    function send(type, payload) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(payload === undefined ? { type } : { type, payload }));
    }

    function connect() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${proto}//${location.host}/ws`);

        ws.addEventListener('open', () => {
            retry = 0;
            trace('вебсокет открыт');
            send('join', { room: roomId });
        });

        ws.addEventListener('message', (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            handle(msg);
        });

        ws.addEventListener('close', () => {
            trace('вебсокет закрыт', leaving ? null : 'warn');
            if (leaving) return;
            teardownPeer();
            showWaiting(true);
            scheduleReconnect();
        });

        ws.addEventListener('error', () => trace('ошибка вебсокета', 'err'));
    }

    function scheduleReconnect() {
        // Экспоненциальная задержка с джиттером: 0.5с, 1с, 2с … максимум 15с.
        const delay = Math.min(15000, 500 * 2 ** retry) * (0.75 + Math.random() * 0.5);
        retry++;
        setRoute('down', 'связь потеряна');
        banner(`Связь с сервером потеряна. Переподключаемся через ${(delay / 1000).toFixed(0)} с.`, delay);
        trace(`переподключение через ${Math.round(delay)} мс (попытка ${retry})`, 'warn');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, delay);
    }

    async function handle(msg) {
        switch (msg.type) {
            case 'joined':
                initiator = !!(msg.initiator ?? msg.payload?.initiator);
                trace(`вошли в комнату, роль: ${initiator ? 'инициатор' : 'ожидающий'}`, 'ok');
                setRoute('none', initiator ? 'начинаем переговоры' : 'ждём второго');
                if (initiator) { peerPresent = true; showWaiting(false); await makeOffer(); }
                break;

            case 'peer-joined':
                trace('второй участник вошёл');
                peerPresent = true;
                showWaiting(false);
                setRoute('none', 'ждём offer');
                break;

            case 'offer':
                trace('получен offer');
                await ensurePeer();
                await pc.setRemoteDescription(payloadOf(msg));
                await flushIce();
                await pc.setLocalDescription(await pc.createAnswer());
                send('answer', pc.localDescription);
                trace('отправлен answer');
                break;

            case 'answer':
                trace('получен answer');
                if (!pc) break;
                await pc.setRemoteDescription(payloadOf(msg));
                await flushIce();
                break;

            case 'ice': {
                const cand = payloadOf(msg);
                if (!cand) break;
                if (pc && pc.remoteDescription) {
                    try { await pc.addIceCandidate(cand); }
                    catch (e) { trace('кандидат отклонён: ' + e.message, 'warn'); }
                } else {
                    pendingIce.push(cand);   // рано — придержим до setRemoteDescription
                }
                break;
            }

            case 'peer-left':
            case 'bye':
                trace('второй участник вышел', 'warn');
                peerPresent = false;
                teardownPeer();
                showWaiting(true);
                setRoute('none', 'ждём второго');
                break;

            case 'error':
                trace('сервер: ' + (msg.message || msg.payload?.message || 'ошибка'), 'err');
                banner(serverError(msg.message || msg.payload?.message), 0);
                leaving = true;
                break;

            case 'ping':
                send('pong');
                break;
        }
    }

    function payloadOf(msg) {
        return msg.payload !== undefined ? msg.payload : msg.data;
    }

    function serverError(code) {
        if (code === 'room-full') return 'В комнате уже двое. Третьего она не пускает — попроси свободную ссылку.';
        if (code === 'bad-room') return 'Название комнаты не подходит: только латиница, цифры и дефис.';
        return 'Сервер отклонил вход: ' + (code || 'неизвестная причина');
    }

    async function flushIce() {
        const queued = pendingIce;
        pendingIce = [];
        if (queued.length) trace(`применяем ${queued.length} отложенных кандидатов`);
        for (const c of queued) {
            try { await pc.addIceCandidate(c); } catch (e) { trace('кандидат отклонён: ' + e.message, 'warn'); }
        }
    }

    /* ---------- WebRTC ---------- */

    async function ensurePeer() {
        if (pc) return pc;

        pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 2 });
        trace('создано соединение');

        // Канал состояния: инициатор создаёт, второй принимает через ondatachannel.
        // Создаём ДО createOffer, иначе он не попадёт в SDP.
        if (initiator) wireMeta(pc.createDataChannel('meta'));
        pc.addEventListener('datachannel', (e) => {
            if (e.channel.label === 'meta') wireMeta(e.channel);
        });

        localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
        tuneBitrate();

        pc.addEventListener('track', (e) => {
            el.remote.srcObject = e.streams[0];
            trace('пришёл поток: ' + e.track.kind, 'ok');
            showWaiting(false);
            if (e.track.kind === 'video') startBlackProbe();
        });

        pc.addEventListener('icecandidate', (e) => {
            if (e.candidate) send('ice', e.candidate);
            else trace('сбор кандидатов закончен');
        });

        pc.addEventListener('iceconnectionstatechange', () => {
            trace('ICE: ' + pc.iceConnectionState,
                pc.iceConnectionState === 'failed' ? 'err' : null);
            if (pc.iceConnectionState === 'failed') {
                trace('перезапускаем ICE', 'warn');
                pc.restartIce();
                if (initiator) makeOffer({ iceRestart: true });
            }
        });

        pc.addEventListener('connectionstatechange', () => {
            const s = pc.connectionState;
            trace('соединение: ' + s, s === 'connected' ? 'ok' : s === 'failed' ? 'err' : null);
            if (s === 'connected') { startClock(); startStats(); }
            if (s === 'failed') setRoute('down', 'не собралось');
            if (s === 'disconnected') setRoute('down', 'связь прерывается');
            paintRemoteState();
        });

        pc.addEventListener('negotiationneeded', () => {
            if (initiator && peerPresent) makeOffer();
        });

        return pc;
    }

    /* Дефолтный потолок битрейта у WebRTC консервативный. Поднимаем его —
       это именно потолок, а не обязательство: при плохой сети браузер всё
       равно снизит качество сам. Плюс просим сохранять чёткость в ущерб
       плавности: на занятии важнее читать код на экране, чем гладкое движение. */
    async function tuneBitrate() {
        if (!pc) return;
        for (const sender of pc.getSenders()) {
            if (!sender.track) continue;
            try {
                const params = sender.getParameters();
                if (!params.encodings || !params.encodings.length) params.encodings = [{}];

                if (sender.track.kind === 'video') {
                    params.encodings[0].maxBitrate = 2_500_000;   // 2.5 Мбит/с
                    params.degradationPreference = 'maintain-resolution';
                } else {
                    params.encodings[0].maxBitrate = 64_000;      // 64 кбит/с, с запасом для Opus
                }

                await sender.setParameters(params);
            } catch (e) {
                trace('не удалось настроить битрейт: ' + e.message, 'warn');
            }
        }
    }

    async function makeOffer(options) {
        await ensurePeer();
        try {
            await pc.setLocalDescription(await pc.createOffer(options));
            send('offer', pc.localDescription);
            trace('отправлен offer');
        } catch (e) {
            trace('не удалось создать offer: ' + e.message, 'err');
        }
    }

    function teardownPeer() {
        stopStats();
        stopClock();
        pendingIce = [];
        remoteCam = true;
        remoteMic = true;
        meta = null;
        vizAnalyser = null;
        stopViz();
        stopBlackProbe();
        el.camOff.hidden = true;
        if (pc) {
            pc.getSenders().forEach((s) => { try { s.track && s.track.stop && 0; } catch {} });
            pc.close();
            pc = null;
            trace('соединение закрыто');
        }
        el.remote.srcObject = null;
    }

    /* ---------- какой маршрут выбрало ICE ---------- */

    function startStats() {
        stopStats();
        statsTimer = setInterval(async () => {
            if (!pc) return;
            try {
                const stats = await pc.getStats();
                let pair = null;
                stats.forEach((r) => {
                    if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
                });
                if (!pair) return;
                const local = stats.get(pair.localCandidateId);
                const remote = stats.get(pair.remoteCandidateId);
                const relayed = (local && local.candidateType === 'relay') ||
                    (remote && remote.candidateType === 'relay');

                // Реальное входящее качество — полезно, когда картинка выглядит мыльной.
                let quality = '';
                stats.forEach((r) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameWidth) {
                        quality = ` · ${r.frameWidth}×${r.frameHeight}`;
                    }
                });

                if (relayed) setRoute('relay', 'через TURN' + quality);
                else if (local && local.candidateType === 'host') setRoute('direct', 'локальная сеть' + quality);
                else setRoute('direct', 'напрямую' + quality);
            } catch {}
        }, 3000);
    }

    function stopStats() { clearInterval(statsTimer); statsTimer = 0; }

    /* ---------- таймер занятия ---------- */

    function startClock() {
        if (clockTimer) return;
        startedAt = Date.now();
        clockTimer = setInterval(() => {
            const s = Math.floor((Date.now() - startedAt) / 1000);
            const mm = String(Math.floor(s / 60)).padStart(2, '0');
            const ss = String(s % 60).padStart(2, '0');
            el.timer.textContent = `${mm}:${ss}`;
        }, 1000);
    }

    function stopClock() { clearInterval(clockTimer); clockTimer = 0; }

    function showWaiting(on) { el.waiting.hidden = !on; }

    /* ---------- управление ---------- */

    el.micBtn.addEventListener('click', () => {
        const on = el.micBtn.getAttribute('aria-pressed') !== 'true';
        applyTrackState('audio', on, el.micBtn);
        trace('микрофон ' + (on ? 'включён' : 'выключен'));
        sendMediaState();
    });

    el.camBtn.addEventListener('click', () => {
        const on = el.camBtn.getAttribute('aria-pressed') !== 'true';
        applyTrackState('video', on, el.camBtn);
        trace('камера ' + (on ? 'включена' : 'выключена'));
        sendMediaState();
    });

    el.hangBtn.addEventListener('click', leave);

    function leave() {
        leaving = true;
        send('bye');
        teardownPeer();
        if (localStream) localStream.getTracks().forEach((t) => t.stop());
        if (ws) ws.close();
        location.href = 'index.html?room=' + encodeURIComponent(roomId);
    }

    window.addEventListener('pagehide', () => {
        if (!leaving) { leaving = true; send('bye'); }
    });

    el.copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(location.href);
            el.copyBtn.textContent = 'Ссылка скопирована';
            setTimeout(() => { el.copyBtn.textContent = 'Скопировать ссылку'; }, 2000);
        } catch {
            banner('Скопировать не получилось — выдели адрес в строке браузера вручную.');
        }
    });

    const toggleTrace = (open) => {
        el.tracePanel.dataset.open = String(open);
        el.traceBtn.setAttribute('aria-expanded', String(open));
    };
    el.traceBtn.addEventListener('click', () => toggleTrace(el.tracePanel.dataset.open !== 'true'));
    el.traceClose.addEventListener('click', () => toggleTrace(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleTrace(false); });

    /* ---------- старт ---------- */

    (async () => {
        trace('комната: ' + roomId);
        if (!window.isSecureContext) {
            trace('страница открыта не по HTTPS — камеры не будет', 'err');
            banner('Камера включается только по HTTPS или на localhost.', 0);
        }
        await loadIce();
        await openMedia();
        connect();
    })();
})();