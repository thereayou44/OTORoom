/* Lessonroom — клиент комнаты.
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
                JSON.parse(sessionStorage.getItem('lessonroom.prefs') || '{}'));
        } catch { return { camOn: true, micOn: true, camId: null, micId: null }; }
    }

    el.roomName.textContent = roomId;
    el.roomLink.textContent = location.href;
    document.title = roomId + ' — Lessonroom';

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
        const constraints = {
            video: prefs.camOn ? (prefs.camId ? { deviceId: { ideal: prefs.camId } } : true) : false,
            audio: prefs.micOn ? (prefs.micId ? { deviceId: { ideal: prefs.micId } } : true) : false,
        };
        if (!constraints.video && !constraints.audio) constraints.audio = true;

        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            el.local.srcObject = localStream;
            trace('камера и микрофон получены', 'ok');
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

        localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

        pc.addEventListener('track', (e) => {
            el.remote.srcObject = e.streams[0];
            trace('пришёл поток: ' + e.track.kind, 'ok');
            showWaiting(false);
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
        });

        pc.addEventListener('negotiationneeded', () => {
            if (initiator && peerPresent) makeOffer();
        });

        return pc;
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
                if (relayed) setRoute('relay', 'через TURN');
                else if (local && local.candidateType === 'host') setRoute('direct', 'напрямую, локальная сеть');
                else setRoute('direct', 'напрямую');
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
    });

    el.camBtn.addEventListener('click', () => {
        const on = el.camBtn.getAttribute('aria-pressed') !== 'true';
        applyTrackState('video', on, el.camBtn);
        trace('камера ' + (on ? 'включена' : 'выключена'));
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