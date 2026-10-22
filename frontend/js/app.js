/* ============================================================
 * app.js — Shoolwork Proxy main UI controller
 *
 * Wires up:
 *   - Top chrome nav (Home / Proxy / Settings / Drive Sync)
 *   - Hero clock on new-tab page
 *   - Search bar → resolves URL or search query, opens in proxy tab
 *   - Favorites grid + recent history (localStorage-backed)
 *   - Bookmarks bar (add/remove, persists to localStorage)
 *   - Tabs (multi-tab proxied browsing via iframes)
 *   - Address bar → encode URL through Ultraviolet
 *   - DevTools panel (requests / storage / metrics)
 *
 * Ultraviolet is loaded globally as `uv` (from uv.config.js +
 * uv.bundle.js). We register the service worker on first proxy
 * navigation, then open tabs by pointing iframes at
 *   `${uv.prefix}${uv.encodeUrl(url)}`
 * ============================================================ */

import { initSettingsUI, loadSettings, saveSettings, applySettings } from './settings.js';
import { initSyncUI, refreshAuthState } from './sync.js';

const SEARCH_ENGINES = {
  brave: 'https://search.brave.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
};

const FAVORITES_DEFAULT = [
  { label: 'YouTube', url: 'https://www.youtube.com', icon: '▶' },
  { label: 'Reddit', url: 'https://www.reddit.com', icon: 'r' },
  { label: 'Wikipedia', url: 'https://wikipedia.org', icon: 'W' },
  { label: 'GitHub', url: 'https://github.com', icon: '⌥' },
  { label: 'Spotify', url: 'https://open.spotify.com', icon: '♫' },
  { label: 'Twitch', url: 'https://twitch.tv', icon: '▸' },
  { label: 'Discord', url: 'https://discord.com', icon: '⌘' },
  { label: 'Poki', url: 'https://poki.com', icon: 'P' },
];

const RECENT_KEY = 'shoolwork:recent';
const BOOKMARKS_KEY = 'shoolwork:bookmarks';
const TABS_KEY = 'shoolwork:tabs';

let tabs = [];          // { id, url, title, favicon, history: [], historyIdx }
let activeTabId = null;
let swReady = false;

/* ---------- Bootstrap ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  // Access control: check BEFORE initializing other UI — if access is denied,
  // we don't want to render the proxy UI behind the gate.
  // Use the window globals (set by inline-script build) instead of dynamic import.
  const Access = window.ShoolworkAccess || {};
  if (Access.initAccess) await Access.initAccess();

  initSettingsUI();
  initSyncUI();
  initChrome();
  initBookmarks();
  initFavorites();
  initSearch();
  initClock();
  initProxyView();
  initExtensionsUI();
  initCloakPresets();
  initAboutBlankButton();
  initKeyboardShortcuts();
  refreshAuthState();

  // Admin panel is NOT part of the public frontend.
  // Hosts manage the proxy from a standalone admin.html file that
  // calls the backend API directly. See backend/admin/admin.html.
});

/* ---------- Extensions view ---------- */
function initExtensionsUI() {
  const dropZone = document.getElementById('extDropZone');
  const fileInput = document.getElementById('extFileInput');
  if (!dropZone || !fileInput) return;

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('is-dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('is-dragover');
    handleExtensionFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => handleExtensionFiles(fileInput.files));

  // Render existing extensions on first load
  renderExtensionList();

  // Listen for messages from the SW asking for injectables for a URL
  navigator.serviceWorker?.addEventListener('message', async (e) => {
    if (e.data?.type === 'shoolwork:get-injectables' && e.ports?.[0]) {
      try {
        const ext = window.ShoolworkExtensions || {};
        const injectables = ext.getInjectablesForUrl ? await ext.getInjectablesForUrl(e.data.url) : { scripts: [], css: [] };
        e.ports[0].postMessage(injectables);
      } catch (err) {
        e.ports[0].postMessage({ scripts: [], css: [], error: err.message });
      }
    }
  });
}

