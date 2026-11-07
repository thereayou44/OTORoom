import * as Y from 'yjs';

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Связывает textarea с Y.Text в обе стороны. Возвращает функцию отвязки. */
export function bindTextarea(ytext: Y.Text, textarea: HTMLTextAreaElement): () => void {
  const origin = Symbol('textarea');
  textarea.value = ytext.toString();

  const onInput = () => {
    const prev = ytext.toString();
    const next = textarea.value;
    if (prev === next) return;

    // Меняем только отличающийся кусок: замена целиком склеила бы
    // одновременный ввод двоих.
    const max = Math.min(prev.length, next.length);
    let start = 0;
    while (start < max && prev[start] === next[start]) start++;
    let end = 0;
    while (end < max - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
    // Не режем суррогатную пару — Yjs заменил бы половинки на �.
    if (start > 0 && isHigh(prev.charCodeAt(start - 1))) start--;
    if (end > 0 && isLow(prev.charCodeAt(prev.length - end))) end--;

    ytext.doc!.transact(() => {
      ytext.delete(start, prev.length - start - end);
      ytext.insert(start, next.slice(start, next.length - end));
    }, origin);
  };

  const onRemote = (e: Y.YTextEvent, tr: Y.Transaction) => {
    if (tr.origin === origin) return;

    // Сдвигаем выделение на чужие правки перед ним.
    let s = textarea.selectionStart;
    let f = textarea.selectionEnd;
    let pos = 0;
    for (const op of e.delta) {
      if (op.retain) {
        pos += op.retain;
      } else if (typeof op.insert === 'string') {
        const n = op.insert.length;
        if (pos < s) s += n;
        if (pos < f) f += n;
        pos += n;
      } else if (op.delete) {
        if (pos < s) s -= Math.min(op.delete, s - pos);
        if (pos < f) f -= Math.min(op.delete, f - pos);
      }
    }

    const scroll = textarea.scrollTop;
    textarea.value = ytext.toString();
    textarea.scrollTop = scroll;
    if (textarea.ownerDocument.activeElement === textarea) textarea.setSelectionRange(s, f);
  };

  textarea.addEventListener('input', onInput);
  ytext.observe(onRemote);

  return () => {
    textarea.removeEventListener('input', onInput);
    ytext.unobserve(onRemote);
  };
}
