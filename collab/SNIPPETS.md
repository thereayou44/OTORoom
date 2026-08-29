# Что вставить в существующие файлы

Три вставки: разметка, стили, связка в `app.js`. Порядок любой.

---

## 1. `room.html`

### 1.1 Панели контента — внутрь `<main class="stage">`, сразу после `tileScreen`

```html
    <div class="tile" id="tileEditor" hidden>
      <div class="pane">
        <div class="pane__bar">
          <span class="pane__title">Редактор</span>
          <select class="pane__select" id="editorLang" aria-label="Язык">
            <option value="cpp">C++</option>
            <option value="python">Python</option>
          </select>
          <button class="pane__close" id="editorClose" aria-label="Закрыть">×</button>
        </div>
        <div class="pane__body" id="editorHost"></div>
      </div>
    </div>

    <div class="tile" id="tileBoard" hidden>
      <div class="pane">
        <div class="pane__bar">
          <span class="pane__title">Доска</span>

          <div class="tools" id="boardTools">
            <button class="tool" data-tool="pen" aria-pressed="true" title="Карандаш">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5l4 4L7 21H3v-4z"/></svg>
            </button>
            <button class="tool" data-tool="line" aria-pressed="false" title="Линия">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 20L20 4"/></svg>
            </button>
            <button class="tool" data-tool="arrow" aria-pressed="false" title="Стрелка">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L20 4M20 4h-7M20 4v7"/></svg>
            </button>
            <button class="tool" data-tool="rect" aria-pressed="false" title="Прямоугольник">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/></svg>
            </button>
            <button class="tool" data-tool="ellipse" aria-pressed="false" title="Эллипс">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="12" cy="12" rx="8.5" ry="6.5"/></svg>
            </button>
            <button class="tool" data-tool="text" aria-pressed="false" title="Текст">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 6h14M12 6v13M9 19h6"/></svg>
            </button>
            <button class="tool" data-tool="eraser" aria-pressed="false" title="Ластик">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20H5l-2-2 11-11 6 6-7 7z"/><path d="M20 20h-8"/></svg>
            </button>

            <span class="tools__sep"></span>

            <div class="swatches" id="boardColors">
              <button class="swatch" data-color="#e9f1fb" style="--c:#e9f1fb" aria-pressed="true" title="Белый"></button>
              <button class="swatch" data-color="#6fc3f7" style="--c:#6fc3f7" aria-pressed="false" title="Голубой"></button>
              <button class="swatch" data-color="#7ee0a8" style="--c:#7ee0a8" aria-pressed="false" title="Зелёный"></button>
              <button class="swatch" data-color="#f2b24c" style="--c:#f2b24c" aria-pressed="false" title="Жёлтый"></button>
              <button class="swatch" data-color="#ff6b5b" style="--c:#ff6b5b" aria-pressed="false" title="Красный"></button>
              <button class="swatch" data-color="#c39cf0" style="--c:#c39cf0" aria-pressed="false" title="Фиолетовый"></button>
            </div>

            <input class="tools__width" id="boardWidth" type="range" min="1" max="14" value="3" aria-label="Толщина">

            <span class="tools__sep"></span>

            <button class="tool" id="boardUndo" title="Отменить">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>
            </button>
            <button class="tool" id="boardRedo" title="Вернуть">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>
            </button>
            <button class="tool tool--danger" id="boardClear" title="Очистить всё">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
            </button>
          </div>

          <button class="pane__close" id="boardClose" aria-label="Закрыть">×</button>
        </div>
        <div class="pane__body" id="boardHost"></div>
      </div>
    </div>
```

### 1.2 Пункты меню — заменить два `disabled`-пункта («Доска», «Редактор кода»)

```html
        <button class="menu__item" id="miBoard" role="menuitem" data-on="false">
          <span class="menu__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 17.5c3-1 3.5-9 6.5-9s2 7 5 7 3.5-6 6.5-6"/>
            </svg>
          </span>
          <span class="menu__body">
            <span class="menu__label">Доска</span>
          </span>
        </button>

        <button class="menu__item" id="miEditor" role="menuitem" data-on="false">
          <span class="menu__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8.5 8.5L5 12l3.5 3.5M15.5 8.5L19 12l-3.5 3.5M13.5 5l-3 14"/>
            </svg>
          </span>
          <span class="menu__body">
            <span class="menu__label">Редактор кода</span>
          </span>
        </button>
```

