(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const el = {
        stage: $('stage'),
        remote: $('remote'), local: $('local'), localScreen: $('localScreen'),
        tileRemote: $('tileRemote'), tileSelf: $('tileSelf'), tileScreen: $('tileScreen'),
        camOff: $('camOff'), camOffSub: $('camOffSub'), camOffWave: $('camOffWave'),
        sharingTag: $('sharingTag'),
        waiting: $('waiting'), roomName: $('roomName'), roomLink: $('roomLink'),
        copyBtn: $('copyBtn'), timer: $('timer'), route: $('route'),
        stateDot: $('stateDot'), micBtn: $('micBtn'), camBtn: $('camBtn'),
        hangBtn: $('hangBtn'),
        menuBtn: $('menuBtn'), menuPop: $('menuPop'), menuDot: $('menuDot'),
        miScreen: $('miScreen'), miScreenNote: $('miScreenNote'),
        miChat: $('miChat'), miChatBadge: $('miChatBadge'),
        miTrace: $('miTrace'),
        chatPanel: $('chatPanel'), chatClose: $('chatClose'), chatLog: $('chatLog'),
        chatForm: $('chatForm'), chatInput: $('chatInput'),
        tracePanel: $('tracePanel'), traceClose: $('traceClose'), traceLog: $('traceLog'),
        banner: $('banner'),
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
    let pendingIce = [];
    let peerPresent = false;
    let leaving = false;

    let retry = 0, retryTimer = 0;
    let statsTimer = 0, clockTimer = 0, startedAt = 0;

    let remoteCam = true, remoteMic = true, remoteScreen = false;
    let screenStream = null;

    function currentVideoTrack() {
        if (screenStream) return screenStream.getVideoTracks()[0] || null;
        return localStream ? (localStream.getVideoTracks()[0] || null) : null;
    }

    async function syncSenders() {
        if (!pc) return;
        const audio = localStream ? (localStream.getAudioTracks()[0] || null) : null;
        const video = currentVideoTrack();

        for (const t of pc.getTransceivers()) {
            const kind = t.receiver.track && t.receiver.track.kind;
            try {

                if (t.direction === 'recvonly') t.direction = 'sendrecv';
                if (kind === 'audio') await t.sender.replaceTrack(audio);
                else if (kind === 'video') await t.sender.replaceTrack(video);
            } catch (e) {
                trace('не удалось подставить трек: ' + e.message, 'warn');
            }
        }
    }

    async function startScreen() {
        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({

                video: { frameRate: { ideal: 10, max: 15 } },
                audio: false,
            });
        } catch (e) {

            if (e.name !== 'NotAllowedError') trace('не удалось начать показ: ' + e.name, 'warn');
            return;
        }

        screenStream = stream;
        const track = stream.getVideoTracks()[0];
        el.localScreen.srcObject = stream;

        track.addEventListener('ended', () => stopScreen());

        await syncSenders();

        setMenuItem(el.miScreen, true);
        el.miScreenNote.textContent = 'идёт показ — нажми, чтобы остановить';
        applyLayout();
        tuneBitrate();
        sendMediaState();
        refreshMenuDot();

        const s = track.getSettings();
        trace(`показ экрана: ${s.width}×${s.height}`, 'ok');
    }

    async function stopScreen() {
        if (!screenStream) return;

        screenStream.getTracks().forEach((t) => t.stop());
        screenStream = null;
        el.localScreen.srcObject = null;

        await syncSenders();

        setMenuItem(el.miScreen, false);
        el.miScreenNote.textContent = 'весь экран, окно или вкладка';
        applyLayout();
        tuneBitrate();
        sendMediaState();
        refreshMenuDot();
        trace('показ экрана остановлен');
    }

    const isSharing = () => screenStream !== null;

    function applyLayout() {
        const mine = isSharing();
        const theirs = remoteScreen && !mine;

        if (mine) {
            el.stage.dataset.layout = 'split';
            el.tileScreen.hidden = false;
            el.tileScreen.className = 'tile tile--main';
            el.tileRemote.className = 'tile tile--railA';
            el.tileSelf.className = 'tile tile--self tile--railB';
        } else if (theirs) {
            el.stage.dataset.layout = 'split';
            el.tileScreen.hidden = true;
            el.tileRemote.className = 'tile tile--main';
            el.tileSelf.className = 'tile tile--self tile--railA';
        } else {
            el.stage.dataset.layout = 'solo';
            el.tileScreen.hidden = true;
            el.tileRemote.className = 'tile tile--main';
            el.tileSelf.className = 'tile tile--self';
        }

        el.sharingTag.hidden = !theirs;
    }

    function setMenuItem(item, on) {
        item.dataset.on = String(on);
    }

    function openMenu(open) {
        el.menuPop.hidden = !open;
        el.menuBtn.setAttribute('aria-expanded', String(open));
    }

    const menuOpen = () => !el.menuPop.hidden;

    function openPanel(which) {
        const chat = which === 'chat';
        const trace_ = which === 'trace';

        el.chatPanel.dataset.open = String(chat);
        el.tracePanel.dataset.open = String(trace_);
        setMenuItem(el.miChat, chat);
        setMenuItem(el.miTrace, trace_);

        if (chat) {
            el.miChatBadge.hidden = true;
            refreshMenuDot();
            el.chatInput.focus();
        }
    }

    const panelOpen = () =>
        el.chatPanel.dataset.open === 'true' || el.tracePanel.dataset.open === 'true';

    function refreshMenuDot() {
        el.menuDot.hidden = el.miChatBadge.hidden && !isSharing();
    }

    el.menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenu(!menuOpen());
    });

    el.miScreen.addEventListener('click', () => {
        openMenu(false);
        isSharing() ? stopScreen() : startScreen();
    });

    el.miChat.addEventListener('click', () => {
        openMenu(false);
        openPanel(el.chatPanel.dataset.open === 'true' ? null : 'chat');
    });

    el.miTrace.addEventListener('click', () => {
        openMenu(false);
        openPanel(el.tracePanel.dataset.open === 'true' ? null : 'trace');
    });

    el.chatClose.addEventListener('click', () => openPanel(null));
    el.traceClose.addEventListener('click', () => openPanel(null));

    document.addEventListener('click', (e) => {
        if (menuOpen() && !el.menuPop.contains(e.target)) openMenu(false);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (menuOpen()) openMenu(false);
        else if (panelOpen()) openPanel(null);
    });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        el.miScreen.hidden = true;
    }

    let chat = null;
    let chatEmpty = true;

    function wireChat(ch) {
        chat = ch;
        ch.addEventListener('open', () => trace('чат подключён', 'ok'));
        ch.addEventListener('message', (e) => {
            let text;
            try { text = JSON.parse(e.data).text; } catch { return; }
            if (typeof text !== 'string' || !text) return;
            addMessage(text, false);
            if (el.chatPanel.dataset.open !== 'true') {
                el.miChatBadge.hidden = false;
                refreshMenuDot();
            }
        });
    }

    function sendChat() {
        const text = el.chatInput.value.trim();
        if (!text) return;
        if (!chat || chat.readyState !== 'open') {
            banner('Чат заработает, когда соединение установится.');
            return;
        }
        try {
            chat.send(JSON.stringify({ text }));
            addMessage(text, true);
            el.chatInput.value = '';
            autoGrow();
        } catch (e) {
            banner('Не удалось отправить сообщение.');
        }
    }

    const URL_RE = /(https?:\/\/[^\s<>"]+)/g;

    function renderText(container, text) {
        let last = 0;
        text.replace(URL_RE, (url, _g, offset) => {
            if (offset > last) container.append(document.createTextNode(text.slice(last, offset)));
            const a = document.createElement('a');
            a.href = url;
            a.textContent = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            container.append(a);
            last = offset + url.length;
            return url;
        });
        if (last < text.length) container.append(document.createTextNode(text.slice(last)));
    }

    function addMessage(text, mine) {
        if (chatEmpty) {
            el.chatLog.innerHTML = '';
            chatEmpty = false;
        }

        const div = document.createElement('div');
        div.className = 'msg ' + (mine ? 'msg--mine' : 'msg--theirs');
        renderText(div, text);

        const time = document.createElement('span');
        time.className = 'msg__time';
        time.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        div.append(time);

        el.chatLog.append(div);
        el.chatLog.scrollTop = el.chatLog.scrollHeight;
    }

    function autoGrow() {
        el.chatInput.style.height = 'auto';
        el.chatInput.style.height = Math.min(el.chatInput.scrollHeight, 140) + 'px';
    }
    let meta = null;
    let vizCtx = null, vizAnalyser = null, vizRaf = 0, vizLevel = 0;

    function sendMediaState() {
        if (!meta || meta.readyState !== 'open') return;
        const cam = el.camBtn.getAttribute('aria-pressed') === 'true';
        const mic = el.micBtn.getAttribute('aria-pressed') === 'true';
        try { meta.send(JSON.stringify({ cam, mic, screen: isSharing() })); } catch {}
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
                remoteScreen = s.screen === true;
                trace(`собеседник: камера ${remoteCam ? 'вкл' : 'выкл'}, микрофон ${remoteMic ? 'вкл' : 'выкл'}` +
                    (remoteScreen ? ', показывает экран' : ''));
                stopBlackProbe();
                paintRemoteState();
            } catch {}
        });
    }

    function paintRemoteState() {

        const show = !!pc && !remoteCam && !remoteScreen;

        el.camOff.hidden = !show;
        el.camOff.dataset.silent = String(!remoteMic);
        el.camOffSub.textContent = remoteMic ? 'слышно' : 'микрофон выключен';

        applyLayout();

        if (show) startViz();
        else stopViz();
    }

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
                src.connect(vizAnalyser);
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

            let target = 0;
            if (buf && vizAnalyser && remoteMic) {
                vizAnalyser.getByteFrequencyData(buf);
                const n = Math.floor(buf.length * 0.35);
                let sum = 0;
                for (let i = 0; i < n; i++) sum += buf[i];
                target = Math.min(1, (sum / n / 255) * 3.2);
            }

            vizLevel += (target - vizLevel) * 0.12;

            const idle = 0.10;
            const amp = (idle + vizLevel * 0.9) * h * 0.3;

            ctx.clearRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'lighter';
            ctx.lineWidth = 1.15;

            for (let k = 0; k < LINES; k++) {
                const p = k / (LINES - 1);
                const hue = 188 + p * 78;
                const alpha = 0.5 - Math.abs(p - 0.5) * 0.45;

                ctx.beginPath();
                for (let x = 0; x <= w; x += 3) {
                    const u = x / w;
                    const env = Math.pow(Math.sin(Math.PI * u), 1.6);
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
            trace('нет доступа к камере: ' + err.name, 'err');

            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                el.local.srcObject = localStream;
                trace('микрофон получен, камеры нет', 'warn');
                banner('Камера недоступна — звонок пойдёт только со звуком. На Mac проверь: Настройки → Конфиденциальность → Камера.', 0);
            } catch (err2) {
                trace('нет доступа и к микрофону: ' + err2.name, 'err');
                banner('Браузер не дал доступ ни к камере, ни к микрофону. Разреши доступ и обнови страницу.', 0);
                localStream = new MediaStream();
            }
        }

        applyTrackState('audio', prefs.micOn, el.micBtn);
        applyTrackState('video', prefs.camOn, el.camBtn);
    }

    function applyTrackState(kind, on, btn) {
        const tracks = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
        tracks.forEach((t) => { t.enabled = on; });
        btn.setAttribute('aria-pressed', String(on && tracks.length > 0));
        if (kind === 'video') el.tileSelf.dataset.cam = (on && tracks.length) ? 'on' : 'off';
    }

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
                if (initiator) {
                    peerPresent = true;
                    showWaiting(false);

                    await ensurePeer();
                    await makeOffer();
                }
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

                await syncSenders();
                await flushIce();
                await pc.setLocalDescription();
                send('answer', pc.localDescription);
                tuneBitrate();
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
                    pendingIce.push(cand);
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

    async function ensurePeer() {
        if (pc) return pc;

        pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 2 });
        trace('создано соединение');

        if (initiator) {
            wireMeta(pc.createDataChannel('meta'));
            wireChat(pc.createDataChannel('chat'));
        }
        pc.addEventListener('datachannel', (e) => {
            if (e.channel.label === 'meta') wireMeta(e.channel);
            if (e.channel.label === 'chat') wireChat(e.channel);
        });

        if (initiator) {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
            pc.addTransceiver('video', { direction: 'sendrecv' });
            await syncSenders();
        }

        const remoteStream = new MediaStream();

        pc.addEventListener('track', (e) => {
            trace('пришёл поток: ' + e.track.kind, 'ok');
            showWaiting(false);
            if (e.track.kind === 'video') startBlackProbe();

            remoteStream.addTrack(e.track);

            if (el.remote.srcObject !== remoteStream) {
                el.remote.srcObject = remoteStream;
                el.remote.play().catch((err) => {
                    trace('автовоспроизведение заблокировано: ' + err.name, 'warn');
                    banner('Нажми в любое место экрана, чтобы включить видео и звук.');
                    const resume = () => { el.remote.play(); document.removeEventListener('click', resume); };
                    document.addEventListener('click', resume, { once: true });
                });
            }
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
            }
        });

        pc.addEventListener('connectionstatechange', () => {
            const s = pc.connectionState;
            trace('соединение: ' + s, s === 'connected' ? 'ok' : s === 'failed' ? 'err' : null);
            if (s === 'connected') { startClock(); startStats(); tuneBitrate(); }
            if (s === 'failed') setRoute('down', 'не собралось');
            if (s === 'disconnected') setRoute('down', 'связь прерывается');
            paintRemoteState();
        });

        pc.addEventListener('negotiationneeded', () => {
            if (initiator) makeOffer();
        });

        return pc;
    }

    async function tuneBitrate() {
        if (!pc) return;
        for (const sender of pc.getSenders()) {
            if (!sender.track) continue;
            try {
                const params = sender.getParameters();

                if (!params.encodings || !params.encodings.length) continue;

                if (sender.track.kind === 'video') {
                    if (isSharing()) {

                        params.encodings[0].maxBitrate = 3_000_000;
                        params.encodings[0].maxFramerate = 12;
                    } else {
                        params.encodings[0].maxBitrate = 2_500_000;
                        delete params.encodings[0].maxFramerate;
                    }
                    params.degradationPreference = 'maintain-resolution';
                } else {
                    params.encodings[0].maxBitrate = 64_000;
                }

                await sender.setParameters(params);
            } catch (e) {
                trace('не удалось настроить битрейт: ' + e.message, 'warn');
            }
        }
    }

    let makingOffer = false;

    async function makeOffer() {
        if (!pc || makingOffer) return;
        if (pc.signalingState !== 'stable') return;

        try {
            makingOffer = true;
            await pc.setLocalDescription();
            send('offer', pc.localDescription);
            trace('отправлен offer');
        } catch (e) {
            trace('не удалось создать offer: ' + e.message, 'err');
        } finally {
            makingOffer = false;
        }
    }

    function teardownPeer() {
        stopStats();
        stopClock();
        pendingIce = [];
        remoteCam = true;
        remoteMic = true;
        remoteScreen = false;
        meta = null;
        chat = null;
        applyLayout();
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

        if (!isSharing()) sendMediaState();
    });

    el.hangBtn.addEventListener('click', leave);

    function leave() {
        leaving = true;
        send('bye');
        teardownPeer();
        if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
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

    el.chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendChat();
    });

    el.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChat();
        }
    });

    el.chatInput.addEventListener('input', autoGrow);

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