async function handleExtensionFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  const ext = window.ShoolworkExtensions || {};
  if (!ext.installExtension) { toast('Extensions module not loaded', 'error'); return; }
  for (const file of files) {
    try {
      const result = await ext.installExtension(file);
      toast(`Installed: ${result.manifest.name} v${result.manifest.version}`, 'success');
    } catch (e) {
      toast(`Failed to install ${file.name}: ${e.message}`, 'error');
    }
  }
  renderExtensionList();
}

async function renderExtensionList() {
  const list = document.getElementById('extList');
  if (!list) return;
  try {
    const ext = window.ShoolworkExtensions || {};
    if (!ext.listExtensions) {
      list.innerHTML = '<div class="extensions__empty">Extensions module not loaded.</div>';
      return;
    }
    const extensions = await ext.listExtensions();
    if (!extensions.length) {
      list.innerHTML = '<div class="extensions__empty">No extensions installed yet.</div>';
      return;
    }
    list.innerHTML = extensions.map(e => `
      <div class="ext-card" data-id="${e.id}">
        <div class="ext-card__head">
          <div class="ext-card__info">
            <strong>${escapeHtml(e.manifest.name || e.id)}</strong>
            <span class="ext-card__version">v${escapeHtml(e.manifest.version || '?')}</span>
          </div>
          <div class="ext-card__actions">
            <label class="ext-card__toggle">
              <input type="checkbox" ${e.enabled ? 'checked' : ''} data-id="${e.id}" />
              <span>${e.enabled ? 'Enabled' : 'Disabled'}</span>
            </label>
            <button class="btn btn--ghost" data-remove="${e.id}">Remove</button>
          </div>
        </div>
        <div class="ext-card__meta">
          <span><strong>Installed:</strong> ${new Date(e.installedAt).toLocaleString()}</span>
          <span><strong>Scripts:</strong> ${(e.manifest.content_scripts || []).length}</span>
          <span><strong>Matches:</strong> ${(e.manifest.content_scripts || []).flatMap(cs => cs.matches || []).length}</span>
        </div>
      </div>
    `).join('');
    // Wire toggle + remove
    list.querySelectorAll('input[type="checkbox"][data-id]').forEach(chk => {
      chk.addEventListener('change', async () => {
        const ext2 = window.ShoolworkExtensions || {};
        if (ext2.setExtensionEnabled) await ext2.setExtensionEnabled(chk.dataset.id, chk.checked);
        renderExtensionList();
      });
    });
    list.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this extension?')) return;
        const ext2 = window.ShoolworkExtensions || {};
        if (ext2.removeExtension) await ext2.removeExtension(btn.dataset.remove);
        renderExtensionList();
        toast('Extension removed', 'info');
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="extensions__empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

/* ---------- Cloak presets ---------- */
function initCloakPresets() {
  const presetContainer = document.getElementById('cloakPresets');
  if (!presetContainer) return;
  presetContainer.querySelectorAll('.cloak-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const title = btn.dataset.title || '';
      const favicon = btn.dataset.favicon || '';
      // Save to settings (triggers applySettings → applyCloak)
      const { saveSettings } = window.__shoolworkSettings || {};
      if (saveSettings) {
        saveSettings({ cloakTitle: title, cloakFavicon: favicon });
      } else {
        // Fallback if settings module not loaded yet
        try {
          const cur = JSON.parse(localStorage.getItem('shoolwork:settings') || '{}');
          cur.cloakTitle = title;
          cur.cloakFavicon = favicon;
          localStorage.setItem('shoolwork:settings', JSON.stringify(cur));
        } catch {}
        document.title = title || 'Shoolwork Proxy';
      }
      toast(title ? `Cloaked as "${title}"` : 'Cloak reset', 'info');
    });
  });
}

/* ---------- About:blank cloak ---------- */
function initAboutBlankButton() {
  const btn = document.getElementById('aboutBlankBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    // Open about:blank, then write our current document into it via document.write.
    // This makes the address bar show "about:blank" — obscures the proxy URL
    // from anyone glancing at the browser tab/title bar.
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      toast('Popup blocked. Allow popups for this site to use about:blank cloak.', 'error');
      return;
    }
    // Write the current page's HTML into the popup
    const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    toast('Opened in about:blank — close this tab if you want.', 'success');
  });
}

/* ---------- Top chrome nav ---------- */
function initChrome() {
  document.querySelectorAll('.chrome__nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.chrome__nav-btn').forEach(b => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-' + view));
    });
  });
}

