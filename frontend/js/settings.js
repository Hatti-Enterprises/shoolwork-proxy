/* ============================================================
 * settings.js — Shoolwork Proxy settings panel
 *
 * 28 options (matching GUST's option count) covering appearance,
 * clock, search/privacy, sync, keyboard, and advanced.
 *
 * Settings persist to localStorage and (optionally) sync via
 * Drive as part of the browser storage backup.
 * ============================================================ */

const SETTINGS_KEY = 'shoolwork:settings';

const DEFAULTS = {
  // appearance
  theme: 'dark',
  fontSize: 14,
  panelWidth: 320,
  bookmarksBar: true,
  wallpaper: 'aurora',
  // cloak (tab disguise)
  cloakTitle: '',
  cloakFavicon: '',
  // clock
  clock24h: true,
  showSeconds: false,
  // search
  searchEngine: 'brave',
  blockAds: true,
  cosmeticFilter: true,
  userAgentSpoof: false,
  webrtcBlock: true,
  // sync
  autoSync: false,
  autoSyncInterval: 5,
  syncOnUnload: true,
  syncCookies: true,
  syncLocalStorage: true,
  syncSessionStorage: true,
  syncIndexedDB: true,
  syncCacheAPI: false,
  // service provider (host) settings — controls whether Drive sync is offered
  //   'full'   = Google Drive + manual file export/import
  //   'manual' = manual file export/import only (no Drive, no OAuth needed)
  serviceProviderMode: 'full',
  // keyboard
  shortcutNewTab: 'Ctrl+T',
  shortcutCloseTab: 'Ctrl+W',
  shortcutDevTools: 'F12',
  // advanced
  bareServer: '/api/bare',
  proxyPrefix: '/service/',
};

export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return Object.assign({}, DEFAULTS, stored);
  } catch { return Object.assign({}, DEFAULTS); }
}

export function saveSettings(patch) {
  const cur = loadSettings();
  const next = Object.assign({}, cur, patch);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  applySettings(next);
  // Notify sync module that autoSync may have changed
  window.dispatchEvent(new CustomEvent('shoolwork:settings-changed', { detail: next }));
  if (window.__shoolworkSync) window.__shoolworkSync.refreshAuthState?.();
  return next;
}

export function applySettings(s) {
  // Theme
  document.documentElement.setAttribute('data-theme', s.theme);
  // Font size
  document.documentElement.style.setProperty('--font-size-base', s.fontSize + 'px');
  // Body wallpaper
  document.body.setAttribute('data-wallpaper', s.wallpaper);
  // Bookmarks bar visibility
  const bar = document.getElementById('bookmarksBar');
  if (bar) bar.hidden = !s.bookmarksBar;
  // Side panel width
  const dt = document.getElementById('devtools');
  if (dt) dt.style.width = s.panelWidth + 'px';
  // Cloak — tab title + favicon
  applyCloak(s.cloakTitle, s.cloakFavicon);
}

/* ---------- Cloak (tab disguise) ---------- */
function applyCloak(title, faviconUrl) {
  if (title) document.title = title;
  else document.title = 'Shoolwork Proxy';

  // Remove any existing cloak favicon link
  document.querySelectorAll('link[rel="icon"][data-cloak]').forEach(el => el.remove());
  if (faviconUrl) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = faviconUrl;
    link.dataset.cloak = '1';
    document.head.appendChild(link);
  }
}

export function initSettingsUI() {
  const settings = loadSettings();
  applySettings(settings);

  // Wire every .setting[data-key] element to its current value
  document.querySelectorAll('.setting[data-key]').forEach(row => {
    const key = row.dataset.key;
    const valueEl = row.querySelector('.setting__value');
    const input = row.querySelector('input, select');
    if (!input) return;

    const setVal = (v) => {
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = v ?? '';
      if (valueEl) valueEl.textContent = input.type === 'range' ? input.value : '';
    };
    setVal(settings[key]);

    input.addEventListener('change', () => {
      const v = input.type === 'checkbox' ? input.checked
              : input.type === 'number' || input.type === 'range' ? Number(input.value)
              : input.value;
      const next = saveSettings({ [key]: v });
      if (valueEl) valueEl.textContent = input.type === 'range' ? input.value : '';
      toast(`Saved: ${key} = ${v}`, 'info');

      // Service provider mode has special UI side-effects:
      // hide/show the Drive sections in the Sync view.
      if (key === 'serviceProviderMode') {
        updateProviderModeInfo(v);
        window.dispatchEvent(new CustomEvent('shoolwork:provider-mode-changed', { detail: v }));
      }
    });
    if (input.type === 'range') {
      input.addEventListener('input', () => {
        if (valueEl) valueEl.textContent = input.value;
      });
    }
  });

  // Initialize the provider mode info row visibility
  updateProviderModeInfo(settings.serviceProviderMode);

  // Reset button
  const reset = document.getElementById('settingsReset');
  if (reset) {
    reset.addEventListener('click', () => {
      if (!confirm('This will erase ALL settings, localStorage, sessionStorage, IndexedDB, cookies, and cache. Continue?')) return;
      localStorage.clear();
      sessionStorage.clear();
      document.cookie.split(';').forEach(c => {
        const eq = c.indexOf('=');
        const name = (eq === -1 ? c : c.slice(0, eq)).trim();
        if (!name) return;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${location.hostname}`;
      });
      if ('caches' in window) caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
      indexedDB.databases?.().then(dbs => dbs.forEach(d => indexedDB.deleteDatabase(d.name)));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEFAULTS));
      applySettings(DEFAULTS);
      toast('All settings & storage reset', 'info');
      setTimeout(() => location.reload(), 800);
    });
  }

  // Theme toggle button (top chrome)
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const cur = loadSettings();
      const next = cur.theme === 'dark' ? 'light' : 'dark';
      saveSettings({ theme: next });
    });
  }
}

function toast(msg, kind = 'info') {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast is-' + kind;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ---------- Service provider mode ---------- */

function updateProviderModeInfo(mode) {
  document.querySelectorAll('.settings__provider-info-row').forEach(row => {
    row.hidden = (row.dataset.mode !== mode);
  });
}

window.__shoolworkSettings = { loadSettings, saveSettings, applySettings };
