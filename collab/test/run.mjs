import * as Y from 'yjs';
import { DataChannelProvider } from './provider.mjs';
import { makePair } from './fakechannel.mjs';

let failed = 0;
const ok = (cond, name) => {
  console.log((cond ? '  OK   ' : '  ПРОВАЛ ') + name);
  if (!cond) failed++;
};
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

// 1. Базовая синхронизация текста в обе стороны
{
  console.log('\n1. текст синхронизируется в обе стороны');
  const [ca, cb] = makePair();
  const da = new Y.Doc(), db = new Y.Doc();
  const pa = new DataChannelProvider(da, ca), pb = new DataChannelProvider(db, cb);

  da.getText('code').insert(0, 'int main() {}');
  await settle();
  ok(db.getText('code').toString() === 'int main() {}', 'A -> B');

  db.getText('code').insert(0, '#include <bits>\n');
  await settle();
  ok(da.getText('code').toString() === '#include <bits>\nint main() {}', 'B -> A');

  pa.destroy(); pb.destroy();
}

// 2. Одновременное редактирование в разных местах — главное требование
{
  console.log('\n2. одновременная правка сходится (сеть с задержкой)');
  const [ca, cb] = makePair({ latency: 30 });
  const da = new Y.Doc(), db = new Y.Doc();
  const pa = new DataChannelProvider(da, ca), pb = new DataChannelProvider(db, cb);

  da.getText('code').insert(0, 'AAAABBBB');
  await settle(120);

  // Оба печатают ОДНОВРЕМЕННО в разные позиции
  da.getText('code').insert(4, 'X');
  db.getText('code').insert(8, 'Y');
  await settle(200);

  const ta = da.getText('code').toString(), tb = db.getText('code').toString();
  ok(ta === tb, `тексты совпали (${JSON.stringify(ta)} == ${JSON.stringify(tb)})`);
  ok(ta.includes('X') && ta.includes('Y'), 'обе правки на месте');

  pa.destroy(); pb.destroy();
}

// 3. Печать в ОДНУ позицию одновременно — самый злой случай
{
  console.log('\n3. одновременная правка в одну позицию');
  const [ca, cb] = makePair({ latency: 25 });
  const da = new Y.Doc(), db = new Y.Doc();
  const pa = new DataChannelProvider(da, ca), pb = new DataChannelProvider(db, cb);

  da.getText('t').insert(0, 'hello');
  await settle(120);
  da.getText('t').insert(5, ' world');
  db.getText('t').insert(5, ' there');
  await settle(200);

  ok(da.getText('t').toString() === db.getText('t').toString(),
     `сошлось: ${JSON.stringify(da.getText('t').toString())}`);
  pa.destroy(); pb.destroy();
}

// 4. Большой документ — проверка чанкинга
{
  console.log('\n4. чанкинг больших сообщений');
  const [ca, cb] = makePair();
  const da = new Y.Doc();
  const big = 'x'.repeat(300 * 1024);          // 300 КБ, много больше лимита
  da.getText('code').insert(0, big);

  const db = new Y.Doc();
  const pa = new DataChannelProvider(da, ca), pb = new DataChannelProvider(db, cb);
  await settle(300);

  ok(db.getText('code').length === big.length,
     `300 КБ доехали целиком (получено ${db.getText('code').length})`);
  pa.destroy(); pb.destroy();
}

// 5. Массив фигур доски
{
  console.log('\n5. фигуры доски');
  const [ca, cb] = makePair({ latency: 20 });
  const da = new Y.Doc(), db = new Y.Doc();
  const pa = new DataChannelProvider(da, ca), pb = new DataChannelProvider(db, cb);
  await settle(80);

  const sa = da.getArray('shapes'), sb = db.getArray('shapes');
  const m1 = new Y.Map(); m1.set('type', 'rect'); m1.set('color', '#f00');
  sa.push([m1]);
  const m2 = new Y.Map(); m2.set('type', 'pen'); m2.set('color', '#0f0');
  sb.push([m2]);
  await settle(200);

  ok(sa.length === 2 && sb.length === 2, `у обоих по 2 фигуры (${sa.length}/${sb.length})`);
  ok(JSON.stringify(sa.toJSON()) === JSON.stringify(sb.toJSON()), 'порядок одинаковый');
  pa.destroy(); pb.destroy();
}

// 6. Awareness — курсоры собеседника
{
  console.log('\n6. awareness (курсоры)');
  const [ca, cb] = makePair();
  const da = new Y.Doc(), db = new Y.Doc();
  const pa = new DataChannelProvider(da, ca, { name: 'Никита', color: '#6fc3f7' });
  const pb = new DataChannelProvider(db, cb, { name: 'Ученик', color: '#f2b24c' });
  await settle(120);

  const seenByB = [...pb.awareness.getStates().values()].map(s => s.user?.name);
  ok(seenByB.includes('Никита'), `B видит A: ${JSON.stringify(seenByB)}`);

  ca.close();
  await settle(60);
  const after = [...pb.awareness.getStates().keys()].filter(id => id !== db.clientID);
  ok(after.length === 0, 'после закрытия канала чужой курсор убран');
  pa.destroy(); pb.destroy();
}

// 7. Undo не трогает чужие правки
{
  console.log('\n7. undo не отменяет чужое');
  const [ca, cb] = makePair();
  const da = new Y.Doc(), db = new Y.Doc();
  const pa = new DataChannelProvider(da, ca), pb = new DataChannelProvider(db, cb);
  await settle(60);

  const ta = da.getText('t');
  const um = new Y.UndoManager(ta, { trackedOrigins: new Set([null]) });
  ta.insert(0, 'мой текст');
  await settle(60);
  db.getText('t').insert(0, 'чужой ');
  await settle(60);

  um.undo();
  await settle(60);
  const res = da.getText('t').toString();
  ok(res === 'чужой ' && db.getText('t').toString() === 'чужой ',
     `осталось только чужое: ${JSON.stringify(res)}`);
  pa.destroy(); pb.destroy();
}

// 8. Картинка на доске: бинарные данные внутри Y.Map доезжают целыми
{
    console.log('\n8. бинарные данные фигуры-картинки');
    const [ca, cb] = makePair({ latency: 15 });
    const da = new Y.Doc(), db = new Y.Doc();
    const pa = new DataChannelProvider(da, ca), pb = new DataChannelProvider(db, cb);
    await settle(80);

    const bytes = new Uint8Array(150 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;

    const m = new Y.Map();
    m.set('type', 'image');
    m.set('x1', 320); m.set('y1', 180); m.set('w', 640); m.set('h', 360);
    m.set('data', bytes);
    da.getArray('board').push([m]);
    await settle(300);

    const shape = db.getArray('board').get(0);
    const got = shape && shape.get('data');
    ok(got instanceof Uint8Array && got.length === bytes.length,
       `байты доехали (${got && got.length} из ${bytes.length})`);
    ok(!!got && got[0] === bytes[0] && got[77777] === bytes[77777] && got[got.length - 1] === bytes[bytes.length - 1],
       'содержимое не побилось');
    ok(shape.get('w') === 640, 'размеры на месте');
    pa.destroy(); pb.destroy();
}

console.log(failed === 0 ? '\nВСЕ ТЕСТЫ ПРОШЛИ' : `\nПРОВАЛОВ: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