/* ---------- Clock ---------- */
function initClock() {
  const s = loadSettings();
  const tick = () => {
    const now = new Date();
    const time = document.getElementById('heroTime');
    const date = document.getElementById('heroDate');
    if (time) {
      let h = now.getHours();
      const m = String(now.getMinutes()).padStart(2, '0');
      const sec = String(now.getSeconds()).padStart(2, '0');
      let str;
      if (s.clock24h) {
        str = `${String(h).padStart(2, '0')}:${m}`;
        if (s.showSeconds) str += ':' + sec;
      } else {
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        str = `${h}:${m}`;
        if (s.showSeconds) str += ':' + sec;
        str += ' ' + ampm;
      }
      time.textContent = str;
    }
    if (date) {
      date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    }
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- Search ---------- */
function initSearch() {
  const form = document.getElementById('searchForm');
  const input = document.getElementById('searchInput');
  const engineSel = document.getElementById('searchEngine');

  const s = loadSettings();
  if (engineSel && s.searchEngine) engineSel.value = s.searchEngine;
  if (engineSel) engineSel.addEventListener('change', () => saveSettings({ searchEngine: engineSel.value }));

  if (form) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const q = (input.value || '').trim();
      if (!q) return;
      openInProxy(resolveQuery(q, engineSel.value));
      addRecent(q);
      input.value = '';
    });
  }
}

function resolveQuery(q, engineKey) {
  // If it has a scheme, treat as URL
  if (/^https?:\/\//i.test(q)) return q;
  // If it looks like a domain (no spaces, has a dot)
  if (!/\s/.test(q) && /\.[a-z]{2,}$/i.test(q)) return 'https://' + q;
  // Else search
  const engine = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES.brave;
  return engine + encodeURIComponent(q);
}

/* ---------- Favorites ---------- */
function initFavorites() {
  const grid = document.getElementById('favoritesGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const stored = JSON.parse(localStorage.getItem('shoolwork:favorites') || 'null') || FAVORITES_DEFAULT;
  for (const fav of stored) {
    const el = document.createElement('button');
    el.className = 'favorite';
    el.innerHTML = `
      <div class="favorite__icon">${getFaviconHTML(fav)}</div>
      <div class="favorite__label">${escapeHtml(fav.label)}</div>`;
    el.addEventListener('click', () => openInProxy(fav.url));
    grid.appendChild(el);
  }
}

function getFaviconHTML(fav) {
  try {
    const u = new URL(fav.url);
    return `<img src="https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${escapeHtml(fav.icon || fav.label[0])}'}))" />`;
  } catch {
    return escapeHtml(fav.icon || fav.label[0] || '?');
  }
}

/* ---------- Recent ---------- */
function addRecent(query) {
  const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  list.unshift({ query, time: Date.now() });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20)));
  renderRecent();
}
function renderRecent() {
  const ul = document.getElementById('recentList');
  if (!ul) return;
  const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  if (!list.length) { ul.innerHTML = '<li class="recent__empty">No recent activity yet.</li>'; return; }
  ul.innerHTML = list.map(r => `
    <li data-query="${escapeAttr(r.query)}">
      <span>${escapeHtml(r.query)}</span>
      <span class="recent__time">${new Date(r.time).toLocaleTimeString()}</span>
    </li>
  `).join('');
  ul.querySelectorAll('li[data-query]').forEach(li => {
    li.addEventListener('click', () => {
      const q = li.dataset.query;
      openInProxy(resolveQuery(q, loadSettings().searchEngine));
    });
  });
}

