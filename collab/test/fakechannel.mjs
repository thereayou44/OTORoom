// Пара связанных фейковых RTCDataChannel: что пишут в один, приходит в другой.
export function makePair({ latency = 0 } = {}) {
  const a = makeOne('A'), b = makeOne('B');
  a.peer = b; b.peer = a;
  a.latency = latency; b.latency = latency;
  return [a, b];
}

function makeOne(label) {
  const listeners = {};
  return {
    label,
    readyState: 'open',
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    peer: null,
    latency: 0,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
    },
    _emit(type, ev) { (listeners[type] || []).forEach(fn => fn(ev)); },
    send(data) {
      // Настоящий канал принимает и ArrayBuffer, и вью, а при
      // binaryType='arraybuffer' на приёме всегда отдаёт ArrayBuffer.
      const src = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const copy = src.slice();
      const deliver = () => this.peer._emit('message', { data: copy.buffer });
      if (this.latency) setTimeout(deliver, this.latency);
      else queueMicrotask(deliver);
    },
    close() {
      if (this.readyState === 'closed') return;
      this.readyState = 'closed';
      this._emit('close', {});
      if (this.peer) this.peer.close();   // настоящий канал закрывается с обоих концов
    },
  };
}
