/* ============================================================
 * storage.js — Browser storage export / import
 *
 * Exports the full state of:
 *   - document.cookie
 *   - localStorage
 *   - sessionStorage
 *   - IndexedDB (all databases, all object stores, all records)
 *   - Cache API (all caches, all requests, all responses)
 *
 * Output is a single JSON-serializable object. Used by sync.js
 * to push/pull from Google Drive, and by the manual export/
 * import buttons in the Sync UI.
 * ============================================================ */

export const STORAGE_VERSION = 3;
export const BACKUP_MAGIC = 'shoolwork-proxy-backup';

/* ---------- Cookie helpers ---------- */

function getCookies() {
  // document.cookie returns "name=value; name2=value2"
  if (!document.cookie) return [];
  return document.cookie.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf('=');
    const name = idx === -1 ? pair : pair.slice(0, idx);
    const value = idx === -1 ? '' : pair.slice(idx + 1);
    return { name, value };
  });
}

function clearCookies() {
  // Only cookies visible to JS (no HttpOnly) can be cleared here.
  // Delete by setting expiry in the past, for every path we can guess.
  const cookies = getCookies();
  const paths = ['/', ''];
  const domains = [location.hostname, '.' + location.hostname, location.hostname.split('.').slice(-2).join('.'), '.' + location.hostname.split('.').slice(-2).join('.')];
  for (const { name } of cookies) {
    for (const path of paths) {
      for (const domain of domains) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}; domain=${domain}`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}; domain=${location.hostname}`;
      }
    }
  }
}

function setCookies(cookies) {
  if (!Array.isArray(cookies)) return;
  for (const { name, value } of cookies) {
    document.cookie = `${name}=${value}; path=/; max-age=31536000; SameSite=Lax`;
  }
}

/* ---------- Web Storage helpers ---------- */

function dumpWebStorage(store) {
  const out = {};
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    try { out[key] = store.getItem(key); } catch { out[key] = null; }
  }
  return out;
}

function clearWebStorage(store) {
  const keys = [];
  for (let i = 0; i < store.length; i++) keys.push(store.key(i));
  for (const k of keys) {
    try { store.removeItem(k); } catch { /* ignore */ }
  }
}

function restoreWebStorage(store, data) {
  if (!data || typeof data !== 'object') return;
  for (const [k, v] of Object.entries(data)) {
    try { store.setItem(k, v === null ? '' : String(v)); } catch { /* quota / ignore */ }
  }
}

/* ---------- IndexedDB helpers ---------- */

if (!window.indexedDB) window.indexedDB = window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
if (!IDBFactory.prototype.databases) {
  // Fallback for browsers that don't expose indexedDB.databases()
  IDBFactory.prototype.databases = async function () { return []; };
}

async function dumpIndexedDB() {
  const out = {};
  let dbs = [];
  try { dbs = await indexedDB.databases(); } catch { dbs = []; }
  // Also include any names we tracked manually (fallback)
  const known = JSON.parse(localStorage.getItem('shoolwork:idb-names') || '[]');
  const names = Array.from(new Set([
    ...dbs.map(d => d.name),
    ...known,
    'shoolwork-known-db', // sentinel
  ].filter(n => n && n !== 'shoolwork-known-db')));

  for (const name of names) {
    try {
      const dump = await dumpIDBByName(name);
      if (dump) out[name] = dump;
    } catch (e) {
      out[name] = { __error: String(e && e.message || e) };
    }
  }
  return out;
}

function dumpIDBByName(name) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(name); } catch (e) { return resolve(null); }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; try { req.result.close(); } catch {} resolve(null); } }, 4000);

    req.onsuccess = async () => {
      if (settled) return; settled = true; clearTimeout(timer);
      const db = req.result;
      const storeNames = Array.from(db.objectStoreNames);
      const result = { version: db.version, stores: {} };
      if (!storeNames.length) { db.close(); resolve(result); return; }

      try {
        const tx = db.transaction(storeNames, 'readonly');
        await Promise.all(storeNames.map(async (storeName) => {
          const store = tx.objectStore(storeName);
          const allReq = store.getAll();
          const allKeysReq = store.getAllKeys();
          const [values, keys] = await Promise.all([
            new Promise((res, rej) => { allReq.onsuccess = () => res(allReq.result); allReq.onerror = () => rej(allReq.error); }),
            new Promise((res, rej) => { allKeysReq.onsuccess = () => res(allKeysReq.result); allKeysReq.onerror = () => rej(allKeysReq.error); }),
          ]);
          // Stringify values so we survive structured-clone-unsupported types (Blob, File etc.)
          const records = [];
          for (let i = 0; i < values.length; i++) {
            records.push({ key: serializeKey(keys[i]), value: serializeValue(values[i]) });
          }
          result.stores[storeName] = {
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes: Array.from(store.indexNames).map(idxName => {
              const idx = store.index(idxName);
              return { name: idxName, keyPath: idx.keyPath, unique: idx.unique, multiEntry: idx.multiEntry };
            }),
            records,
          };
        }));
        db.close();
        resolve(result);
      } catch (e) {
        try { db.close(); } catch {}
        resolve({ __error: String(e && e.message || e) });
      }
    };
    req.onupgradeneeded = (e) => {
      // The DB didn't exist; abort and delete the empty DB created by open()
      try { e.target.transaction.abort(); } catch {}
    };
    req.onerror = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(null); };
    req.onblocked = () => { /* wait a bit more */ };
  });
}

