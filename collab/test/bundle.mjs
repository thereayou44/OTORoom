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

// Доска, открытая уже после того, как собеседник перелистнул. Раньше она
// оставалась на первой странице: о текущей узнавала только из изменений,
// а изменений после открытия больше не было.
try {
  // В jsdom нет настоящего canvas — подставляем 2D-контекст, где любой
  // метод ничего не делает. Рисование тут не проверяем, только страницы.
  const noop = () => {};
  const fakeCtx = new Proxy({}, { get: () => noop, set: () => true });
  window.HTMLCanvasElement.prototype.getContext = () => fakeCtx;

  const meta = a.doc.getMap('board-meta');
  meta.set('pages', 2);
  meta.set('current', 1);
  await new Promise(r => setTimeout(r, 100));

  let seen = null;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const board = b.mountBoard(host, { onPagesChange: (page, total) => { seen = { page, total }; } });

  ok(seen && seen.page === 1 && seen.total === 2,
     `доска открылась сразу на текущей странице (${JSON.stringify(seen)})`);
  ok(board.page() === 1, 'и сама доска считает её текущей');
  board.destroy();
} catch (e) {
  ok(false, 'доска: ' + e.message);
}

// Собеседник перезагрузил страницу. Раньше на этом месте документ
// уничтожался у обоих: F5 у ученика стирал код и доску у учителя.
// Теперь оставшийся держит документ, отключается от мёртвого канала и
// подключается к новому — а вернувшийся получает всё обратно.
try {
  const before = a.doc.getText('code').toString();
  ok(before.length > 0, 'перед перезагрузкой в документе есть код');

  b.destroy();      // страница B умерла вместе со своим документом
  a.detach();       // A отцепился от мёртвого канала, но документ держит
  ok(a.provider === null, 'без канала провайдера нет');
  ok(a.doc.getText('code').toString() === before, 'у оставшегося код на месте');

  // Пока собеседника нет, A продолжает писать — это тоже не должно пропасть.
  a.doc.getText('code').insert(0, '// пока тебя не было\n');

  const ca2 = fakeChannel(), cb2 = fakeChannel();
  ca2.peer = cb2; cb2.peer = ca2;
  a.attach(ca2);
  const b2 = OTO.createCollab(cb2, { name: 'Ученик', color: '#f2b24c' });
  await new Promise(r => setTimeout(r, 150));

  const want = a.doc.getText('code').toString();
  ok(b2.doc.getText('code').toString() === want,
     'вернувшийся получил весь код, включая написанное без него');
  ok(a.peers() === 2 && b2.peers() === 2, `снова видят друг друга (${a.peers()}/${b2.peers()})`);
  b2.destroy();
} catch (e) {
  ok(false, 'переподключение: ' + e.message);
}

a.destroy();
console.log(fail === 0 ? '\nБАНДЛ РАБОТАЕТ' : `\nПРОВАЛОВ: ${fail}`);
process.exit(fail ? 1 : 0);