### 1.3 Подключение бандла — перед `<script src="app.js">`

```html
<script src="oto-collab.js"></script>
<script src="app.js"></script>
```

---

## 2. `style.css` — добавить в конец

```css
.pane {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
  background: var(--bp-900);
}

.pane__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  background: rgba(20, 34, 56, .55);
  flex-wrap: wrap;
}

.pane__title {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--chalk-faint);
}

.pane__select {
  padding: 5px 9px;
  background: var(--bp-900);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--chalk-dim);
  appearance: none;
}

.pane__close {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--chalk-faint);
  font-size: 20px;
  line-height: 1;
  padding: 2px 8px;
}

.pane__close:hover { color: var(--chalk); }

.pane__body { overflow: hidden; position: relative; min-height: 0; }
.pane__body .cm-editor { height: 100%; }

.tools { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }

.tool {
  width: 30px; height: 30px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--chalk-faint);
  transition: background .15s, color .15s, border-color .15s;
}

.tool:hover { background: rgba(255, 255, 255, .06); color: var(--chalk); }

.tool[aria-pressed="true"] {
  background: rgba(111, 195, 247, .16);
  border-color: rgba(111, 195, 247, .4);
  color: var(--link);
}

.tool svg { width: 16px; height: 16px; }
.tool--danger:hover { background: rgba(255, 107, 91, .16); color: var(--pencil); }

.tools__sep {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--line-strong);
}

.swatches { display: flex; gap: 3px; }

.swatch {
  width: 20px; height: 20px;
  border-radius: 50%;
  border: 2px solid transparent;
  background: var(--c);
  transition: transform .12s, border-color .15s;
}

.swatch:hover { transform: scale(1.12); }
.swatch[aria-pressed="true"] { border-color: var(--chalk); }

.tools__width {
  width: 78px;
  accent-color: var(--link);
  background: transparent;
}

@media (max-width: 900px) {
  .pane__title { display: none; }
  .tools__width { width: 54px; }
}
```

---

## 3. `app.js` — связка

### 3.1 Элементы — добавить в объект `el`

```js
    tileEditor: $('tileEditor'), tileBoard: $('tileBoard'),
    editorHost: $('editorHost'), boardHost: $('boardHost'),
    editorLang: $('editorLang'), editorClose: $('editorClose'),
    boardClose: $('boardClose'), boardTools: $('boardTools'),
    boardColors: $('boardColors'), boardWidth: $('boardWidth'),
    boardUndo: $('boardUndo'), boardRedo: $('boardRedo'), boardClear: $('boardClear'),
    miBoard: $('miBoard'), miEditor: $('miEditor'),
```

### 3.2 Состояние — рядом с `let screenStream = null;`

```js
  let collab = null, editor = null, board = null;
  let pane = null;
```

### 3.3 Канал совместной работы — в `ensurePeer`, где создаются каналы

Заменить блок создания каналов на:

```js
    if (initiator) {
      wireMeta(pc.createDataChannel('meta'));
      wireChat(pc.createDataChannel('chat'));
      wireCollab(pc.createDataChannel('collab', { ordered: true }));
    }
    pc.addEventListener('datachannel', (e) => {
      if (e.channel.label === 'meta') wireMeta(e.channel);
      if (e.channel.label === 'chat') wireChat(e.channel);
      if (e.channel.label === 'collab') wireCollab(e.channel);
    });
```

### 3.4 Функции — вставить рядом с `wireChat`

