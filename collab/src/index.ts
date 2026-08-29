import * as Y from 'yjs';
import { DataChannelProvider } from './provider';
import { createEditor, type EditorHandle, type Language } from './editor';
import { createBoard, type BoardHandle, type Tool } from './board';

export interface CollabOptions {
  name?: string;
  color?: string;
}

export interface Collab {
  readonly doc: Y.Doc;
  readonly provider: DataChannelProvider;
  mountEditor(container: HTMLElement, language?: Language): EditorHandle;
  /** onToolChange зовётся, когда доска сама сменила инструмент (после вставки
      картинки) — панели снаружи нужно подсветить другую кнопку. */
  mountBoard(container: HTMLElement, onToolChange?: (tool: Tool) => void): BoardHandle;
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

    mountBoard(container, onToolChange) {
      board?.destroy();
      board = createBoard({
        doc,
        awareness: provider.awareness,
        container,
        onToolChange,
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
