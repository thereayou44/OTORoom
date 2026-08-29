// Смоук-тест шумодава: собранный dist/denoise-worklet.js загружается в
// эмулированный AudioWorkletGlobalScope, wasm инициализируется, кадры
// обрабатываются, шум действительно давится.
import { readFileSync } from 'fs';

let failed = 0;
const ok = (cond, name) => {
    console.log((cond ? '  OK   ' : '  ПРОВАЛ ') + name);
    if (!cond) failed++;
};

// --- минимальный AudioWorkletGlobalScope ---
const registered = {};
globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.registerProcessor = (name, cls) => { registered[name] = cls; };
globalThis.AudioWorkletProcessor = class {
    constructor() {
        this.port = {
            onmessage: null,
            _out: [],
            postMessage(m) { this._out.push(m); },
        };
    }
};

const code = readFileSync(new URL('../dist/denoise-worklet.js', import.meta.url), 'utf8');
(0, eval)(code);

ok(!!registered['oto-denoise'], 'процессор oto-denoise зарегистрирован');

const p = new registered['oto-denoise']();
// Сборка синхронная, но init мог уйти в mod.ready.then — дадим микротаскам дожить
await new Promise((r) => setTimeout(r, 200));

const msgs = p.port._out.map((m) => m.type);
ok(msgs.includes('ready'), `wasm готов (сообщения: ${JSON.stringify(p.port._out)})`);

// Гоняем 2 секунды белого шума кусками по 128 сэмплов
const BLOCK = 128;
let rmsIn = 0, rmsOut = 0, blocks = 0;
let seed = 42;
const rand = () => { // детерминированный шум
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x3fffffff) - 1;
};

for (let i = 0; i < Math.floor(2 * 48000 / BLOCK); i++) {
    const input = new Float32Array(BLOCK);
    for (let j = 0; j < BLOCK; j++) input[j] = rand() * 0.05; // тихий шум, как фон микрофона
    const output = new Float32Array(BLOCK);
    const alive = p.process([[input]], [[output]]);
    if (!alive) { ok(false, 'process вернул false'); break; }
    if (i >= 20) { // пропускаем прогрев (задержка кадра + адаптация rnnoise)
        for (let j = 0; j < BLOCK; j++) { rmsIn += input[j] ** 2; rmsOut += output[j] ** 2; }
        blocks++;
    }
}
rmsIn = Math.sqrt(rmsIn / (blocks * BLOCK));
rmsOut = Math.sqrt(rmsOut / (blocks * BLOCK));
const dropDb = 20 * Math.log10(rmsOut / rmsIn);
ok(Number.isFinite(dropDb) && dropDb < -10,
   `шум подавлен: ${dropDb.toFixed(1)} дБ (вход ${rmsIn.toFixed(4)}, выход ${rmsOut.toFixed(4)})`);
// Полное подавление в ноль срезало бы окончания слов — подмешанный
// исходный сигнал должен оставлять слышимый пол (см. DRY_MIX).
ok(dropDb > -30, `остался пол сигнала, а не тишина: ${dropDb.toFixed(1)} дБ`);

// Прозрачный режим: enabled=false пропускает звук как есть
p.port.onmessage({ data: { enabled: false } });
{
    const input = new Float32Array(BLOCK).fill(0.25);
    const output = new Float32Array(BLOCK);
    p.process([[input]], [[output]]);
    ok(output[0] === 0.25 && output[BLOCK - 1] === 0.25, 'enabled=false — прозрачный пропуск');
}

// Нет входа (микрофон ещё не подключён) — не падает
{
    const output = new Float32Array(BLOCK);
    const alive = p.process([[]], [[output]]);
    ok(alive === true, 'пустой вход не роняет процессор');
}

console.log(failed === 0 ? '\nШУМОДАВ РАБОТАЕТ' : `\nПРОВАЛОВ: ${failed}`);
process.exit(failed ? 1 : 0);
