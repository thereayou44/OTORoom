import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

// RTCDataChannel надёжно принимает сообщения примерно до 64 КБ.
// Первая синхронизация документа с доской легко превысит этот размер,
// поэтому крупные сообщения режем на части и собираем на той стороне.
const CHUNK_LIMIT = 16 * 1024;

const FRAME_WHOLE = 0;
const FRAME_CHUNK = 1;

interface Pending {
  parts: (Uint8Array | undefined)[];
  received: number;
  total: number;
}

export interface ProviderOptions {
  /** Имя, которое увидит собеседник рядом с курсором. */
  name?: string;
  /** Цвет курсора и выделения. */
  color?: string;
}

/**
 * Связывает Y.Doc с уже открытым RTCDataChannel.
 *
 * Свой транспорт вместо y-webrtc: соединение между браузерами уже
 * установлено сигналингом, поднимать второе незачем.
 */
export class DataChannelProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  private channel: RTCDataChannel;
  private pending = new Map<number, Pending>();
  private nextMessageId = 1;
  private queue: Uint8Array[] = [];
  private destroyed = false;
  private synced = false;

  private onSyncedCb: (() => void) | null = null;

  constructor(doc: Y.Doc, channel: RTCDataChannel, opts: ProviderOptions = {}) {
    this.doc = doc;
    this.channel = channel;
    this.awareness = new awarenessProtocol.Awareness(doc);

    if (opts.name || opts.color) {
      this.awareness.setLocalStateField('user', {
        name: opts.name ?? 'собеседник',
        color: opts.color ?? '#6fc3f7',
      });
    }

    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 64 * 1024;

    channel.addEventListener('message', this.handleMessage);
    channel.addEventListener('bufferedamountlow', this.flushQueue);
    channel.addEventListener('close', this.handleClose);

    doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);

    if (channel.readyState === 'open') this.start();
    else channel.addEventListener('open', this.start, { once: true });
  }

  /** Вызывается один раз, когда прошёл первый обмен состоянием. */
  onSynced(cb: () => void) {
    if (this.synced) cb();
    else this.onSyncedCb = cb;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    this.channel.removeEventListener('message', this.handleMessage);
    this.channel.removeEventListener('bufferedamountlow', this.flushQueue);
    this.channel.removeEventListener('close', this.handleClose);

    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      'provider destroyed',
    );
    this.awareness.destroy();
  }

  // ---------- исходящее ----------

  private start = () => {
    // Шаг 1 протокола синхронизации: «вот что у меня есть, пришли недостающее».
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.send(encoding.toUint8Array(enc));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        aenc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      this.send(encoding.toUint8Array(aenc));
    }
  };

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Изменения, пришедшие от собеседника, обратно не отсылаем.
    if (origin === this) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.send(encoding.toUint8Array(enc));
  };

  private handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    const ids = [...changes.added, ...changes.updated, ...changes.removed];
    if (ids.length === 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids),
    );
    this.send(encoding.toUint8Array(enc));
  };

  private send(payload: Uint8Array) {
    if (this.destroyed) return;

    if (payload.byteLength <= CHUNK_LIMIT) {
      this.enqueue(frameWhole(payload));
      return;
    }

    const id = this.nextMessageId++;
    const total = Math.ceil(payload.byteLength / CHUNK_LIMIT);
    for (let i = 0; i < total; i++) {
      const slice = payload.subarray(i * CHUNK_LIMIT, (i + 1) * CHUNK_LIMIT);
      this.enqueue(frameChunk(id, i, total, slice));
    }
  }

  private enqueue(frame: Uint8Array) {
    this.queue.push(frame);
    this.flushQueue();
  }

  /**
   * Пишем в канал, пока он не забит. Переполнить буфер легко — при
   * активном рисовании апдейты идут десятками в секунду, а канал
   * закроется с ошибкой, если складывать в него без оглядки.
   */
  private flushQueue = () => {
    if (this.destroyed || this.channel.readyState !== 'open') return;
    while (this.queue.length > 0) {
      if (this.channel.bufferedAmount > 1024 * 1024) return; // подождём bufferedamountlow
      const frame = this.queue.shift()!;
      try {
        // Отдаём именно ArrayBuffer: типы DOM не принимают вью над
        // SharedArrayBuffer, а конкретный буфер подходит всегда.
        this.channel.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
      } catch {
        this.queue.unshift(frame);
        return;
      }
    }
  };

  // ---------- входящее ----------

  private handleMessage = (e: MessageEvent) => {
    if (this.destroyed) return;
    const data = toUint8(e.data);
    if (!data || data.byteLength === 0) return;

    const kind = data[0];

    if (kind === FRAME_WHOLE) {
      this.handlePayload(data.subarray(1));
      return;
    }

    if (kind !== FRAME_CHUNK) return;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const id = view.getUint32(1);
    const index = view.getUint16(5);
    const total = view.getUint16(7);
    const body = data.subarray(9);

    let slot = this.pending.get(id);
    if (!slot) {
      slot = { parts: new Array(total), received: 0, total };
      this.pending.set(id, slot);
    }
    if (slot.parts[index] === undefined) {
      slot.parts[index] = body;
      slot.received++;
    }
    if (slot.received === slot.total) {
      this.pending.delete(id);
      this.handlePayload(concat(slot.parts as Uint8Array[]));
    }
  };

  private handlePayload(payload: Uint8Array) {
    const dec = decoding.createDecoder(payload);
    const enc = encoding.createEncoder();
    const type = decoding.readVarUint(dec);

    if (type === MSG_SYNC) {
      encoding.writeVarUint(enc, MSG_SYNC);
      // origin = this, чтобы не отправить полученное обратно отправителю.
      const answer = syncProtocol.readSyncMessage(dec, enc, this.doc, this);

      if (answer === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        this.onSyncedCb?.();
        this.onSyncedCb = null;
      }

      if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
      return;
    }

    if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(dec),
        this,
      );
    }
  }

  private handleClose = () => {
    // Курсоры собеседника должны исчезнуть, когда он отключился.
    const others = [...this.awareness.getStates().keys()].filter(
      (id) => id !== this.doc.clientID,
    );
    awarenessProtocol.removeAwarenessStates(this.awareness, others, 'channel closed');
  };
}

// ---------- кадры ----------

function frameWhole(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = FRAME_WHOLE;
  out.set(payload, 1);
  return out;
}

function frameChunk(id: number, index: number, total: number, part: Uint8Array): Uint8Array {
  const out = new Uint8Array(part.byteLength + 9);
  const view = new DataView(out.buffer);
  out[0] = FRAME_CHUNK;
  view.setUint32(1, id);
  view.setUint16(5, index);
  view.setUint16(7, total);
  out.set(part, 9);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.byteLength;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * instanceof здесь не годится: буфер может прийти из другого realm
 * (iframe, воркер, тестовая среда) — конструктор будет другим, а данные
 * теми же. Различаем по форме объекта.
 */
function toUint8(data: unknown): Uint8Array | null {
  if (data == null || typeof data !== 'object') return null;

  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }

  const maybe = data as { byteLength?: unknown; buffer?: unknown };
  if (typeof maybe.byteLength === 'number' && maybe.buffer === undefined) {
    return new Uint8Array(data as ArrayBuffer);
  }
  return null;
}
