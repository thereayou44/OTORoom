import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { DataChannelProvider } from './provider';
import { createEditor, type EditorHandle, type Language } from './editor';
import { createBoard, type BoardHandle, type Tool } from './board';

export interface CollabOptions {
  name?: string;
  color?: string;
}

export interface BoardHooks {
  onToolChange?: (tool: Tool) => void;
  onPagesChange?: (page: number, total: number) => void;
}

export interface Collab {
  readonly doc: Y.Doc;
  /** Текущий провайдер; null, пока канала нет (собеседник переподключается). */
  readonly provider: DataChannelProvider | null;
  mountEditor(container: HTMLElement, language?: Language): EditorHandle;
  /** Колбэки нужны панели инструментов снаружи: доска сама меняет инструмент
      после вставки картинки, а страницу может пролистать собеседник. */
  mountBoard(container: HTMLElement, hooks?: BoardHooks): BoardHandle;
  /**
   * Подключает тот же документ к новому каналу. Собеседник перезагрузил
   * страницу или сменил сеть — канал новый, а код, доска и вывод остаются:
   * Yjs сам досинхронизирует то, чего у другой стороны нет.
   */
  attach(channel: RTCDataChannel): void;
  /** Отключает от канала, но документ, редактор и доску не трогает. */
  detach(): void;
  onSynced(cb: () => void): void;
  /** Сколько участников сейчас в документе, включая себя. */
  peers(): number;
  destroy(): void;
}

/**
 * Точка входа для app.js: получает уже открытый data channel и отдаёт
 * объект, через который монтируются редактор и доска.
 */
export function createCollab(channel: RTCDataChannel, opts: CollabOptions = {}): Collab {
  const doc = new Y.Doc();
  // Один awareness на весь срок жизни документа, а не на канал: редактор и
  // доска держат на него ссылку, и при смене канала их не пересоздаём.
  const awareness = new Awareness(doc);

  const connect = (ch: RTCDataChannel) =>
    new DataChannelProvider(doc, ch, { ...opts, awareness });

  let provider: DataChannelProvider | null = connect(channel);
  let editor: EditorHandle | null = null;
  let board: BoardHandle | null = null;

  return {
    doc,
    get provider() {
      return provider;
    },

    mountEditor(container, language) {
      // Второй вызов на том же контейнере не должен плодить редакторы.
      editor?.destroy();
      editor = createEditor({ doc, awareness, container, language });
      return editor;
    },

    mountBoard(container, hooks) {
      board?.destroy();
      board = createBoard({
        doc,
        awareness,
        container,
        onToolChange: hooks?.onToolChange,
        onPagesChange: hooks?.onPagesChange,
      });
      return board;
    },

    attach(ch) {
      provider?.destroy();
      provider = connect(ch);
    },

    detach() {
      provider?.destroy();
      provider = null;
    },

    onSynced(cb) {
      provider?.onSynced(cb);
    },

    peers() {
      return awareness.getStates().size;
    },

    destroy() {
      editor?.destroy();
      board?.destroy();
      provider?.destroy();
      provider = null;
      awareness.destroy();
      doc.destroy();
    },
  };
}

export type { EditorHandle, BoardHandle, Language, Tool };