```js
  function wireCollab(ch) {
    if (!window.OTO) { trace('модуль совместной работы не загрузился', 'err'); return; }

    collab = window.OTO.createCollab(ch, {
      name: initiator ? 'Инициатор' : 'Участник',
      color: initiator ? '#6fc3f7' : '#f2b24c',
    });

    ch.addEventListener('open', () => trace('канал совместной работы открыт', 'ok'));
  }

  function openPane(which) {
    if (!collab && which) {
      banner('Редактор и доска заработают, когда подключится второй участник.');
      return;
    }

    if (pane === which) which = null;
    pane = which;

    el.tileEditor.hidden = which !== 'editor';
    el.tileBoard.hidden = which !== 'board';
    setMenuItem(el.miEditor, which === 'editor');
    setMenuItem(el.miBoard, which === 'board');

    if (which === 'editor' && !editor) {
      editor = collab.mountEditor(el.editorHost, el.editorLang.value);
    }
    if (which === 'board' && !board) {
      board = collab.mountBoard(el.boardHost);
      board.setColor(el.boardColors.querySelector('[aria-pressed="true"]').dataset.color);
      board.setWidth(Number(el.boardWidth.value));
    }

    applyLayout();
    if (which === 'editor' && editor) setTimeout(() => editor.focus(), 50);
  }
```

### 3.5 `applyLayout` — заменить целиком

```js
  function applyLayout() {
    const mine = isSharing();
    const theirs = remoteScreen && !mine;
    const content = pane === 'editor' ? el.tileEditor : pane === 'board' ? el.tileBoard : null;

    el.tileScreen.hidden = !mine;
    el.tileEditor.hidden = pane !== 'editor';
    el.tileBoard.hidden = pane !== 'board';

    if (content) {
      // Редактор и доска важнее показа экрана: если открыты, занимают главное место.
      el.stage.dataset.layout = 'split';
      content.className = 'tile tile--main';
      el.tileRemote.className = 'tile tile--railA';
      el.tileSelf.className = 'tile tile--self tile--railB';
      if (mine) el.tileScreen.hidden = true;
    } else if (mine) {
      el.stage.dataset.layout = 'split';
      el.tileScreen.className = 'tile tile--main';
      el.tileRemote.className = 'tile tile--railA';
      el.tileSelf.className = 'tile tile--self tile--railB';
    } else if (theirs) {
      el.stage.dataset.layout = 'split';
      el.tileRemote.className = 'tile tile--main';
      el.tileSelf.className = 'tile tile--self tile--railA';
    } else {
      el.stage.dataset.layout = 'solo';
      el.tileRemote.className = 'tile tile--main';
      el.tileSelf.className = 'tile tile--self';
    }

    el.sharingTag.hidden = !theirs;
  }
```

### 3.6 Обработчики — рядом с обработчиками меню

```js
  el.miEditor.addEventListener('click', () => { openMenu(false); openPane('editor'); });
  el.miBoard.addEventListener('click', () => { openMenu(false); openPane('board'); });
  el.editorClose.addEventListener('click', () => openPane(null));
  el.boardClose.addEventListener('click', () => openPane(null));

  el.editorLang.addEventListener('change', () => {
    if (editor) editor.setLanguage(el.editorLang.value);
  });

  el.boardTools.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool[data-tool]');
    if (!btn || !board) return;
    el.boardTools.querySelectorAll('.tool[data-tool]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    board.setTool(btn.dataset.tool);
  });

  el.boardColors.addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (!btn || !board) return;
    el.boardColors.querySelectorAll('.swatch')
      .forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    board.setColor(btn.dataset.color);
  });

  el.boardWidth.addEventListener('input', () => {
    if (board) board.setWidth(Number(el.boardWidth.value));
  });

  el.boardUndo.addEventListener('click', () => board && board.undo());
  el.boardRedo.addEventListener('click', () => board && board.redo());
  el.boardClear.addEventListener('click', () => {
    if (board && confirm('Очистить доску у обоих участников?')) board.clear();
  });
```

### 3.7 Очистка — в `teardownPeer`, рядом со сбросом `meta` и `chat`

```js
    if (collab) { collab.destroy(); collab = null; }
    editor = null;
    board = null;
    pane = null;
    el.tileEditor.hidden = true;
    el.tileBoard.hidden = true;
    setMenuItem(el.miEditor, false);
    setMenuItem(el.miBoard, false);
```
