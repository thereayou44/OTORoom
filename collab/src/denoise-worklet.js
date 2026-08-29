// AudioWorklet-процессор шумодава на RNNoise (сборка Jitsi, wasm вшит в бандл).
//
// Зачем: браузерный noiseSuppression умеет только «закрывать ворота» в тишине —
// во время речи фоновый шум проходит вместе с голосом. RNNoise (нейросетевой
// шумодав) отделяет голос от шума и во время речи. Браузерный NS при этом
// выключается: шумодав в цепочке должен быть ровно один.
//
// Работает в AudioWorkletGlobalScope: ни window, ни document здесь нет.
// Пока wasm не готов (или не завёлся) — прозрачный пропуск звука без обработки,
// о состоянии сообщаем главному потоку через port ('ready' / 'error').

import { createRNNWasmModuleSync } from '@jitsi/rnnoise-wasm';

const FRAME = 480; // rnnoise принимает ровно 480 сэмплов (10 мс при 48 кГц)

class DenoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.ready = false;      // wasm инициализирован, можно обрабатывать
        this.enabled = true;     // выключатель с главного потока (на будущее)
        this.wasm = null;
        this.state = 0;          // указатель на DenoiseState внутри wasm
        this.heapPtr = 0;        // буфер на 480 float32 в памяти wasm

        // Вход копится до 480 сэмплов, обработанные кадры лежат в очереди
        // на выдачу. Задержка получается ровно один кадр — 10 мс.
        this.inBuf = new Float32Array(FRAME);
        this.inFill = 0;
        this.outQueue = [];
        this.outOffset = 0;

        this.port.onmessage = (e) => {
            if (e.data && typeof e.data.enabled === 'boolean') this.enabled = e.data.enabled;
        };

        try {
            const mod = createRNNWasmModuleSync();
            // Сборка синхронная, но на всякий случай поддерживаем и вариант,
            // когда экспорты появляются после resolve промиса ready.
            if (typeof mod._rnnoise_create === 'function') this._init(mod);
            else mod.ready.then((m) => this._init(m)).catch((err) => this._fail(err));
        } catch (err) {
            this._fail(err);
        }
    }

    _init(mod) {
        try {
            this.wasm = mod;
            this.state = mod._rnnoise_create(0);
            this.heapPtr = mod._malloc(FRAME * 4);
            if (!this.state || !this.heapPtr) throw new Error('rnnoise: не выделилась память');
            this.ready = true;
            this.port.postMessage({ type: 'ready' });
        } catch (err) {
            this._fail(err);
        }
    }

    _fail(err) {
        this.ready = false;
        this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
    }

    _processFrame() {
        // rnnoise работает с сэмплами в масштабе int16 — умножаем на входе,
        // делим на выходе. Обработка на месте: вход и выход — один буфер.
        const heap = this.wasm.HEAPF32;
        const base = this.heapPtr >> 2;
        for (let i = 0; i < FRAME; i++) heap[base + i] = this.inBuf[i] * 32768;
        this.wasm._rnnoise_process_frame(this.state, this.heapPtr, this.heapPtr);
        const out = new Float32Array(FRAME);
        for (let i = 0; i < FRAME; i++) out[i] = heap[base + i] / 32768;
        this.outQueue.push(out);
    }

    process(inputs, outputs) {
        const input = inputs[0] && inputs[0][0];
        const output = outputs[0] && outputs[0][0];
        if (!output) return true;

        if (!input) return true; // микрофон ещё не подключён — тишина

        if (!this.ready || !this.enabled) {
            output.set(input); // прозрачный режим: звук идёт как есть
            return true;
        }

        // Копим вход кадрами по 480
        let read = 0;
        while (read < input.length) {
            const n = Math.min(FRAME - this.inFill, input.length - read);
            this.inBuf.set(input.subarray(read, read + n), this.inFill);
            this.inFill += n;
            read += n;
            if (this.inFill === FRAME) {
                this._processFrame();
                this.inFill = 0;
            }
        }

        // Выдаём из очереди готовых кадров; пока её нет — тишина (первые 10 мс)
        let written = 0;
        while (written < output.length && this.outQueue.length) {
            const head = this.outQueue[0];
            const n = Math.min(head.length - this.outOffset, output.length - written);
            output.set(head.subarray(this.outOffset, this.outOffset + n), written);
            written += n;
            this.outOffset += n;
            if (this.outOffset === head.length) {
                this.outQueue.shift();
                this.outOffset = 0;
            }
        }

        return true;
    }
}

registerProcessor('oto-denoise', DenoiseProcessor);
