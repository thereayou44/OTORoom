/* Тест ступени громкости (web/mic-gain-worklet.js).
 * Запуск: node test/micgain.mjs
 *
 * Проверяем три вещи, ради которых она и делалась:
 *   1. фон в паузах НЕ становится громче — иначе смысла в ней нет;
 *   2. речь становится заметно громче;
 *   3. хвост слова не обрубается — усиление спадает плавно, а не мгновенно.
 */
import { readFileSync } from 'fs';

let failed = 0;
const ok = (cond, name) => {
    console.log((cond ? '  OK   ' : '  ПРОВАЛ ') + name);
    if (!cond) failed++;
};

const RATE = 48000;
const BLOCK = 128;

const registered = {};
globalThis.sampleRate = RATE;
globalThis.currentTime = 0;
globalThis.registerProcessor = (n, c) => { registered[n] = c; };
globalThis.AudioWorkletProcessor = class {
    constructor() { this.port = { onmessage: null, postMessage() {} }; }
};

const src = readFileSync(new URL('../../web/mic-gain-worklet.js', import.meta.url), 'utf8');
(0, eval)(src);
ok(!!registered['oto-mic-gain'], 'процессор oto-mic-gain зарегистрирован');

const p = new registered['oto-mic-gain']();

/** Прогоняет generator через процессор, возвращает RMS входа и выхода. */
function run(gen, seconds, collect = true) {
    let ein = 0, eout = 0, n = 0;
    for (let b = 0; b < Math.floor(seconds * RATE / BLOCK); b++) {
        const input = new Float32Array(BLOCK);
        for (let j = 0; j < BLOCK; j++) input[j] = gen(b * BLOCK + j);
        const output = new Float32Array(BLOCK);
        p.process([[input]], [[output]]);
        if (collect) {
            for (let j = 0; j < BLOCK; j++) { ein += input[j] ** 2; eout += output[j] ** 2; n++; }
        }
    }
    return n ? { in: Math.sqrt(ein / n), out: Math.sqrt(eout / n) } : null;
}

let seed = 5;
const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x3fffffff - 1) * 0.004; };
const voice = (n) => {
    const t = n / RATE;
    return 0.12 * (Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 280 * t)
        + 0.35 * Math.sin(2 * Math.PI * 700 * t));
};

// 1. Фон в паузах не усиливается
run(noise, 1.0, false);                       // даём воротам закрыться
const bg = run(noise, 0.5);
const bgDb = 20 * Math.log10(bg.out / bg.in);
ok(bgDb < 0, `фон в паузах не громче входа: ${bgDb.toFixed(1)} дБ`);

// 2. Речь усиливается
const sp = run(voice, 0.6);
const spDb = 20 * Math.log10(sp.out / sp.in);
ok(spDb > 6, `речь усилена на ${spDb.toFixed(1)} дБ`);

// 3. Разница между речью и фоном выросла — ровно то, чего добивались
ok(spDb - bgDb > 10, `речь оторвалась от фона на ${(spDb - bgDb).toFixed(1)} дБ`);

// 4. Хвост слова не обрубается: сразу после речи усиление ещё держится
const tail = run(noise, 0.12);
const settled = (run(noise, 1.0, false), run(noise, 0.12));
ok(tail.out > settled.out * 1.5,
   `после речи ворота придержаны (${(20 * Math.log10(tail.out / settled.out)).toFixed(1)} дБ над тишиной)`);

// 5. Выключенная ступень пропускает сигнал как есть
p.port.onmessage({ data: { enabled: false } });
{
    // 0.25 — точно представимо во float32, сравнение без допуска корректно
    const input = new Float32Array(BLOCK).fill(0.25);
    const output = new Float32Array(BLOCK);
    p.process([[input]], [[output]]);
    ok(output[0] === 0.25 && output[BLOCK - 1] === 0.25, 'enabled=false — прозрачный пропуск');
}

// 6. Нет входа — не падает
{
    const output = new Float32Array(BLOCK);
    ok(p.process([[]], [[output]]) === true, 'пустой вход не роняет процессор');
}

console.log(failed === 0 ? '\nСТУПЕНЬ ГРОМКОСТИ РАБОТАЕТ' : `\nПРОВАЛОВ: ${failed}`);
process.exit(failed ? 1 : 0);
