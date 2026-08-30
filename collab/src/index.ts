import * as Y from 'yjs';
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
  readonly provider: DataChannelProvider;
  mountEditor(container: HTMLElement, language?: Language): EditorHandle;
  /** Колбэки нужны панели инструментов снаружи: доска сама меняет инструмент
      после вставки картинки, а страницу может пролистать собеседник. */
  mountBoard(container: HTMLElement, hooks?: BoardHooks): BoardHandle;
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
  const provider = new DataChannelProvider(doc, channel, opts);

  let editor: EditorHandle | null = null;
  let board: BoardHandle | null = null;

  return {
    doc,
    provider,

    mountEditor(container, language) {
      // Второй вызов на том же контейнере не должен плодить редакторы.
      editor?.destroy();
      editor = createEditor({
        doc,
        awareness: provider.awareness,
        container,
        language,
      });
      return editor;
    },

    mountBoard(container, hooks) {
      board?.destroy();
      board = createBoard({
        doc,
        awareness: provider.awareness,
        container,
        onToolChange: hooks?.onToolChange,
        onPagesChange: hooks?.onPagesChange,
      });
      return board;
    },

    onSynced(cb) {
      provider.onSynced(cb);
    },

    peers() {
      return provider.awareness.getStates().size;
    },

    destroy() {
      editor?.destroy();
      board?.destroy();
      provider.destroy();
      doc.destroy();
    },
  };
}

export type { EditorHandle, BoardHandle, Language, Tool };