/* ---------- Bookmarks ---------- */
function initBookmarks() {
  const bar = document.getElementById('bookmarksBar');
  if (!bar) return;
  renderBookmarks();
  document.getElementById('bookmarkAdd')?.addEventListener('click', () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || !tab.url) { toast('Open a site first to bookmark it.', 'info'); return; }
    const list = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]');
    if (list.some(b => b.url === tab.url)) { toast('Already bookmarked', 'info'); return; }
    list.push({ url: tab.url, title: tab.title || tab.url });
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list));
    renderBookmarks();
  });
}
function renderBookmarks() {
  const list = document.getElementById('bookmarksList');
  if (!list) return;
  const bookmarks = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]');
  list.innerHTML = bookmarks.map((b, i) => `
    <button class="bookmark" data-i="${i}">
      <span>${escapeHtml(b.title || b.url)}</span>
      <span class="bookmark__del" data-del="${i}">×</span>
    </button>
  `).join('');
  list.querySelectorAll('.bookmark').forEach(btn => {
    btn.addEventListener('click', e => {
      if (e.target.dataset.del !== undefined) {
        const i = Number(e.target.dataset.del);
        const arr = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]');
        arr.splice(i, 1);
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(arr));
        renderBookmarks();
      } else {
        const i = Number(btn.dataset.i);
        const arr = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]');
        if (arr[i]) openInProxy(arr[i].url);
      }
    });
  });
}

/* ---------- Proxy view + tabs ---------- */
function initProxyView() {
  document.getElementById('tabsNew')?.addEventListener('click', () => createTab());
  document.getElementById('navBack')?.addEventListener('click', () => navTab('back'));
  document.getElementById('navForward')?.addEventListener('click', () => navTab('forward'));
  document.getElementById('navReload')?.addEventListener('click', () => navTab('reload'));
  document.getElementById('navHome')?.addEventListener('click', () => {
    document.querySelectorAll('.chrome__nav-btn').forEach(b => b.classList.toggle('is-active', b.dataset.view === 'home'));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-home'));
  });
  document.getElementById('addressForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('addressInput');
    const q = (input.value || '').trim();
    if (!q) return;
    const url = resolveQuery(q, loadSettings().searchEngine);
    navigateActive(url);
  });
  document.getElementById('devtoolsToggle')?.addEventListener('click', () => {
    const dt = document.getElementById('devtools');
    dt.hidden = !dt.hidden;
  });
  document.querySelectorAll('.devtools__tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.devtools__tab').forEach(t => t.classList.toggle('is-active', t === tab));
      const key = tab.dataset.dt;
      ['dtRequests', 'dtStorage', 'dtMetrics'].forEach(id => {
        document.getElementById(id).hidden = (id !== 'dt' + key.charAt(0).toUpperCase() + key.slice(1));
      });
      refreshDevTools();
    });
  });
  // Restore tabs from previous session
  const stored = JSON.parse(localStorage.getItem(TABS_KEY) || '[]');
  if (stored.length) {
    stored.forEach(t => createTab(t.url, t.title, false));
  } else {
    createTab();
  }
}

async function ensureServiceWorker() {
  if (swReady) return true;
  if (!('serviceWorker' in navigator)) {
    toast('Service workers are not supported in this browser.', 'error');
    return false;
  }
  try {
    // SW registration URL + scope.
    // Normally computed from location.href (relative to this page).
    // But when loaded inside an about:blank popup, location.href = "about:blank"
    // which is invalid. The cloak launcher injects window.__SW_URL + __SW_SCOPE
    // with the correct absolute URLs (the launcher's own domain).
    const SW_URL = window.__SW_URL || new URL('sw.js', location.href).href;
    const SW_SCOPE = window.__SW_SCOPE || new URL('./', location.href).href;
    await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
    swReady = true;
    return true;
  } catch (e) {
    toast('Failed to register proxy service worker: ' + e.message, 'error');
    return false;
  }
}

async function openInProxy(url) {
  // Switch to proxy view
  document.querySelectorAll('.chrome__nav-btn').forEach(b => b.classList.toggle('is-active', b.dataset.view === 'proxy'));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-proxy'));
  // Find or create a tab for this URL
  let tab = tabs.find(t => t.url === url);
  if (!tab) tab = createTab(url);
  activateTab(tab.id);
  await ensureServiceWorker();
  await loadTabUrl(tab, url);
}

function createTab(url = null, title = 'New Tab', restore = false) {
  const id = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const tab = { id, url, title, history: url ? [url] : [], historyIdx: url ? 0 : -1 };
  tabs.push(tab);
  renderTabs();
  if (!restore) activateTab(id);
  return tab;
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  // Remove iframe
  const iframe = document.querySelector(`iframe[data-tab="${id}"]`);
  if (iframe) iframe.remove();
  tabs.splice(idx, 1);
  renderTabs();
  persistTabs();
  if (activeTabId === id) {
    const next = tabs[idx] || tabs[idx - 1];
    if (next) activateTab(next.id);
    else createTab();
  }
}

