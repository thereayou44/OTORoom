import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

export type Tool = 'pen' | 'line' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'eraser';

/**
 * Холст фиксированного размера: у собеседников разные окна, а рисунок
 * должен выглядеть одинаково. Экранные координаты приводим к этим.
 */
const BOARD_W = 1600;
const BOARD_H = 900;

const HIT_SLACK = 8;      // насколько «толще» линия для попадания ластиком
const LIVE_THROTTLE = 40; // мс между обновлениями незаконченного штриха

export interface BoardHandle {
  setTool(tool: Tool): void;
  setColor(color: string): void;
  setWidth(width: number): void;
  clear(): void;
  undo(): void;
  redo(): void;
  destroy(): void;
}

export interface BoardOptions {
  doc: Y.Doc;
  awareness: Awareness;
  container: HTMLElement;
  key?: string;
}

interface ShapeData {
  type: Exclude<Tool, 'eraser'> | 'image';
  color: string;
  width: number;
  points?: number[];
  x1?: number; y1?: number; x2?: number; y2?: number;
  text?: string;
  /** image: сжатый JPEG и размеры на холсте */
  data?: Uint8Array;
  w?: number; h?: number;
}

/** Не раздуваем общий документ: он живёт в памяти и целиком передаётся
    при каждом переподключении. */
const IMG_MAX_BYTES = 900 * 1024;
const IMG_MAX_SIDE = 1280;

