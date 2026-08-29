import * as Y from 'yjs';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentUnit, bracketMatching, foldGutter } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';

export type Language = 'cpp' | 'python';

const LANGS = {
  cpp: () => cpp(),
  python: () => python(),
};

export interface EditorHandle {
  setLanguage(lang: Language): void;
  getText(): string;
  focus(): void;
  destroy(): void;
}

export interface EditorOptions {
  doc: Y.Doc;
  awareness: Awareness;
  container: HTMLElement;
  language?: Language;
  /** Ключ текста в документе — на случай нескольких файлов в будущем. */
  key?: string;
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const { doc, awareness, container } = opts;
  const ytext = doc.getText(opts.key ?? 'code');

  // UndoManager из Yjs, а не встроенный в CodeMirror: он отменяет только
  // свои правки и не трогает то, что написал собеседник.
  const undoManager = new Y.UndoManager(ytext);

  const language = new Compartment();

  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        indentUnit.of('    '),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        language.of(LANGS[opts.language ?? 'cpp']()),
        oneDark,
        // Синхронизация текста и отрисовка чужих курсоров и выделений.
        yCollab(ytext, awareness, { undoManager }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px' },
          '.cm-scroller': { fontFamily: 'IBM Plex Mono, ui-monospace, monospace' },
        }),
      ],
    }),
  });

  return {
    setLanguage(lang: Language) {
      view.dispatch({ effects: language.reconfigure(LANGS[lang]()) });
    },
    getText() {
      return ytext.toString();
    },
    focus() {
      view.focus();
    },
    destroy() {
      undoManager.destroy();
      view.destroy();
    },
  };
}
