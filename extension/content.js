// ⌥Tab switcher that behaves like macOS ⌘Tab:
//   ⌥Tab (quick tap)       → jump straight to the previously used tab
//   hold ⌥, press Tab      → switcher appears; each Tab moves right
//   ⌥⇧Tab, ⌥`, ←          → move left          →  → move right
//   release ⌥ / Enter      → switch to the selected tab
//   Esc                    → cancel
//   Q or W (while open)    → close the selected tab
//   hover / click          → select / switch with the mouse
(() => {
  'use strict';

  const TEARDOWN_EVENT = 'option-tab-switcher:teardown';
  const SHOW_DELAY_MS = 150; // quick taps switch without flashing the UI, like ⌘Tab
  const isTop = window === window.top;

  // A reloaded/updated extension leaves its previous content script orphaned in
  // open pages; tell it to remove its listeners before we add ours.
  document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT));

  const cleanups = [];
  function listen(target, type, fn, opts = true) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function teardown() {
    if (active) end();
    while (cleanups.length) cleanups.pop()();
    host?.remove();
  }

  function send(msg) {
    if (!alive()) {
      teardown();
      return Promise.resolve(null);
    }
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      teardown();
      return Promise.resolve(null);
    }
  }

  function pick(e) {
    return {
      type: e.type,
      code: e.code,
      key: e.key,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
    };
  }

  function isSwitchKey(k) {
    return k.code === 'Tab' && k.altKey && !k.metaKey && !k.ctrlKey;
  }

  // ---------------------------------------------------------------- state

  let active = false;
  let index = 0;
  let tabs = null; // null until the MRU list arrives from the background
  let shown = false;
  let showTimer = 0;
  let sessionId = 0;

  function wrap(i) {
    const n = tabs.length;
    return ((i % n) + n) % n;
  }

  function start(backwards) {
    const id = ++sessionId;
    active = true;
    shown = false;
    tabs = null;
    index = backwards ? -1 : 1;
    showTimer = setTimeout(() => {
      if (!active || id !== sessionId) return;
      shown = true;
      render();
    }, SHOW_DELAY_MS);
    send({ type: 'getTabs' }).then((res) => {
      if (!active || id !== sessionId) return;
      tabs = Array.isArray(res?.tabs) ? res.tabs : [];
      index = tabs.length ? wrap(index) : 0;
      render();
    });
  }

  function step(delta) {
    index += delta;
    if (tabs?.length) index = wrap(index);
    render();
  }

  function select(i) {
    if (i === index) return;
    index = i;
    render();
  }

  function commit() {
    if (!active) return;
    const list = tabs;
    const i = index;
    end();
    if (!list) send({ type: 'activateIndex', index: i });
    else if (list.length > 1 && i !== 0) send({ type: 'activate', tabId: list[i].id });
  }

  function end() {
    active = false;
    shown = false;
    clearTimeout(showTimer);
    hideUi();
  }

  function closeSelected() {
    if (!tabs?.length) return;
    const [tab] = tabs.splice(index, 1);
    send({ type: 'close', tabId: tab.id });
    if (!tabs.length) {
      end();
      return;
    }
    if (index >= tabs.length) index = tabs.length - 1;
    builtFor = null;
    render();
  }

  // Returns true when the key was handled by the switcher and must not reach the page.
  function handleKey(k) {
    if (k.type === 'keydown') {
      if (isSwitchKey(k)) {
        if (active) step(k.shiftKey ? -1 : 1);
        else start(k.shiftKey);
        return true;
      }
      if (!active) return false;
      if (!k.altKey) {
        // ⌥ was released somewhere we couldn't see it.
        commit();
        return false;
      }
      switch (k.code) {
        case 'Escape':
          end();
          break;
        case 'ArrowRight':
          step(1);
          break;
        case 'ArrowLeft':
        case 'Backquote':
          step(-1);
          break;
        case 'Enter':
          commit();
          break;
        case 'KeyQ':
        case 'KeyW':
          closeSelected();
          break;
      }
      return true; // swallow everything else while the switcher is up
    }

    if (k.type === 'keyup') {
      if (!active) return false;
      if (k.key === 'Alt' || !k.altKey) commit();
      return true;
    }
    return false;
  }

  // Sub-frames don't own any UI: they forward the keys to the top frame
  // (via the background worker) for as long as ⌥ stays down.
  let forwarding = false;
  function forwardKey(k) {
    if (k.type === 'keydown' && isSwitchKey(k)) forwarding = true;
    if (!forwarding) return false;
    send({ type: 'relay', event: k });
    if (k.type === 'keyup' && (k.key === 'Alt' || !k.altKey)) {
      forwarding = false;
      return true;
    }
    if (k.type === 'keydown' && !k.altKey) {
      forwarding = false;
      return false;
    }
    return true;
  }

  function onKey(e) {
    if (!alive()) {
      teardown();
      return;
    }
    const k = pick(e);
    const consumed = isTop ? handleKey(k) : forwardKey(k);
    if (consumed) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  // ---------------------------------------------------------------- UI

  const STYLE = `
    .wrap {
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      pointer-events: none;
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .panel {
      --bg: rgba(236, 236, 236, 0.72);
      --fg: #1d1d1f;
      --sel: rgba(0, 0, 0, 0.11);
      --edge: rgba(0, 0, 0, 0.12);
      --icon-bg: #ffffff;
      pointer-events: auto;
      box-sizing: border-box;
      max-width: 92vw; max-height: 86vh;
      overflow-y: auto;
      padding: 14px;
      border-radius: 28px;
      background: var(--bg);
      color: var(--fg);
      backdrop-filter: blur(40px) saturate(180%);
      -webkit-backdrop-filter: blur(40px) saturate(180%);
      box-shadow: 0 0 0 0.5px var(--edge), 0 24px 70px rgba(0, 0, 0, 0.35);
      scrollbar-width: none;
      cursor: default;
      user-select: none;
    }
    @media (prefers-color-scheme: dark) {
      .panel {
        --bg: rgba(38, 38, 40, 0.62);
        --fg: #f5f5f7;
        --sel: rgba(255, 255, 255, 0.17);
        --edge: rgba(255, 255, 255, 0.2);
        --icon-bg: rgba(255, 255, 255, 0.92);
      }
    }
    .row {
      display: flex; flex-wrap: wrap; justify-content: center; gap: 4px;
    }
    .tile {
      box-sizing: border-box;
      width: var(--tile);
      padding: 10px 6px 8px;
      border-radius: 18px;
      display: flex; flex-direction: column; align-items: center; gap: 8px;
    }
    .tile.sel { background: var(--sel); }
    .icon {
      width: var(--icon); height: var(--icon);
      border-radius: 22%;
      background: var(--icon-bg);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
    }
    .icon img { width: 58%; height: 58%; object-fit: contain; }
    .icon.letter {
      color: #fff;
      font-weight: 600;
      font-size: calc(var(--icon) * 0.45);
    }
    .name {
      width: 100%;
      font-size: 11px;
      text-align: center;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      word-break: break-word;
      opacity: 0.85;
    }
    .label {
      margin: 10px auto 0;
      max-width: 70ch;
      text-align: center;
    }
    .label .title {
      font-size: 13px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .label .host {
      font-size: 11px; opacity: 0.6;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
  `;

  let host = null;
  let panel, row, labelTitle, labelHost;
  let builtFor = null;
  let pointer = null; // last pointer position seen while the switcher is up

  function ensureUi() {
    if (!host) {
      host = document.createElement('option-tab-switcher');
      host.setAttribute(
        'style',
        'all: initial !important; position: fixed !important; inset: 0 !important; ' +
          'z-index: 2147483647 !important; pointer-events: none !important; display: block !important;',
      );
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `<style>${STYLE}</style>
        <div class="wrap"><div class="panel">
          <div class="row"></div>
          <div class="label"><div class="title"></div><div class="host"></div></div>
        </div></div>`;
      panel = shadow.querySelector('.panel');
      row = shadow.querySelector('.row');
      labelTitle = shadow.querySelector('.title');
      labelHost = shadow.querySelector('.host');

      panel.addEventListener('mousemove', (e) => {
        // Chrome can emit a mousemove when the panel appears under a resting
        // cursor; only a real movement should change the selection (as in ⌘Tab).
        const moved = pointer && (pointer.x !== e.screenX || pointer.y !== e.screenY);
        pointer = { x: e.screenX, y: e.screenY };
        const tile = e.target.closest?.('.tile');
        if (moved && tile) select(Number(tile.dataset.i));
      });
      panel.addEventListener('mousedown', (e) => e.preventDefault());
      panel.addEventListener('click', (e) => {
        const tile = e.target.closest?.('.tile');
        if (!tile) return;
        index = Number(tile.dataset.i);
        commit();
      });
    }
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  }

  function hideUi() {
    host?.remove();
    builtFor = null;
    pointer = null;
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      return u.host ? `${u.protocol.startsWith('http') ? '' : u.protocol + '//'}${u.host}` : u.href;
    } catch {
      return url || '';
    }
  }

  function colorFor(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return `hsl(${h % 360} 55% 48%)`;
  }

  function buildTile(tab, i) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.i = String(i);

    const icon = document.createElement('div');
    icon.className = 'icon';
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = tab.favicon;
    img.onerror = () => {
      const h = hostOf(tab.url) || tab.title;
      img.remove();
      icon.classList.add('letter');
      icon.style.background = colorFor(h);
      icon.textContent = (h.replace(/^www\./, '')[0] || '?').toUpperCase();
    };
    icon.append(img);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = tab.title;

    tile.append(icon, name);
    return tile;
  }

  function build() {
    const n = tabs.length;
    const maxWidth = Math.min(window.innerWidth * 0.92, 1400) - 32;
    const tile = Math.max(76, Math.min(112, Math.floor(maxWidth / n) - 4));
    panel.style.setProperty('--tile', `${tile}px`);
    panel.style.setProperty('--icon', `${Math.round(tile * 0.58)}px`);
    row.replaceChildren(...tabs.map(buildTile));
    builtFor = tabs;
  }

  function render() {
    if (!active || !shown || !tabs?.length) return;
    ensureUi();
    if (builtFor !== tabs) build();
    const tiles = row.children;
    for (let i = 0; i < tiles.length; i++) tiles[i].classList.toggle('sel', i === index);
    const tab = tabs[index];
    labelTitle.textContent = tab.title;
    labelHost.textContent = hostOf(tab.url);
    tiles[index]?.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- wiring

  listen(document, TEARDOWN_EVENT, teardown, false);
  listen(window, 'keydown', onKey);
  listen(window, 'keyup', onKey);

  if (isTop) {
    const onRelay = (msg) => {
      if (msg?.type === 'relay' && msg.event) handleKey(msg.event);
    };
    chrome.runtime.onMessage.addListener(onRelay);
    cleanups.push(() => {
      try {
        chrome.runtime.onMessage.removeListener(onRelay);
      } catch {}
    });

    listen(window, 'mousemove', (e) => {
      if (active && !e.altKey) commit();
    });
    listen(window, 'blur', () => {
      // Focus moving into an iframe of this page is fine; leaving the page cancels.
      setTimeout(() => {
        if (active && !document.hasFocus()) end();
      }, 0);
    });
    listen(document, 'visibilitychange', () => {
      if (active && document.hidden) end();
    });
    listen(window, 'resize', () => {
      if (active && shown) {
        builtFor = null;
        render();
      }
    });
  } else {
    listen(window, 'blur', () => {
      forwarding = false;
    });
  }
})();
