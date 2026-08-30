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
        tileEditor: $('tileEditor'), tileBoard: $('tileBoard'),
        editorHost: $('editorHost'), boardHost: $('boardHost'),
        editorLang: $('editorLang'), editorClose: $('editorClose'),
        boardClose: $('boardClose'), boardTools: $('boardTools'),
        boardColors: $('boardColors'), boardWidth: $('boardWidth'),
        boardUndo: $('boardUndo'), boardRedo: $('boardRedo'), boardClear: $('boardClear'),
        boardPrev: $('boardPrev'), boardNext: $('boardNext'),
        boardPage: $('boardPage'), boardAddPage: $('boardAddPage'),
        miBoard: $('miBoard'), miEditor: $('miEditor'),
        chatAttach: $('chatAttach'), chatAttachImg: $('chatAttachImg'), chatAttachX: $('chatAttachX'),
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

    let remoteCam = true, remoteMic = true, remoteScreen = false;
    let screenStream = null;

    // Совместная работа: collab живёт, пока жив data channel; редактор и
    // доска монтируются лениво при первом открытии панели.
    let collab = null, editor = null, board = null;
    let pane = null;

    /* ---------- демонстрация экрана ---------- */

    /* Что сейчас уходит в эфир по видео: экран важнее камеры. */
    function currentVideoTrack() {
        if (screenStream) return screenStream.getVideoTracks()[0] || null;
        return localStream ? (localStream.getVideoTracks()[0] || null) : null;
    }

    /* Что уходит в эфир по звуку: усиленный трек, если ступень громкости
       поднялась, иначе сырой микрофонный. */
    function currentAudioTrack() {
        if (boostedTrack && boostedTrack.readyState === 'live') return boostedTrack;
        return localStream ? (localStream.getAudioTracks()[0] || null) : null;
    }

    /* Проставляет актуальные треки в отправители. Отправители существуют
       всегда (см. ensurePeer), поэтому смена камера ↔ экран ↔ ничего
       не требует нового offer/answer. */
    async function syncSenders() {
        if (!pc) return;
        const audio = currentAudioTrack();
        const video = currentVideoTrack();

        for (const t of pc.getTransceivers()) {
            const kind = t.receiver.track && t.receiver.track.kind;
            try {
                /* У отвечающего трансиверы рождаются из чужого offer с направлением
                   recvonly — «только принимаю». replaceTrack прикрепляет трек, но
                   направление не меняет: answer уходит со словами «я только смотрю»,
                   и собеседник не получает ни звука, ни видео. Поднимаем явно. */
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
                // Экран с кодом: разрешение важно, плавность нет. 10 fps достаточно,
                // зато весь битрейт уходит на чёткость текста.
                video: { frameRate: { ideal: 10, max: 15 } },
                audio: false,
            });
        } catch (e) {
            // NotAllowedError здесь — это просто «пользователь закрыл диалог», не ошибка.
            if (e.name !== 'NotAllowedError') trace('не удалось начать показ: ' + e.name, 'warn');
            return;
        }

        screenStream = stream;
        const track = stream.getVideoTracks()[0];
        el.localScreen.srcObject = stream;

        // Пользователь может остановить показ системной кнопкой браузера,
        // минуя наш интерфейс — тогда трек завершится сам.
        track.addEventListener('ended', () => stopScreen());

        // Если соединения ещё нет — ничего страшного: трек подставится сам,
        // когда второй участник войдёт и соединение соберётся.
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

        await syncSenders();   // вернули камеру на место

        setMenuItem(el.miScreen, false);
        el.miScreenNote.textContent = 'весь экран, окно или вкладка';
        applyLayout();
        tuneBitrate();
        sendMediaState();
        refreshMenuDot();
        trace('показ экрана остановлен');
    }

    const isSharing = () => screenStream !== null;

    /* ---------- раскладка ---------- */

    /* Три состояния сцены:
         solo      — собеседник во весь экран, своя камера плиткой в углу;
         мой экран — экран справа, камера собеседника и своя колонкой слева;
         его экран — его экран справа, своя камера слева.
       Плитки не переезжают по DOM — им меняются классы grid-областей,
       иначе <video> дёргалось бы при каждом перемещении узла. */
    function applyLayout() {
        const mine = isSharing();
        const theirs = remoteScreen && !mine;
        const content = pane === 'editor' ? el.tileEditor : pane === 'board' ? el.tileBoard : null;

        el.tileScreen.hidden = !mine;
        el.tileEditor.hidden = pane !== 'editor';
        el.tileBoard.hidden = pane !== 'board';

        if (content) {
            // Редактор и доска важнее показа экрана: если открыты, занимают главное место.
            el.stage.dataset.layout = 'split';
            content.className = 'tile tile--main';
            el.tileRemote.className = 'tile tile--railA';
            el.tileSelf.className = 'tile tile--self tile--railB';
            if (mine) el.tileScreen.hidden = true;
        } else if (mine) {
            el.stage.dataset.layout = 'split';
            el.tileScreen.className = 'tile tile--main';
            el.tileRemote.className = 'tile tile--railA';
            el.tileSelf.className = 'tile tile--self tile--railB';
        } else if (theirs) {
            el.stage.dataset.layout = 'split';
            el.tileRemote.className = 'tile tile--main';
            el.tileSelf.className = 'tile tile--self tile--railA';
        } else {
            el.stage.dataset.layout = 'solo';
            el.tileRemote.className = 'tile tile--main';
            el.tileSelf.className = 'tile tile--self';
        }

        el.sharingTag.hidden = !theirs;
    }

    /* ---------- меню ---------- */

    function setMenuItem(item, on) {
        item.dataset.on = String(on);
    }

    function openMenu(open) {
        el.menuPop.hidden = !open;
        el.menuBtn.setAttribute('aria-expanded', String(open));
    }

    const menuOpen = () => !el.menuPop.hidden;

    /* Панели взаимоисключающие: открытие одной закрывает другую. */
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

    // Точка на кнопке меню: есть непрочитанное или что-то активно.
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

    el.miEditor.addEventListener('click', () => { openMenu(false); openPane('editor'); });
    el.miBoard.addEventListener('click', () => { openMenu(false); openPane('board'); });
    el.editorClose.addEventListener('click', () => openPane(null));
    el.boardClose.addEventListener('click', () => openPane(null));

    el.editorLang.addEventListener('change', () => {
        if (editor) editor.setLanguage(el.editorLang.value);
    });

    /* Подсветка активного инструмента. Зовётся и по клику, и самой доской —
       она переключается на «переместить» после вставки картинки. */
    function highlightTool(tool) {
        el.boardTools.querySelectorAll('.tool[data-tool]')
            .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    }

    el.boardTools.addEventListener('click', (e) => {
        const btn = e.target.closest('.tool[data-tool]');
        if (!btn || !board) return;
        highlightTool(btn.dataset.tool);
        board.setTool(btn.dataset.tool);
    });

    el.boardColors.addEventListener('click', (e) => {
        const btn = e.target.closest('.swatch');
        if (!btn || !board) return;
        el.boardColors.querySelectorAll('.swatch')
            .forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        board.setColor(btn.dataset.color);
    });

    el.boardWidth.addEventListener('input', () => {
        if (board) board.setWidth(Number(el.boardWidth.value));
    });

    /* Счётчик страниц. Зовётся и на свои действия, и когда листает
       собеседник — страница на доске общая. */
    function showPages(page, total) {
        el.boardPage.textContent = `${page + 1}/${total}`;
        el.boardPrev.disabled = page === 0;
        el.boardNext.disabled = page >= total - 1;
    }

    el.boardPrev.addEventListener('click', () => board && board.setPage(board.page() - 1));
    el.boardNext.addEventListener('click', () => board && board.setPage(board.page() + 1));
    el.boardAddPage.addEventListener('click', () => board && board.addPage());

    el.boardUndo.addEventListener('click', () => board && board.undo());
    el.boardRedo.addEventListener('click', () => board && board.redo());
    el.boardClear.addEventListener('click', () => {
        if (board && confirm('Очистить эту страницу у обоих участников?')) board.clear();
    });

    el.chatClose.addEventListener('click', () => openPanel(null));
    el.traceClose.addEventListener('click', () => openPanel(null));

    // Клик мимо меню закрывает его.
    document.addEventListener('click', (e) => {
        if (menuOpen() && !el.menuPop.contains(e.target)) openMenu(false);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (menuOpen()) openMenu(false);
        else if (panelOpen()) openPanel(null);
    });

    // На мобильных getDisplayMedia обычно нет — прячем пункт, а не показываем
    // неработающий.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        el.miScreen.hidden = true;
    }

    /* ---------- чат ---------- */

    let chat = null;
    let chatEmpty = true;

    function wireChat(ch) {
        chat = ch;
        ch.addEventListener('open', () => trace('чат подключён', 'ok'));
        ch.addEventListener('message', (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }

            if (typeof msg.img === 'string') { receiveImagePart(msg); return; }

            const text = msg.text;
            if (typeof text !== 'string' || !text) return;
            addMessage(text, false);
            noteUnread();
        });
    }

    function noteUnread() {
        if (el.chatPanel.dataset.open !== 'true') {
            el.miChatBadge.hidden = false;
            refreshMenuDot();
        }
    }

    /* ---------- картинки в чате ----------

       Картинка уходит по chat-каналу как base64, порезанный на куски по 16 КБ:
       канал надёжный и упорядоченный, поэтому сборка — просто конкатенация.
       Перед отправкой пережимаем в JPEG, как на доске: канал не для мегабайтов. */

    let imgRx = {};   // id -> { parts: [], got: 0, total }

    function receiveImagePart(msg) {
        const { img: id, seq, total, part } = msg;
        if (typeof part !== 'string' || !Number.isInteger(seq) || !Number.isInteger(total)
            || total < 1 || total > 100 || seq < 0 || seq >= total) return;

        const rx = imgRx[id] || (imgRx[id] = { parts: new Array(total), got: 0, total });
        if (rx.total !== total || rx.parts[seq] !== undefined) return;
        rx.parts[seq] = part;
        rx.got++;

        if (rx.got === rx.total) {
            delete imgRx[id];
            addImageMessage('data:image/jpeg;base64,' + rx.parts.join(''), false);
            noteUnread();
        }
    }

    /* Пережимает файл в JPEG-dataURL не длиннее ~1.2 млн символов (≈900 КБ). */
    async function compressChatImage(file) {
        const bmp = await createImageBitmap(file).catch(() => null);
        if (!bmp) return null;
        const encode = (maxSide, q) => {
            const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(bmp.width * k));
            c.height = Math.max(1, Math.round(bmp.height * k));
            const cx = c.getContext('2d');
            cx.fillStyle = '#fff';                    // JPEG не умеет прозрачность
            cx.fillRect(0, 0, c.width, c.height);
            cx.drawImage(bmp, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', q);
        };
        let url = encode(1280, 0.82);
        if (url.length > 1_200_000) url = encode(900, 0.7);
        bmp.close();
        return url.length > 1_200_000 ? null : url;
    }

    /* Картинка не улетает сразу по Ctrl+V: сначала висит превью у поля ввода,
       отправка — кнопкой (защита от случайной вставки не того). */
    let chatAttachUrl = null;

    function setChatAttach(url) {
        chatAttachUrl = url;
        el.chatAttachImg.src = url;
        el.chatAttach.hidden = false;
    }

    function clearChatAttach() {
        chatAttachUrl = null;
        el.chatAttachImg.src = '';
        el.chatAttach.hidden = true;
    }

    function sendImageData(url) {
        const b64 = url.slice(url.indexOf(',') + 1);
        const CHUNK = 16 * 1024;
        const total = Math.ceil(b64.length / CHUNK);
        const id = Math.random().toString(36).slice(2, 10);
        for (let i = 0; i < total; i++) {
            chat.send(JSON.stringify({ img: id, seq: i, total, part: b64.substr(i * CHUNK, CHUNK) }));
        }
    }

    function showLightbox(src) {
        const ov = document.createElement('div');
        ov.className = 'lightbox';
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        ov.append(img);
        ov.addEventListener('click', () => ov.remove());
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); }
        });
        document.body.append(ov);
    }

    function addImageMessage(src, mine) {
        if (chatEmpty) {
            el.chatLog.innerHTML = '';
            chatEmpty = false;
        }

        const div = document.createElement('div');
        div.className = 'msg ' + (mine ? 'msg--mine' : 'msg--theirs');

        const img = document.createElement('img');
        img.className = 'msg__img';
        img.src = src;
        img.alt = 'картинка';
        img.addEventListener('click', () => showLightbox(src));
        div.append(img);

        const time = document.createElement('span');
        time.className = 'msg__time';
        time.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        div.append(time);

        el.chatLog.append(div);
        el.chatLog.scrollTop = el.chatLog.scrollHeight;
    }

    /* ---------- редактор и доска ---------- */

    function wireCollab(ch) {
        if (!window.OTO) { trace('модуль совместной работы не загрузился', 'err'); return; }

        collab = window.OTO.createCollab(ch, {
            name: initiator ? 'Инициатор' : 'Участник',
            color: initiator ? '#6fc3f7' : '#f2b24c',
        });

        ch.addEventListener('open', () => trace('канал совместной работы открыт', 'ok'));
    }

    function openPane(which) {
        if (!collab && which) {
            banner('Редактор и доска заработают, когда подключится второй участник.');
            return;
        }

        if (pane === which) which = null;
        pane = which;

        el.tileEditor.hidden = which !== 'editor';
        el.tileBoard.hidden = which !== 'board';
        setMenuItem(el.miEditor, which === 'editor');
        setMenuItem(el.miBoard, which === 'board');

        if (which === 'editor' && !editor) {
            editor = collab.mountEditor(el.editorHost, el.editorLang.value);
        }
        if (which === 'board' && !board) {
            board = collab.mountBoard(el.boardHost, {
                onToolChange: highlightTool,
                onPagesChange: showPages,
            });
            board.setColor(el.boardColors.querySelector('[aria-pressed="true"]').dataset.color);
            board.setWidth(Number(el.boardWidth.value));
        }

        applyLayout();
        if (which === 'editor' && editor) setTimeout(() => editor.focus(), 50);
    }

    function sendChat() {
        const text = el.chatInput.value.trim();
        if (!text && !chatAttachUrl) return;
        if (!chat || chat.readyState !== 'open') {
            banner('Чат заработает, когда соединение установится.');
            return;
        }
        try {
            if (chatAttachUrl) {
                const url = chatAttachUrl;
                sendImageData(url);
                addImageMessage(url, true);
                clearChatAttach();
            }
            if (text) {
                chat.send(JSON.stringify({ text }));
                addMessage(text, true);
                el.chatInput.value = '';
                autoGrow();
            }
        } catch (e) {
            banner('Не удалось отправить сообщение.');
        }
    }

    const URL_RE = /(https?:\/\/[^\s<>"]+)/g;

    /* Текст собеседника вставляется ТОЛЬКО как текстовые узлы, ссылки
       собираются через createElement. Через innerHTML сюда приехал бы
       любой HTML, который он захочет — это XSS в чистом виде. */
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
                stopBlackProbe(); // канал работает — резерв больше не нужен
                paintRemoteState();
            } catch {}
        });
    }

    function paintRemoteState() {
        // Во время показа экрана заглушка «камера выключена» не нужна —
        // картинка есть, просто это не лицо.
        const show = !!pc && !remoteCam && !remoteScreen;

        el.camOff.hidden = !show;
        el.camOff.dataset.silent = String(!remoteMic);
        el.camOffSub.textContent = remoteMic ? 'слышно' : 'микрофон выключен';

        applyLayout();

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

    /* ---------- громкость микрофона ---------- */

    /* Браузерный AGC выключен (он поднимал фон в паузах), поэтому громкость
       добираем сами — но только на речи, см. mic-gain-worklet.js. За ступенью
       стоит штатный компрессор-ограничитель: усиление в 3.5 раза может
       загнать громкий возглас в перегруз, ограничитель это срежет. */
    let boostCtx = null, boostedTrack = null;

    function stopBoost() {
        boostedTrack = null;
        if (boostCtx) { boostCtx.close().catch(() => {}); boostCtx = null; }
    }

    async function startBoost(micTrack) {
        if (!micTrack || !(window.AudioWorkletNode && window.AudioContext)) return;
        try {
            boostCtx = new AudioContext({ sampleRate: 48000 });
            await boostCtx.audioWorklet.addModule('mic-gain-worklet.js');
            if (boostCtx.state !== 'running') await boostCtx.resume();
            if (boostCtx.state !== 'running') throw new Error('AudioContext не запустился');

            const src = boostCtx.createMediaStreamSource(new MediaStream([micTrack]));
            const gain = new AudioWorkletNode(boostCtx, 'oto-mic-gain', {
                numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            });

            const limiter = boostCtx.createDynamicsCompressor();
            limiter.threshold.value = -3;
            limiter.knee.value = 0;
            limiter.ratio.value = 20;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.25;

            const dst = boostCtx.createMediaStreamDestination();
            src.connect(gain).connect(limiter).connect(dst);

            boostedTrack = dst.stream.getAudioTracks()[0] || null;
            if (!boostedTrack) throw new Error('нет выходного трека');
            trace('громкость: усиление на речи включено', 'ok');
        } catch (e) {
            // Не вышло — идём с сырым микрофоном: тише, но рабочий звук.
            stopBoost();
            trace('усиление не подключилось (' + e.message + ') — микрофон как есть', 'warn');
        }
    }

    async function openMedia() {
        const video = prefs.camOn ? {
            width:     { ideal: 1280 },
            height:    { ideal: 720 },
            frameRate: { ideal: 30 },
            ...(prefs.camId ? { deviceId: { ideal: prefs.camId } } : {}),
        } : false;

        /* Обработка звука целиком браузерная. Свой шумодав на RNNoise тут был
           и убран: он давит фон сильнее, но заглатывает окончания слов и даёт
           роботизированный призвук.

           Автоусиление выключено намеренно: в паузах оно задирает усиление и
           вытаскивает фон комнаты наверх — шум «дышит». Ценой того, что голос
           тише, фон держится на месте и не всплывает между фразами. */
        const audio = prefs.micOn ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl:  false,
            channelCount: { ideal: 1 },
            sampleRate:   { ideal: 48000 },
            ...(prefs.micId ? { deviceId: { ideal: prefs.micId } } : {}),
        } : false;

        const constraints = { video, audio };
        if (!video && !audio) constraints.audio = true;

        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            el.local.srcObject = localStream;

            const at = localStream.getAudioTracks()[0];
            if (at && at.getSettings) {
                const s = at.getSettings();
                const on = [];
                if (s.echoCancellation) on.push('эхо');
                if (s.noiseSuppression) on.push('шум');
                if (s.autoGainControl) on.push('громкость');
                trace(`микрофон: обработка ${on.length ? on.join('+') : 'выключена'}`
                    + (s.channelCount === 1 ? ', моно' : ''), on.length ? 'ok' : 'warn');
            }
            if (at) await startBoost(at);
            const vt = localStream.getVideoTracks()[0];
            if (vt) {
                const s = vt.getSettings();
                trace(`камера: ${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)}fps`, 'ok');
            } else {
                trace('микрофон получен', 'ok');
            }
        } catch (err) {
            trace('нет доступа к камере: ' + err.name, 'err');

            // Камера не далась (частый случай на Mac: браузеру не разрешили её
            // в системных настройках) — прежде чем входить пустым, пробуем
            // получить хотя бы микрофон, чтобы звук всё-таки был.
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                el.local.srcObject = localStream;
                trace('микрофон получен, камеры нет', 'warn');
                await startBoost(localStream.getAudioTracks()[0] || null);
                banner('Камера недоступна — звонок пойдёт только со звуком. На Mac проверь: Настройки → Конфиденциальность → Камера.', 0);
            } catch (err2) {
                trace('нет доступа и к микрофону: ' + err2.name, 'err');
                banner('Браузер не дал доступ ни к камере, ни к микрофону. Разреши доступ и обнови страницу.', 0);
                localStream = new MediaStream();   // всё равно входим — сможем видеть и слышать второго
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
                if (initiator) {
                    peerPresent = true;
                    showWaiting(false);
                    // ensurePeer заводит трансиверы, они порождают negotiationneeded,
                    // и offer уходит оттуда. Явный вызов — страховка на случай, если
                    // событие уже отработало вхолостую.
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
                // Трансиверы созданы описанием от инициатора — теперь есть куда
                // подставлять свои треки.
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

        // Три канала: meta возит состояние камеры и микрофона, chat — сообщения,
        // collab — синхронизацию редактора и доски (Yjs).
        // Инициатор создаёт все до createOffer, второй принимает по label.
        if (initiator) {
            wireMeta(pc.createDataChannel('meta'));
            wireChat(pc.createDataChannel('chat'));
            wireCollab(pc.createDataChannel('collab', { ordered: true }));
        }
        pc.addEventListener('datachannel', (e) => {
            if (e.channel.label === 'meta') wireMeta(e.channel);
            if (e.channel.label === 'chat') wireChat(e.channel);
            if (e.channel.label === 'collab') wireCollab(e.channel);
        });

        /* Трансиверы заводим явно, а не через addTrack. Разница принципиальная:
           addTrack создаёт отправителя только когда трек есть, а нам нужен
           отправитель ВСЕГДА — тогда включить камеру или начать показ экрана
           можно в любой момент простой подменой трека, без нового offer/answer.
           Инициатор создаёт их сам; отвечающему они появятся из offer. */
        if (initiator) {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
            pc.addTransceiver('video', { direction: 'sendrecv' });
            await syncSenders();
        }

        /* После перехода на addTransceiver треки не привязаны к MediaStream
           на стороне отправителя, и e.streams приходит ПУСТЫМ — полагаться на
           e.streams[0] нельзя (в srcObject уезжал undefined: чёрный экран и
           тишина при формально рабочем соединении). Собираем поток сами. */
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
                // restartIce сам поднимет negotiationneeded — новый offer уйдёт оттуда.
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
                // Пустой encodings означает «согласование ещё не дошло до этого
                // отправителя». Массив принадлежит браузеру, пересоздавать его
                // нельзя (Read-only field) — просто заходим позже, после connected.
                if (!params.encodings || !params.encodings.length) continue;

                if (sender.track.kind === 'video') {
                    if (isSharing()) {
                        // Экран: текст должен читаться, движения почти нет.
                        params.encodings[0].maxBitrate = 3_000_000;
                        params.encodings[0].maxFramerate = 12;
                    } else {
                        params.encodings[0].maxBitrate = 2_000_000;
                        delete params.encodings[0].maxFramerate;
                    }
                    params.degradationPreference = 'maintain-resolution';
                    params.encodings[0].priority = 'low';
                    params.encodings[0].networkPriority = 'low';
                } else {
                    // 96 кбит/с — верх осмысленного для моно-речи Opus;
                    // 48 давало слышимую экономию на качестве.
                    params.encodings[0].maxBitrate = 96_000;
                    params.encodings[0].priority = 'high';
                    params.encodings[0].networkPriority = 'high';
                }

                await sender.setParameters(params);
            } catch (e) {
                trace('не удалось настроить битрейт: ' + e.message, 'warn');
            }
        }
    }

    /* makeOffer может быть вызван из двух мест сразу: явно при входе в комнату
       и событием negotiationneeded от addTransceiver. Два параллельных
       createOffer расходятся по порядку m-line, и setLocalDescription падает
       с «order of m-lines doesn't match». Отсюда флаг и проверка состояния.

       setLocalDescription() без аргумента — современная форма: браузер сам
       собирает offer или answer по текущему состоянию, без разрыва между
       созданием описания и его применением. */
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
        imgRx = {};
        // Совместная работа живёт на data channel этого соединения — умирает с ним.
        if (collab) { collab.destroy(); collab = null; }
        editor = null;
        board = null;
        pane = null;
        el.tileEditor.hidden = true;
        el.tileBoard.hidden = true;
        setMenuItem(el.miEditor, false);
        setMenuItem(el.miBoard, false);
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

    /* ---------- какой маршрут выбрало ICE ---------- */

    let audioSeen = null, audioWarned = false;

    function checkAudioHealth(r) {
        if (audioSeen && r.timestamp > audioSeen.timestamp && !audioWarned) {
            const secs = (r.timestamp - audioSeen.timestamp) / 1000;
            const kbps = ((r.bytesReceived - audioSeen.bytesReceived) * 8) / secs / 1000;
            const lost = (r.packetsLost || 0) - (audioSeen.packetsLost || 0);
            const got  = (r.packetsReceived || 0) - (audioSeen.packetsReceived || 0);
            const lossPct = got > 0 ? (lost / (lost + got)) * 100 : 0;

            if (secs > 3) {
                if (kbps > 0 && kbps < 14) {
                    trace(`звук идёт на ${kbps.toFixed(0)} кбит/с — канал режет качество`, 'warn');
                    audioWarned = true;
                } else if (lossPct > 4) {
                    trace(`потери звука ${lossPct.toFixed(1)}% — отсюда искажения`, 'warn');
                    audioWarned = true;
                } else if (r.jitter > 0.05) {
                    trace(`неровная доставка звука (${(r.jitter * 1000).toFixed(0)} мс)`, 'warn');
                    audioWarned = true;
                }
            }
        }
        audioSeen = r;
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

                // Реальное входящее качество — полезно, когда картинка выглядит мыльной.
                let quality = '';
                stats.forEach((r) => {
                    if (r.type === 'inbound-rtp' && r.kind === 'audio') checkAudioHealth(r);
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
        // Во время показа экрана камера в эфир не идёт, но состояние запомнится
        // и применится, когда показ закончится.
        if (!isSharing()) sendMediaState();
    });

    el.hangBtn.addEventListener('click', leave);

    function leave() {
        leaving = true;
        send('bye');
        teardownPeer();
        stopBoost();
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

    // Enter отправляет, Shift+Enter переносит строку — как везде.
    el.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChat();
        }
    });

    el.chatInput.addEventListener('input', autoGrow);

    // Ctrl+V картинки в поле чата вешает её к отправке (уйдёт по кнопке).
    el.chatInput.addEventListener('paste', async (e) => {
        const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
        const file = items.find((i) => i.type.startsWith('image/'))?.getAsFile();
        if (!file) return;
        e.preventDefault();
        const url = await compressChatImage(file);
        if (!url) { banner('Картинка не влезла даже после сжатия.'); return; }
        setChatAttach(url);
    });

    el.chatAttachX.addEventListener('click', clearChatAttach);

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