function serializeKey(k) {
  if (typeof k === 'string' || typeof k === 'number' || typeof k === 'boolean' || k === null) return k;
  if (k instanceof Date) return { __type: 'Date', value: k.toISOString() };
  if (Array.isArray(k)) return k.map(serializeKey);
  if (typeof k === 'object') {
    try { return JSON.parse(JSON.stringify(k)); } catch { return String(k); }
  }
  return String(k);
}

function serializeValue(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return { __type: 'Date', value: v.toISOString() };
  if (v instanceof ArrayBuffer) return { __type: 'ArrayBuffer', value: b64encode(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) {
    return { __type: v.constructor.name + 'View', value: b64encode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  if (v instanceof Blob) {
    // Best-effort: read as base64 data URL. Big blobs will inflate backup size — caller can disable.
    return { __type: 'Blob', mime: v.type, value: blobToDataUrlSync(v) };
  }
  if (Array.isArray(v)) return v.map(serializeValue);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = serializeValue(val);
    return out;
  }
  return String(v);
}

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Synchronous Blob → dataURL via FileReader is async; fall back to marker.
function blobToDataUrlSync(blob) {
  // We cannot read a Blob synchronously; mark for async restore.
  return { __asyncBlob: true, mime: blob.type, size: blob.size };
}

async function restoreIndexedDB(data) {
  if (!data || typeof data !== 'object') return;
  for (const [dbName, dbDump] of Object.entries(data)) {
    if (!dbDump || dbDump.__error) continue;
    await restoreIDBByName(dbName, dbDump);
  }
}

function restoreIDBByName(name, dump) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(name, dump.version || 1); } catch (e) { return resolve(false); }
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Build object stores + indexes
      for (const [storeName, storeDump] of Object.entries(dump.stores || {})) {
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, {
            keyPath: storeDump.keyPath || null,
            autoIncrement: storeDump.autoIncrement || false,
          });
          for (const idx of storeDump.indexes || []) {
            try {
              store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique, multiEntry: !!idx.multiEntry });
            } catch { /* duplicate */ }
          }
        }
      }
    };
    req.onsuccess = async (e) => {
      const db = e.target.result;
      try {
        const storeNames = Object.keys(dump.stores || {});
        if (storeNames.length) {
          const tx = db.transaction(storeNames, 'readwrite');
          await Promise.all(storeNames.map(async (storeName) => {
            const storeDump = dump.stores[storeName];
            if (!db.objectStoreNames.contains(storeName)) return;
            const store = tx.objectStore(storeName);
            // Clear existing
            await new Promise((res, rej) => { const r = store.clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
            for (const rec of storeDump.records || []) {
              const key = deserializeKey(rec.key);
              const value = deserializeValue(rec.value);
              try {
                if (storeDump.keyPath) {
                  // Key is auto-extracted from value via keyPath — do NOT pass a separate key.
                  store.put(value);
                } else if (key !== undefined && key !== null && !storeDump.autoIncrement) {
                  store.put(value, key);
                } else {
                  store.put(value);
                }
              } catch (err) { /* skip un-restorable record */ }
            }
          }));
          await new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
        }
        db.close();
        trackIDBName(name);
        resolve(true);
      } catch (err) {
        try { db.close(); } catch {}
        resolve(false);
      }
    };
    req.onerror = () => resolve(false);
  });
}

function trackIDBName(name) {
  try {
    const known = JSON.parse(localStorage.getItem('shoolwork:idb-names') || '[]');
    if (!known.includes(name)) { known.push(name); localStorage.setItem('shoolwork:idb-names', JSON.stringify(known)); }
  } catch { /* private mode */ }
}

function deserializeKey(k) {
  if (k && typeof k === 'object' && k.__type === 'Date') return new Date(k.value);
  return k;
}
function deserializeValue(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v && typeof v === 'object') {
    if (v.__type === 'Date') return new Date(v.value);
    if (v.__type === 'ArrayBuffer') return b64decode(v.value).buffer;
    if (v.__type && v.__type.endsWith('View')) {
      const bytes = b64decode(v.value);
      const ctorName = v.__type.replace('View', '');
      const ctors = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };
      const Ctor = ctors[ctorName] || Uint8Array;
      return new Ctor(bytes.buffer);
    }
    if (Array.isArray(v)) return v.map(deserializeValue);
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = deserializeValue(val);
    return out;
  }
  return v;
}

/* ---------- Cache API helpers ---------- */

