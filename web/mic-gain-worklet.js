// Усиление только на речи: в паузах ворота прикрыты, и фон комнаты не всплывает.
// Ограничитель от перегруза стоит снаружи (DynamicsCompressorNode).

const MAKEUP = 4.0;         // +12 дБ, подобрано на слух

// Разные пороги открытия и закрытия — чтобы ворота не дребезжали на границе.
const OPEN = 0.012;         // -38 дБFS
const CLOSE = 0.006;        // -44 дБFS
const DEPTH = 0.18;         // -15 дБ в паузах: полная тишина звучит как обрыв связи
const HOLD_MS = 260;        // не обрубить хвост слова

const ENV_ATTACK_MS = 5;
const ENV_RELEASE_MS = 120;
const GATE_ATTACK_MS = 8;   // быстро — не съесть начало слова
const GATE_RELEASE_MS = 220;

const coeff = (ms, rate) => Math.exp(-1000 / (ms * rate));

class MicGainProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.enabled = true;

        this.env = 0;
        this.gate = DEPTH;
        this.open = false;
        this.holdLeft = 0;

        const r = sampleRate;
        this.envAtt = coeff(ENV_ATTACK_MS, r);
        this.envRel = coeff(ENV_RELEASE_MS, r);
        this.gateAtt = coeff(GATE_ATTACK_MS, r);
        this.gateRel = coeff(GATE_RELEASE_MS, r);
        this.holdSamples = Math.round((HOLD_MS / 1000) * r);

        this.port.onmessage = (e) => {
            if (e.data && typeof e.data.enabled === 'boolean') this.enabled = e.data.enabled;
        };
    }

    process(inputs, outputs) {
        const input = inputs[0] && inputs[0][0];
        const output = outputs[0] && outputs[0][0];
        if (!output) return true;
        if (!input) return true;

        if (!this.enabled) { output.set(input); return true; }

        for (let i = 0; i < input.length; i++) {
            const x = input[i];
            const a = x < 0 ? -x : x;

            const c = a > this.env ? this.envAtt : this.envRel;
            this.env = a + (this.env - a) * c;

            if (this.env > OPEN) {
                this.open = true;
                this.holdLeft = this.holdSamples;
            } else if (this.env < CLOSE) {
                if (this.holdLeft > 0) this.holdLeft--;
                else this.open = false;
            }

            const target = this.open ? 1 : DEPTH;
            const gc = target > this.gate ? this.gateAtt : this.gateRel;
            this.gate = target + (this.gate - target) * gc;

            output[i] = x * MAKEUP * this.gate;
        }

        return true;
    }
}

registerProcessor('oto-mic-gain', MicGainProcessor);
