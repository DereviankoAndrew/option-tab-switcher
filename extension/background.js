// Keeps every tab in most-recently-used order (across all windows, like ⌘Tab
// does for apps) and performs the switching on behalf of the content script.

let mru = null; // tab ids, most recently used first
let queue = Promise.resolve();

// MV3 service workers get suspended, so the order is persisted in session
// storage and every mutation is serialized through one promise chain.
function withMru(fn) {
  const run = queue.then(async () => {
    if (!mru) mru = await loadMru();
    const result = await fn(mru);
    chrome.storage.session.set({ mru });
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

async function loadMru() {
  const [{ mru: saved = [] }, tabs] = await Promise.all([
    chrome.storage.session.get('mru'),
    chrome.tabs.query({}),
  ]);
  const existing = new Set(tabs.map((t) => t.id));
  const list = saved.filter((id) => existing.has(id));
  const known = new Set(list);
  const rest = tabs
    .filter((t) => !known.has(t.id))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .map((t) => t.id);
  return list.concat(rest);
}

function touch(list, tabId) {
  const i = list.indexOf(tabId);
  if (i !== -1) list.splice(i, 1);
  list.unshift(tabId);
}

function forget(list, tabId) {
  const i = list.indexOf(tabId);
  if (i !== -1) list.splice(i, 1);
}

function faviconUrl(pageUrl) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl || 'about:blank');
  url.searchParams.set('size', '64');
  return url.toString();
}

async function switchTo(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function getTabs(sender) {
  const order = await withMru((list) => {
    if (sender.tab) touch(list, sender.tab.id);
    return list.slice();
  });
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  const seen = new Set(order);
  for (const t of tabs) if (!seen.has(t.id)) ordered.push(t);
  return ordered.map((t) => {
    const url = t.url || t.pendingUrl || '';
    return { id: t.id, title: t.title || url || 'Untitled', url, favicon: faviconUrl(url) };
  });
}

async function activateIndex(index, sender) {
  const tabId = await withMru((list) => {
    if (sender.tab) touch(list, sender.tab.id);
    const n = list.length;
    if (n < 2) return null;
    const i = ((index % n) + n) % n;
    return i === 0 ? null : list[i];
  });
  if (tabId != null) await switchTo(tabId);
}

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case 'getTabs':
      return { tabs: await getTabs(sender) };
    case 'activate':
      return switchTo(msg.tabId);
    case 'activateIndex':
      return activateIndex(msg.index, sender);
    case 'close':
      return chrome.tabs.remove(msg.tabId).catch(() => {});
    case 'relay':
      // Keys pressed while focus is inside an iframe are forwarded to the
      // top frame, which owns the switcher UI.
      if (sender.tab) {
        return chrome.tabs
          .sendMessage(sender.tab.id, { type: 'relay', event: msg.event }, { frameId: 0 })
          .catch(() => {});
      }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(
    (result) => sendResponse(result ?? null),
    () => sendResponse(null),
  );
  return true;
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // A tab that becomes active in a background window (e.g. its neighbour was
  // closed) hasn't been "used"; onFocusChanged will pick it up if it ever is.
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (win && !win.focused) return;
  withMru((list) => touch(list, tabId));
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) withMru((list) => touch(list, tab.id));
});

chrome.tabs.onCreated.addListener((tab) => {
  // Never-used tabs (e.g. opened in the background) go to the end of the list.
  withMru((list) => {
    if (!list.includes(tab.id)) list.push(tab.id);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withMru((list) => forget(list, tabId));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  withMru((list) => {
    forget(list, addedTabId);
    const i = list.indexOf(removedTabId);
    if (i !== -1) list[i] = addedTabId;
    else list.push(addedTabId);
  });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'switch-to-previous-tab') return;
  const tabId = await withMru((list) => {
    if (tab) touch(list, tab.id);
    return list[1] ?? null;
  });
  if (tabId != null) switchTo(tabId);
});

// Tabs that were already open when the extension was installed or reloaded
// don't have the content script yet, so inject it into them.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!/^(https?|file):/.test(tab.url || '')) continue;
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
      .catch(() => {});
  }
});
