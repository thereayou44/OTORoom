/* Громкость микрофона, привязанная к речи.
 *
 * Задача: голос должен звучать громко, а фон комнаты в паузах — не всплывать.
 * Браузерный autoGainControl этого не умеет: он поднимает усиление и в паузах,
 * вытаскивая наверх вентилятор и стул. Поэтому AGC выключен, а громкость
 * добираем здесь — но только тогда, когда человек действительно говорит.
 *
 * Тут нет ни нейросети, ни спектральной обработки: только одно общее усиление
 * на весь сигнал, плавно меняющееся во времени. Именно поэтому не может
 * появиться ни «роботизированности», ни выгрызенных окончаний слов — тембр
 * не трогаем вообще, меняем только громкость.
 *
 * Порядок: огибающая → ворота с гистерезисом и удержанием → усиление.
 * Ограничитель от перегруза ставится снаружи, обычным DynamicsCompressorNode.
 */

const MAKEUP = 3.5;         // +11 дБ на речи

/* Ворота. Открываются по громкости выше OPEN, закрываются ниже CLOSE —
   разные пороги, чтобы не дребезжали на границе. Закрытые ворота не глушат
   в ноль, а лишь приглушают: полная тишина в паузах звучит неестественно,
   будто связь пропала. */
const OPEN = 0.012;         // -38 дБFS: уверенно речь
const CLOSE = 0.006;        // -44 дБFS: уверенно фон
const DEPTH = 0.18;         // -15 дБ в паузах
const HOLD_MS = 260;        // держим открытыми после спада — на хвосты слов

/* Огибающая: быстро реагирует на начало звука, медленно отпускает,
   иначе усиление дёргается внутри фразы. */
const ENV_ATTACK_MS = 5;
const ENV_RELEASE_MS = 120;

/* Скорость самих ворот. Открываются быстро, чтобы не съесть начало слова;
   закрываются медленно, чтобы не обрубить конец. */
const GATE_ATTACK_MS = 8;
const GATE_RELEASE_MS = 220;

const coeff = (ms, rate) => Math.exp(-1000 / (ms * rate));

class MicGainProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.enabled = true;
        this.makeup = MAKEUP;

        this.env = 0;
        this.gate = DEPTH;      // текущее положение ворот
        this.open = false;
        this.holdLeft = 0;      // сколько сэмплов ещё держим открытыми

        const r = sampleRate;
        this.envAtt = coeff(ENV_ATTACK_MS, r);
        this.envRel = coeff(ENV_RELEASE_MS, r);
        this.gateAtt = coeff(GATE_ATTACK_MS, r);
        this.gateRel = coeff(GATE_RELEASE_MS, r);
        this.holdSamples = Math.round((HOLD_MS / 1000) * r);

        this.port.onmessage = (e) => {
            const d = e.data || {};
            if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
            if (typeof d.makeup === 'number' && d.makeup > 0) this.makeup = d.makeup;
        };
    }

    process(inputs, outputs) {
        const input = inputs[0] && inputs[0][0];
        const output = outputs[0] && outputs[0][0];
        if (!output) return true;
        if (!input) return true;               // микрофона ещё нет — тишина

        if (!this.enabled) { output.set(input); return true; }

        for (let i = 0; i < input.length; i++) {
            const x = input[i];
            const a = x < 0 ? -x : x;

            // Огибающая по модулю сигнала
            const c = a > this.env ? this.envAtt : this.envRel;
            this.env = a + (this.env - a) * c;

            // Состояние ворот с гистерезисом и удержанием
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

            output[i] = x * this.makeup * this.gate;
        }

        return true;
    }
}

registerProcessor('oto-mic-gain', MicGainProcessor);