export function createBoard(opts: BoardOptions): BoardHandle {
  const { doc, awareness, container } = opts;
  const shapes = doc.getArray<Y.Map<unknown>>(opts.key ?? 'board');
  const undoManager = new Y.UndoManager(shapes);

  const canvas = document.createElement('canvas');
  canvas.className = 'board__canvas';
  canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:crosshair';
  container.append(canvas);

  const ctx = canvas.getContext('2d')!;

  let tool: Tool = 'pen';
  let color = '#e9f1fb';
  let width = 3;

  let drawing = false;
  let live: Y.Map<unknown> | null = null;   // фигура, которую рисуем прямо сейчас
  let livePoints: number[] = [];
  let lastPush = 0;
  let startX = 0, startY = 0;

  // ---------- размеры и координаты ----------

  let scale = 1, offX = 0, offY = 0;

  function fit() {
    const rect = container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));

    // Вписываем холст 1600×900 целиком, сохраняя пропорции.
    scale = Math.min(rect.width / BOARD_W, rect.height / BOARD_H);
    offX = (rect.width - BOARD_W * scale) / 2;
    offY = (rect.height - BOARD_H * scale) / 2;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  const ro = new ResizeObserver(fit);
  ro.observe(container);

  function toBoard(e: PointerEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [
      (e.clientX - rect.left - offX) / scale,
      (e.clientY - rect.top - offY) / scale,
    ];
  }

  // ---------- отрисовка ----------

  function render() {
    const rect = container.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);

    // Рамка холста, чтобы было видно границы общей области.
    ctx.strokeStyle = 'rgba(122,167,224,.14)';
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, BOARD_W, BOARD_H);

    for (const item of shapes) {
      drawShape(item.toJSON() as unknown as ShapeData, item);
    }

    ctx.restore();
  }

  // Декодированные картинки. Ключ — сама Y.Map фигуры: она стабильна
  // между перерисовками, а при удалении фигуры запись отпадёт сама.
  const bitmaps = new WeakMap<Y.Map<unknown>, ImageBitmap | 'pending' | 'error'>();

  function drawImage(s: ShapeData, item: Y.Map<unknown>) {
    const { x1 = 0, y1 = 0, w = 0, h = 0 } = s;
    const cached = bitmaps.get(item);

    if (cached instanceof ImageBitmap) {
      ctx.drawImage(cached, x1, y1, w, h);
      return;
    }
    if (cached === undefined && s.data) {
      bitmaps.set(item, 'pending');
      createImageBitmap(new Blob([s.data as BlobPart], { type: 'image/jpeg' }))
        .then((b) => { bitmaps.set(item, b); render(); })
        .catch(() => { bitmaps.set(item, 'error'); });
    }
    // Пока декодируется (или если байты битые) — пунктирная рамка-заглушка.
    ctx.save();
    ctx.strokeStyle = 'rgba(122,167,224,.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x1, y1, w, h);
    ctx.restore();
  }

  function drawShape(s: ShapeData, item: Y.Map<unknown>) {
    if (s.type === 'image') {
      drawImage(s, item);
      return;
    }
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (s.type === 'pen' && s.points && s.points.length >= 4) {
      ctx.beginPath();
      ctx.moveTo(s.points[0], s.points[1]);
      // Сглаживание по средним точкам — линия от руки не выглядит ломаной.
      for (let i = 2; i < s.points.length - 2; i += 2) {
        const mx = (s.points[i] + s.points[i + 2]) / 2;
        const my = (s.points[i + 1] + s.points[i + 3]) / 2;
        ctx.quadraticCurveTo(s.points[i], s.points[i + 1], mx, my);
      }
      ctx.lineTo(s.points[s.points.length - 2], s.points[s.points.length - 1]);
      ctx.stroke();
      return;
    }

    const { x1 = 0, y1 = 0, x2 = 0, y2 = 0 } = s;

    if (s.type === 'line') {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (s.type === 'rect') {
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (s.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2,
        Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.type === 'arrow') {
      const head = Math.max(12, s.width * 4);
      const a = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(a - Math.PI / 7), y2 - head * Math.sin(a - Math.PI / 7));
      ctx.lineTo(x2 - head * Math.cos(a + Math.PI / 7), y2 - head * Math.sin(a + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    } else if (s.type === 'text' && s.text) {
      ctx.font = `${Math.max(14, s.width * 7)}px "IBM Plex Sans", system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      s.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, x1, y1 + i * Math.max(18, s.width * 9));
      });
    }
  }

  // ---------- ластик ----------

  function hitTest(x: number, y: number): number {
    // Сверху вниз: последняя нарисованная фигура стирается первой.
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes.get(i).toJSON() as unknown as ShapeData;
      const slack = s.width / 2 + HIT_SLACK;

      if (s.type === 'pen' && s.points) {
        for (let j = 0; j < s.points.length - 2; j += 2) {
          if (distToSegment(x, y, s.points[j], s.points[j + 1], s.points[j + 2], s.points[j + 3]) <= slack)
            return i;
        }
        continue;
      }

      const { x1 = 0, y1 = 0, x2 = 0, y2 = 0 } = s;

      if (s.type === 'image') {
        const { w = 0, h = 0 } = s;
        if (x >= x1 - slack && x <= x1 + w + slack && y >= y1 - slack && y <= y1 + h + slack) return i;
      } else if (s.type === 'line' || s.type === 'arrow') {
        if (distToSegment(x, y, x1, y1, x2, y2) <= slack) return i;
      } else if (s.type === 'rect' || s.type === 'ellipse') {
        const l = Math.min(x1, x2) - slack, r = Math.max(x1, x2) + slack;
        const t = Math.min(y1, y2) - slack, b = Math.max(y1, y2) + slack;
        if (x >= l && x <= r && y >= t && y <= b) return i;
      } else if (s.type === 'text') {
        const h = Math.max(18, s.width * 9) * (s.text?.split('\n').length ?? 1);
        const w = (s.text?.length ?? 0) * Math.max(8, s.width * 4);
        if (x >= x1 - slack && x <= x1 + w && y >= y1 - slack && y <= y1 + h) return i;
      }
    }
    return -1;
  }

  // ---------- ввод ----------

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = toBoard(e);

    if (tool === 'eraser') {
      const idx = hitTest(x, y);
      if (idx >= 0) shapes.delete(idx, 1);
      return;
    }

    if (tool === 'text') {
      const text = prompt('Текст:');
      if (text) {
        const m = new Y.Map();
        m.set('type', 'text');
        m.set('color', color);
        m.set('width', width);
        m.set('x1', x);
        m.set('y1', y);
        m.set('text', text);
        shapes.push([m]);
      }
      return;
    }

    drawing = true;
    startX = x; startY = y;

    const m = new Y.Map();
    m.set('type', tool);
    m.set('color', color);
    m.set('width', width);

    if (tool === 'pen') {
      livePoints = [x, y];
      m.set('points', livePoints.slice());
    } else {
      m.set('x1', x); m.set('y1', y); m.set('x2', x); m.set('y2', y);
    }

    // Кладём фигуру в общий документ сразу: собеседник видит штрих
    // по мере рисования, а не только после отпускания кнопки.
    shapes.push([m]);
    live = m;
    lastPush = 0;
  }

  function onPointerMove(e: PointerEvent) {
    if (!drawing || !live) return;
    const [x, y] = toBoard(e);

    if (tool === 'pen') {
      livePoints.push(x, y);
      const now = performance.now();
      if (now - lastPush < LIVE_THROTTLE) return;   // не заваливаем канал
      lastPush = now;
      live.set('points', livePoints.slice());
    } else {
      const now = performance.now();
      if (now - lastPush < LIVE_THROTTLE) return;
      lastPush = now;
      live.set('x2', x); live.set('y2', y);
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!drawing || !live) return;
    const [x, y] = toBoard(e);

    if (tool === 'pen') {
      livePoints.push(x, y);
      live.set('points', livePoints.slice());
    } else {
      live.set('x2', x); live.set('y2', y);
      // Клик без движения не должен оставлять точку-артефакт.
      if (Math.abs(x - startX) < 2 && Math.abs(y - startY) < 2) {
        const idx = shapes.toArray().indexOf(live);
        if (idx >= 0) shapes.delete(idx, 1);
      }
    }

    drawing = false;
    live = null;
    livePoints = [];
    canvas.releasePointerCapture(e.pointerId);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  // ---------- вставка картинок ----------

  /** Перекодирует картинку в JPEG не длиннее maxSide по большой стороне.
      JPEG не умеет прозрачность, поэтому подкладываем белый фон. */
  async function encodeJpeg(bmp: ImageBitmap, maxSide: number, quality: number): Promise<Uint8Array | null> {
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    if (!cx) return null;
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, w, h);
    cx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', quality));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  async function imageToShape(file: File): Promise<Y.Map<unknown> | null> {
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) return null;

    let bytes = await encodeJpeg(bmp, IMG_MAX_SIDE, 0.82);
    // Слишком тяжёлая (фотография с деталями) — пробуем жёстче.
    if (bytes && bytes.byteLength > IMG_MAX_BYTES) bytes = await encodeJpeg(bmp, 900, 0.7);
    const aspect = bmp.width / bmp.height;
    bmp.close();
    if (!bytes || bytes.byteLength > IMG_MAX_BYTES) return null;

    // Вписываем в 60% холста; лёгкий сдвиг, чтобы вставки подряд не легли стопкой.
    let w = BOARD_W * 0.6, h = w / aspect;
    if (h > BOARD_H * 0.6) { h = BOARD_H * 0.6; w = h * aspect; }
    const jitter = () => (Math.random() - 0.5) * 60;
    const m = new Y.Map();
    m.set('type', 'image');
    m.set('color', '#ffffff');
    m.set('width', 1);
    m.set('x1', Math.round((BOARD_W - w) / 2 + jitter()));
    m.set('y1', Math.round((BOARD_H - h) / 2 + jitter()));
    m.set('w', Math.round(w));
    m.set('h', Math.round(h));
    m.set('data', bytes);
    return m;
  }

  async function onPaste(e: ClipboardEvent) {
    // Панель доски скрыта — вставка не наша.
    if (container.offsetParent === null) return;
    // Пользователь вставляет в текстовое поле (чат, редактор) — не перехватываем.
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;

    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const file = items.find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (!file) return;

    e.preventDefault();
    const shape = await imageToShape(file);
    if (shape) shapes.push([shape]);
    else console.warn('доска: картинка не влезла даже после сжатия — не вставлена');
  }

  document.addEventListener('paste', onPaste);

  // Перерисовываем на любое изменение — своё и чужое.
  const observer = () => render();
  shapes.observeDeep(observer);

  fit();

  return {
    setTool(t) {
      tool = t;
      canvas.style.cursor = t === 'eraser' ? 'cell' : t === 'text' ? 'text' : 'crosshair';
    },
    setColor(c) { color = c; },
    setWidth(w) { width = w; },
    clear() {
      if (shapes.length) shapes.delete(0, shapes.length);
    },
    undo() { undoManager.undo(); },
    redo() { undoManager.redo(); },
    destroy() {
      document.removeEventListener('paste', onPaste);
      shapes.unobserveDeep(observer);
      undoManager.destroy();
      ro.disconnect();
      canvas.remove();
      void awareness;
    },
  };
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