function activateTab(id) {
  activeTabId = id;
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('is-active', el.dataset.id === id));
  document.querySelectorAll('.proxy__frame-wrap iframe').forEach(f => f.style.display = f.dataset.tab === id ? 'block' : 'none');
  const splash = document.getElementById('proxySplash');
  const tab = tabs.find(t => t.id === id);
  if (splash) splash.style.display = (tab && tab.url) ? 'none' : 'flex';
  const input = document.getElementById('addressInput');
  if (input && tab) input.value = tab.url || '';
  refreshDevTools();
}

async function loadTabUrl(tab, url) {
  await ensureServiceWorker();
  if (!window.uv || !window.uv.prefix) {
    toast('Ultraviolet is not loaded yet', 'error');
    return;
  }
  const proxied = window.uv.prefix + window.uv.encodeUrl(url);
  let iframe = document.querySelector(`iframe[data-tab="${tab.id}"]`);
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.dataset.tab = tab.id;
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; gamepad; gyroscope; picture-in-picture');
    document.getElementById('frameWrap').appendChild(iframe);
  }
  // Hide splash
  const splash = document.getElementById('proxySplash');
  if (splash) splash.style.display = 'none';

  iframe.style.display = 'block';
  iframe.src = proxied;

  tab.url = url;
  tab.title = url;
  // Push history
  if (tab.history[tab.historyIdx] !== url) {
    tab.history = tab.history.slice(0, tab.historyIdx + 1);
    tab.history.push(url);
    tab.historyIdx = tab.history.length - 1;
  }
  renderTabs();
  persistTabs();

  // Listen for title updates (postMessage from SW is not directly available;
  // fall back to polling iframe.title periodically)
  let pollCount = 0;
  const titlePoll = setInterval(() => {
    pollCount++;
    try {
      if (iframe.contentDocument && iframe.contentDocument.title) {
        tab.title = iframe.contentDocument.title;
        renderTabs();
      }
    } catch { /* cross-origin */ }
    if (pollCount > 20) clearInterval(titlePoll);
  }, 500);

  // Log request in devtools
  logRequest('GET', url, 200);
}

function navigateActive(url) {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) { openInProxy(url); return; }
  loadTabUrl(tab, url);
}

function navTab(action) {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  if (action === 'back' && tab.historyIdx > 0) {
    tab.historyIdx--;
    loadTabUrl(tab, tab.history[tab.historyIdx]);
  } else if (action === 'forward' && tab.historyIdx < tab.history.length - 1) {
    tab.historyIdx++;
    loadTabUrl(tab, tab.history[tab.historyIdx]);
  } else if (action === 'reload') {
    if (tab.url) loadTabUrl(tab, tab.url);
  }
}

function renderTabs() {
  const strip = document.getElementById('tabsStrip');
  if (!strip) return;
  // Remove existing tab buttons (keep the "new tab" button)
  strip.querySelectorAll('.tab').forEach(el => el.remove());
  const newBtn = document.getElementById('tabsNew');
  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (t.id === activeTabId ? ' is-active' : '');
    btn.dataset.id = t.id;
    btn.innerHTML = `
      <span class="tab__favicon"></span>
      <span class="tab__title">${escapeHtml(t.title || 'New Tab')}</span>
      <span class="tab__close">×</span>
    `;
    btn.addEventListener('click', () => activateTab(t.id));
    btn.querySelector('.tab__close').addEventListener('click', e => {
      e.stopPropagation();
      closeTab(t.id);
    });
    strip.insertBefore(btn, newBtn);
  }
}

function persistTabs() {
  const minimal = tabs.map(t => ({ url: t.url, title: t.title }));
  localStorage.setItem(TABS_KEY, JSON.stringify(minimal));
}