async function dumpCacheAPI() {
  if (!('caches' in window)) return {};
  const out = {};
  let keys = [];
  try { keys = await caches.keys(); } catch { return {}; }
  for (const cacheName of keys) {
    try {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      const entries = [];
      for (const req of requests) {
        try {
          const resp = await cache.match(req);
          const bodyText = await responseToText(resp);
          entries.push({
            url: req.url,
            method: req.method,
            mode: req.mode,
            credentials: req.credentials,
            cache: req.cache,
            redirect: req.redirect,
            referrer: req.referrer,
            status: resp.status,
            statusText: resp.statusText,
            headers: headersToObject(resp.headers),
            body: bodyText,
          });
        } catch (e) { /* skip */ }
      }
      out[cacheName] = entries;
    } catch { /* skip */ }
  }
  return out;
}

async function restoreCacheAPI(data) {
  if (!('caches' in window) || !data) return;
  for (const [cacheName, entries] of Object.entries(data)) {
    let cache;
    try { cache = await caches.open(cacheName); } catch { continue; }
    for (const e of entries || []) {
      try {
        const req = new Request(e.url, {
          method: e.method || 'GET',
          mode: e.mode || 'no-cors',
          credentials: e.credentials || 'omit',
          cache: e.cache || 'default',
          redirect: e.redirect || 'follow',
        });
        const headers = new Headers();
        for (const [k, v] of Object.entries(e.headers || {})) headers.set(k, v);
        const resp = new Response(e.body || '', { status: e.status || 200, statusText: e.statusText || 'OK', headers });
        await cache.put(req, resp);
      } catch { /* skip */ }
    }
  }
}

async function clearCacheAPI() {
  if (!('caches' in window)) return;
  const keys = await caches.keys();
  for (const k of keys) { try { await caches.delete(k); } catch {} }
}

function headersToObject(headers) {
  const out = {};
  headers.forEach((v, k) => { out[k] = v; });
  return out;
}
async function responseToText(resp) {
  try {
    const buf = await resp.arrayBuffer();
    return b64encode(new Uint8Array(buf));
  } catch { return ''; }
}

/* ---------- Public: build & apply ---------- */

export async function exportBackup(options = {}) {
  const opts = Object.assign({
    cookies: true,
    localStorage: true,
    sessionStorage: true,
    indexedDB: true,
    cacheAPI: true,
  }, options);

  const backup = {
    magic: BACKUP_MAGIC,
    version: STORAGE_VERSION,
    exportedAt: new Date().toISOString(),
    origin: location.origin,
    device: await getDeviceId(),
    payload: {},
  };

  if (opts.cookies) backup.payload.cookies = getCookies();
  if (opts.localStorage) backup.payload.localStorage = dumpWebStorage(localStorage);
  if (opts.sessionStorage) backup.payload.sessionStorage = dumpWebStorage(sessionStorage);
  if (opts.indexedDB) backup.payload.indexedDB = await dumpIndexedDB();
  if (opts.cacheAPI) backup.payload.cacheAPI = await dumpCacheAPI();

  return backup;
}

export async function importBackup(backup, options = {}) {
  if (!backup || backup.magic !== BACKUP_MAGIC) {
    throw new Error('Invalid backup file: missing magic header.');
  }
  if (backup.version > STORAGE_VERSION) {
    console.warn(`Backup version ${backup.version} is newer than supported ${STORAGE_VERSION}; attempting anyway.`);
  }

  const opts = Object.assign({
    cookies: true,
    localStorage: true,
    sessionStorage: true,
    indexedDB: true,
    cacheAPI: true,
    clearFirst: true,
  }, options);

  if (opts.clearFirst) {
    if (opts.cookies) clearCookies();
    if (opts.localStorage) clearWebStorage(localStorage);
    if (opts.sessionStorage) clearWebStorage(sessionStorage);
    // Don't clear IndexedDB wholesale; we clear per-store during restore.
    if (opts.cacheAPI) await clearCacheAPI();
  }

  const p = backup.payload || {};
  if (opts.cookies && p.cookies) setCookies(p.cookies);
  if (opts.localStorage && p.localStorage) restoreWebStorage(localStorage, p.localStorage);
  if (opts.sessionStorage && p.sessionStorage) restoreWebStorage(sessionStorage, p.sessionStorage);
  if (opts.indexedDB && p.indexedDB) await restoreIndexedDB(p.indexedDB);
  if (opts.cacheAPI && p.cacheAPI) await restoreCacheAPI(p.cacheAPI);

  return {
    importedAt: new Date().toISOString(),
    origin: backup.origin,
    device: backup.device,
    counts: {
      cookies: (p.cookies || []).length,
      localStorage: Object.keys(p.localStorage || {}).length,
      sessionStorage: Object.keys(p.sessionStorage || {}).length,
      indexedDB: Object.keys(p.indexedDB || {}).length,
      caches: Object.keys(p.cacheAPI || {}).length,
    },
  };
}

export function backupToJson(backup) {
  return JSON.stringify(backup, null, 2);
}

export function backupSizeBytes(backup) {
  return new Blob([JSON.stringify(backup)]).size;
}

export function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function getDeviceId() {
  let id = localStorage.getItem('shoolwork:device-id');
  if (!id) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    id = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('shoolwork:device-id', id);
  }
  return id;
}

/* Expose for inline use by devtools panel */
window.__shoolworkStorage = { exportBackup, importBackup, backupSizeBytes, humanSize };
