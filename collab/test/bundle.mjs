import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', {
  runScripts: 'outside-only', pretendToBeVisual: true,
});
const { window } = dom;

// Минимальные заглушки того, чего нет в jsdom
window.ResizeObserver = class { observe(){} disconnect(){} };
// performance в jsdom уже есть
// window.performance = window.performance || { now: () => Date.now() };

const code = readFileSync('dist/oto-collab.js', 'utf8');
window.eval(code);

const OTO = window.OTO;
let fail = 0;
const ok = (c, n) => { console.log((c ? '  OK   ' : '  ПРОВАЛ ') + n); if (!c) fail++; };

ok(!!OTO, 'window.OTO существует');
ok(typeof OTO?.createCollab === 'function', 'createCollab это функция');

// Фейковый канал прямо здесь
function fakeChannel() {
  const l = {};
  return {
    readyState: 'open', binaryType: '', bufferedAmount: 0, bufferedAmountLowThreshold: 0,
    peer: null,
    addEventListener(t, f) { (l[t] ||= []).push(f); },
    removeEventListener(t, f) { if (l[t]) l[t] = l[t].filter(x => x !== f); },
    _emit(t, e) { (l[t] || []).forEach(f => f(e)); },
    send(d) {
      // instanceof не годится: ArrayBuffer внутри jsdom-окна и в Node —
      // разные конструкторы. Различаем по наличию .buffer у вью.
      const u = ArrayBuffer.isView(d) || d.buffer !== undefined
        ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
        : new Uint8Array(d);
      const c = u.slice();
      queueMicrotask(() => this.peer?._emit('message', { data: c.buffer }));
    },
    close() {},
  };
}

const ca = fakeChannel(), cb = fakeChannel();
ca.peer = cb; cb.peer = ca;

const a = OTO.createCollab(ca, { name: 'Никита', color: '#6fc3f7' });
const b = OTO.createCollab(cb, { name: 'Ученик', color: '#f2b24c' });

ok(!!a.doc && !!a.provider, 'collab отдаёт doc и provider');

a.doc.getText('code').insert(0, 'int main(){}');
await new Promise(r => setTimeout(r, 100));
ok(b.doc.getText('code').toString() === 'int main(){}', 'текст доехал через собранный бандл');
ok(a.peers() === 2 && b.peers() === 2, `видят друг друга (${a.peers()}/${b.peers()})`);

// Редактор в jsdom
try {
  const h = a.mountEditor(window.document.getElementById('app'), 'cpp');
  ok(typeof h.setLanguage === 'function' && typeof h.getText === 'function', 'редактор смонтирован');
  ok(h.getText() === 'int main(){}', 'редактор показывает общий текст');
  h.setLanguage('python');
  ok(true, 'смена языка не падает');
  h.destroy();
} catch (e) {
  ok(false, 'редактор: ' + e.message);
}

a.destroy(); b.destroy();
console.log(fail === 0 ? '\nБАНДЛ РАБОТАЕТ' : `\nПРОВАЛОВ: ${fail}`);
process.exit(fail ? 1 : 0);
