(() => {
    const $ = (id) => document.getElementById(id);

    const el = {
        preview: $('preview'),
        video: $('previewVideo'),
        fallback: $('previewFallback'),
        meterFill: $('meterFill'),
        checkState: $('checkState'),
        camSelect: $('camSelect'),
        micSelect: $('micSelect'),
        camToggle: $('camToggle'),
        micToggle: $('micToggle'),
        room: $('room'),
        enter: $('enter'),
        notice: $('notice'),
    };

    let stream = null;
    let audioCtx = null, analyser = null, meterRaf = 0;
    let camOn = true, micOn = true;

    const ROOM_RE = /^[a-z0-9-]{2,32}$/;

    function notice(text) {
        el.notice.textContent = text;
        el.notice.hidden = !text;
    }

    /* getUserMedia живёт только в защищённом контексте. Это не лечится
       настройками — только https или localhost. Говорим об этом сразу,
       а не после того как пользователь нажал «войти». */
    if (!window.isSecureContext) {
        notice('Камера включается только по HTTPS или на localhost. Сейчас страница открыта по обычному http, доступа к устройствам не будет.');
    }

    /* Без явных constraints браузер выдаёт что-то вроде 640x480.
       ideal означает «дай столько, если можешь» — если камера не тянет,
       получим меньше, но getUserMedia не упадёт (в отличие от exact). */
    const VIDEO_WANT = {
        width:     { ideal: 1280 },
        height:    { ideal: 720 },
        frameRate: { ideal: 30 },
    };

    const AUDIO_WANT = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
    };

    function videoConstraints(deviceId) {
        const c = { ...VIDEO_WANT };
        if (deviceId) c.deviceId = { exact: deviceId };
        return c;
    }

    function audioConstraints(deviceId) {
        const c = { ...AUDIO_WANT };
        if (deviceId) c.deviceId = { exact: deviceId };
        return c;
    }

    async function openStream() {
        stopStream();

        const camId = el.camSelect.value;
        const micId = el.micSelect.value;

        const constraints = {
            video: camOn ? videoConstraints(camId) : false,
            audio: micOn ? audioConstraints(micId) : false,
        };

        if (!constraints.video && !constraints.audio) {
            el.preview.dataset.state = 'off';
            el.fallback.textContent = 'Камера и микрофон выключены';
            el.checkState.textContent = 'всё выключено';
            return;
        }

        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            el.video.srcObject = stream;
            el.preview.dataset.state = camOn ? 'live' : 'off';
            el.fallback.textContent = 'Камера выключена';

            // Показываем, что камера реально выдала — ideal не гарантирует запрошенное.
            const vt = stream.getVideoTracks()[0];
            if (camOn && vt) {
                const s = vt.getSettings();
                el.checkState.textContent = s.height ? `${s.width}×${s.height}` : 'видно и слышно';
            } else {
                el.checkState.textContent = camOn ? 'видно и слышно' : 'только звук';
            }

            notice('');
            await fillDevices();
            if (micOn) startMeter();
        } catch (err) {
            el.preview.dataset.state = 'error';
            el.checkState.textContent = 'нет доступа';
            if (err.name === 'NotAllowedError') {
                el.fallback.textContent = 'Доступ к камере запрещён';
                notice('Браузер заблокировал доступ. Открой значок замка в адресной строке, разреши камеру и микрофон, затем обнови страницу.');
            } else if (err.name === 'NotFoundError') {
                el.fallback.textContent = 'Устройство не найдено';
                notice('Браузер не нашёл камеру или микрофон. Проверь, что устройство подключено и не занято другой программой.');
            } else {
                el.fallback.textContent = 'Не удалось включить камеру';
                notice('Не удалось получить доступ к устройствам: ' + err.name + '. Часто причина — камера занята Zoom, Skype или другой вкладкой.');
            }
        }
    }

    function stopStream() {
        stopMeter();
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            stream = null;
        }
    }

    /* Метки устройств браузер отдаёт только после первого успешного
       getUserMedia — поэтому список наполняем уже после запроса доступа. */
    async function fillDevices() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        fill(el.camSelect, devices.filter((d) => d.kind === 'videoinput'), 'Камера');
        fill(el.micSelect, devices.filter((d) => d.kind === 'audioinput'), 'Микрофон');
    }

    function fill(select, list, word) {
        const current = select.value;
        select.innerHTML = '';
        if (!list.length) {
            select.append(new Option(word + ' не найден', ''));
            return;
        }
        list.forEach((d, i) => select.append(new Option(d.label || `${word} ${i + 1}`, d.deviceId)));
        const active = stream && stream.getTracks().find((t) => t.kind === (word === 'Камера' ? 'video' : 'audio'));
        const activeId = active && active.getSettings ? active.getSettings().deviceId : null;
        select.value = [...select.options].some((o) => o.value === current) ? current : (activeId || list[0].deviceId);
    }

    function startMeter() {
        const track = stream && stream.getAudioTracks()[0];
        if (!track) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);

        const buf = new Uint8Array(analyser.frequencyBinCount);
        const loop = () => {
            analyser.getByteTimeDomainData(buf);
            let peak = 0;
            for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
            const level = Math.min(100, (peak / 128) * 260);
            el.meterFill.style.width = level.toFixed(0) + '%';
            meterRaf = requestAnimationFrame(loop);
        };
        loop();
    }

    function stopMeter() {
        cancelAnimationFrame(meterRaf);
        if (audioCtx) { audioCtx.close(); audioCtx = null; }
        el.meterFill.style.width = '0%';
    }

    function go() {
        const name = el.room.value.trim().toLowerCase().replace(/\s+/g, '-');
        if (!ROOM_RE.test(name)) {
            notice('Название комнаты — от 2 до 32 символов: латиница, цифры и дефис. Например: algo-nikita.');
            el.room.focus();
            return;
        }
        sessionStorage.setItem('oto.prefs', JSON.stringify({
            camOn, micOn,
            camId: el.camSelect.value || null,
            micId: el.micSelect.value || null,
        }));
        stopStream();
        location.href = 'room.html?room=' + encodeURIComponent(name);
    }

    el.camToggle.addEventListener('click', () => {
        camOn = !camOn;
        el.camToggle.setAttribute('aria-pressed', String(camOn));
        openStream();
    });

    el.micToggle.addEventListener('click', () => {
        micOn = !micOn;
        el.micToggle.setAttribute('aria-pressed', String(micOn));
        openStream();
    });

    el.camSelect.addEventListener('change', openStream);
    el.micSelect.addEventListener('change', openStream);
    el.enter.addEventListener('click', go);
    el.room.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    el.room.addEventListener('input', () => notice(''));

    // Если пришли по ссылке вида index.html?room=xxx — подставляем название.
    const preset = new URLSearchParams(location.search).get('room');
    if (preset) el.room.value = preset.toLowerCase();

    if (window.isSecureContext) openStream();
    el.room.focus();
})();