/* ---------- DevTools ---------- */
function logRequest(method, url, status) {
  const panel = document.getElementById('dtRequests');
  if (!panel) return;
  const row = document.createElement('div');
  row.className = 'dt-request';
  row.innerHTML = `
    <span class="dt-request__method">${method}</span>
    <span class="dt-request__status ${status >= 400 ? 'is-error' : ''}">${status}</span>
    <span class="dt-request__url" title="${escapeAttr(url)}">${escapeHtml(url)}</span>
  `;
  panel.prepend(row);
  // Cap rows
  while (panel.children.length > 200) panel.lastChild.remove();
}

async function refreshDevTools() {
  const activeTab = document.querySelector('.devtools__tab.is-active');
  if (!activeTab) return;
  const key = activeTab.dataset.dt;
  if (key === 'storage') await renderStoragePanel();
  else if (key === 'metrics') await renderMetricsPanel();
}

async function renderStoragePanel() {
  const panel = document.getElementById('dtStorage');
  if (!panel) return;
  panel.innerHTML = '';
  const rows = [
    ['localStorage', Object.keys(localStorage).length],
    ['sessionStorage', Object.keys(sessionStorage).length],
    ['cookies', (document.cookie.match(/=/g) || []).length],
  ];
  let idbCount = '?';
  try {
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      idbCount = dbs.length;
    }
  } catch {}
  rows.push(['IndexedDB', idbCount]);
  let cacheCount = '?';
  try { if ('caches' in window) cacheCount = (await caches.keys()).length; } catch {}
  rows.push(['Cache API', cacheCount]);

  for (const [name, count] of rows) {
    const row = document.createElement('div');
    row.className = 'dt-storage-row';
    row.innerHTML = `<span>${name}</span><span></span><span>${count}</span>`;
    panel.appendChild(row);
  }
}

async function renderMetricsPanel() {
  const panel = document.getElementById('dtMetrics');
  if (!panel) return;
  panel.innerHTML = '';
  const metrics = [];
  if (performance.memory) {
    metrics.push(['Heap used', (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB']);
    metrics.push(['Heap total', (performance.memory.totalJSHeapSize / 1048576).toFixed(1) + ' MB']);
    metrics.push(['Heap limit', (performance.memory.jsHeapSizeLimit / 1048576).toFixed(1) + ' MB']);
  }
  const nav = performance.getEntriesByType('navigation')[0] || {};
  metrics.push(['DOM load', nav.domContentLoadedEventEnd ? nav.domContentLoadedEventEnd.toFixed(0) + ' ms' : '—']);
  metrics.push(['Page load', nav.loadEventEnd ? nav.loadEventEnd.toFixed(0) + ' ms' : '—']);
  metrics.push(['Resources', performance.getEntriesByType('resource').length]);
  metrics.push(['Tabs open', tabs.length]);
  for (const [k, v] of metrics) {
    const row = document.createElement('div');
    row.className = 'dt-metric';
    row.innerHTML = `<span>${k}</span><span>${v}</span>`;
    panel.appendChild(row);
  }
}

/* ---------- Keyboard shortcuts ---------- */
function initKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    const s = loadSettings();
    if (matchShortcut(e, s.shortcutNewTab)) { e.preventDefault(); createTab(); }
    else if (matchShortcut(e, s.shortcutCloseTab)) { e.preventDefault(); if (activeTabId) closeTab(activeTabId); }
    else if (matchShortcut(e, s.shortcutDevTools)) {
      e.preventDefault();
      const dt = document.getElementById('devtools');
      dt.hidden = !dt.hidden;
    }
  });
}

function matchShortcut(e, shortcut) {
  if (!shortcut) return false;
  const parts = shortcut.toLowerCase().split('+').map(p => p.trim());
  const needCtrl = parts.includes('ctrl');
  const needAlt = parts.includes('alt');
  const needShift = parts.includes('shift');
  const needMeta = parts.includes('cmd') || parts.includes('meta');
  const key = parts[parts.length - 1];
  if (e.ctrlKey !== needCtrl) return false;
  if (e.altKey !== needAlt) return false;
  if (e.shiftKey !== needShift) return false;
  if (e.metaKey !== needMeta) return false;
  if (key === 'f12' && e.key === 'F12') return true;
  return e.key.toLowerCase() === key;
}

/* ---------- Helpers ---------- */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }

function toast(msg, kind = 'info') {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast is-' + kind;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

window.__shoolworkApp = { openInProxy, createTab, closeTab, activateTab };
