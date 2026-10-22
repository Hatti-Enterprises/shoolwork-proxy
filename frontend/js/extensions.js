/* ============================================================
 * extensions.js — Chrome/Firefox extension loader for Shoolwork Proxy
 *
 * What this DOES:
 *   - Accept .crx (Chrome), .xpi (Firefox), or .user.js (userscript) uploads
 *   - Unzip the archive client-side, read manifest.json
 *   - Store extension files in IndexedDB (large blobs)
 *   - Inject matching content_scripts into proxied HTML responses
 *   - Shim chrome.storage.local / chrome.runtime.sendMessage so basic
 *     extension code works unchanged
 *
 * What this DOES NOT do:
 *   - No real background pages (background scripts run once in the SW
 *     context, with no persistent timers or runtime.connect)
 *   - No browser_action / page_action toolbar icons
 *   - No webRequest blocking API (we only see proxied requests, and
 *     synchronous blocking is hard in a service worker)
 *   - No native messaging, no tabs API, no cookies API
 *
 * Best-fit extensions: content-script-only (uBlock Lite, Dark Reader,
 * userscripts, ad blockers, custom CSS, password autofill shims, etc.)
 * Worst-fit: full extensions needing background pages (1Password,
 * Bitwarden, LastPass, Grammarly — these will run in degraded mode).
 * ============================================================ */

import { openDB } from './idb-tiny.js'; // tiny promise wrapper, see below

const DB_NAME = 'shoolwork-extensions';
const DB_VERSION = 1;
const STORE_FILES = 'files';   // { extId, path, blob }
const STORE_META = 'meta';      // { id, manifest, enabled, installedAt }

let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const s = db.createObjectStore(STORE_FILES, { keyPath: ['extId', 'path'] });
        s.createIndex('by_extId', 'extId');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
    },
  });
  return dbPromise;
}

/* ---------- ZIP unpacker ----------
 * Uses the same minimal ZIP parser from crypto.js (re-implemented here
 * to avoid circular imports). Supports stored (uncompressed) entries only.
 * Most .crx/.xpi files are stored uncompressed at the outer layer —
 * the inner files use deflate, which we DON'T support. So we fall back
 * to the browser's DecompressionStream API for deflate.
 * ============================================================ */

const enc = new TextEncoder();
const dec = new TextDecoder();

async function unzipArchive(bytes) {
  // First try stored-only parse (fast path)
  try {
    return parseStoredZip(new Uint8Array(bytes));
  } catch (e) {
    // Fall back to decompressing deflate entries via DecompressionStream
    return parseDeflateZip(new Uint8Array(bytes));
  }
}

function parseStoredZip(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const entries = {};
  let eocd = -1;
  for (let i = zipBytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Missing EOCD');
  const total = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  let pos = cdOffset;
  for (let i = 0; i < total; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('Bad central dir entry');
    const compression = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = dec.decode(new Uint8Array(zipBytes.buffer, zipBytes.byteOffset + pos + 46, nameLen));
    if (compression !== 0) throw new Error('Deflate entry — needs fallback');
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries[name] = zipBytes.slice(dataStart, dataStart + compSize);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function parseDeflateZip(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const entries = {};
  let eocd = -1;
  for (let i = zipBytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Missing EOCD');
  const total = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  let pos = cdOffset;
  for (let i = 0; i < total; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('Bad central dir entry');
    const compression = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = dec.decode(new Uint8Array(zipBytes.buffer, zipBytes.byteOffset + pos + 46, nameLen));
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compBytes = zipBytes.slice(dataStart, dataStart + compSize);
    if (compression === 0) {
      entries[name] = compBytes;
    } else if (compression === 8) {
      // Deflate — use DecompressionStream
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compBytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      entries[name] = new Uint8Array(buf);
    } else {
      throw new Error(`Unsupported compression method ${compression} in ${name}`);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ---------- CRX/XPI parser ----------
 * .crx  = [magic "Cr24"][version 4B][pubkey_len 4B][sig_len 4B][pubkey][sig][ZIP]
 * .xpi  = plain ZIP (Firefox doesn't add a header)
 * .user.js = raw JS with optional ==UserScript== header
 * ============================================================ */

function stripCrxHeader(bytes) {
  const u = new Uint8Array(bytes);
  // CRX magic: "Cr24" = 0x43 0x72 0x32 0x34
  if (u.length < 16 || u[0] !== 0x43 || u[1] !== 0x72 || u[2] !== 0x32 || u[3] !== 0x34) {
    return u; // Not CRX — assume plain ZIP
  }
  const view = new DataView(u.buffer);
  const version = view.getUint32(4, true);
  let headerSize;
  if (version === 2) {
    const pubkeyLen = view.getUint32(8, true);
    const sigLen = view.getUint32(12, true);
    headerSize = 16 + pubkeyLen + sigLen;
  } else if (version === 3) {
    // CRX3 has a single header length field at offset 8
    headerSize = 12 + view.getUint32(8, true);
  } else {
    throw new Error(`Unsupported CRX version ${version}`);
  }
  return u.slice(headerSize);
}

/* ---------- Extension install ---------- */

export async function installExtension(file) {
  const name = file.name.toLowerCase();
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    throw new Error('Could not read file: ' + e.message);
  }

  // Detect file type
  let extId, manifest, files;
  if (name.endsWith('.user.js') || name.endsWith('.user.jsx')) {
    // Userscript — wrap as a synthetic extension
    extId = 'userjs-' + cryptoHash(file.name + Date.now());
    const code = dec.decode(bytes);
    const parsed = parseUserscriptHeader(code);
    manifest = {
      manifest_version: 2,
      name: parsed.name || file.name,
      version: parsed.version || '1.0',
      description: parsed.description || 'Userscript',
      content_scripts: [{
        matches: parsed.matches || ['<all_urls>'],
        js: ['user.js'],
        run_at: parsed.run_at || 'document_idle',
      }],
    };
    files = { 'user.js': bytes };
  } else {
    // .crx or .xpi — unzip
    const zipBytes = name.endsWith('.crx') ? stripCrxHeader(bytes) : bytes;
    files = await unzipArchive(zipBytes);
    const manifestBytes = files['manifest.json'];
    if (!manifestBytes) throw new Error('manifest.json not found in archive');
    manifest = JSON.parse(dec.decode(manifestBytes));
    extId = manifest.name
      ? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + (manifest.version || '1').replace(/[^a-z0-9.]+/gi, '-')
      : 'ext-' + Date.now();
  }

  // Store in IndexedDB
  const database = await db();
  await database.put(STORE_META, {
    id: extId,
    manifest,
    enabled: true,
    installedAt: Date.now(),
  });
  // Store all files (small ones as text, big ones as blob)
  for (const [path, data] of Object.entries(files)) {
    await database.put(STORE_FILES, {
      extId,
      path,
      blob: new Blob([data]),
      text: dec.decode(data).length < 100000 ? dec.decode(data) : null, // cache small files as text
    });
  }
  return { id: extId, manifest };
}

export async function listExtensions() {
  const database = await db();
  return await database.getAll(STORE_META);
}

export async function getExtension(id) {
  const database = await db();
  return await database.get(STORE_META, id);
}

export async function removeExtension(id) {
  const database = await db();
  await database.delete(STORE_META, id);
  // Delete all files for this extension
  const tx = database.transaction(STORE_FILES, 'readwrite');
  const index = tx.store.index('by_extId');
  let cursor = await index.openCursor(IDBKeyRange.only(id));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function setExtensionEnabled(id, enabled) {
  const database = await db();
  const meta = await database.get(STORE_META, id);
  if (!meta) return;
  meta.enabled = enabled;
  await database.put(STORE_META, meta);
}

/* ---------- Match URL patterns ---------- */

function matchUrlPattern(pattern, url) {
  // Chrome match patterns: <scheme>://<host><path>
  //   *://*/*          → any
  //   *://*.foo.com/*  → any subdomain of foo.com (also matches foo.com itself)
  //   https://foo.com/bar/* → exact path prefix
  if (pattern === '<all_urls>') return true;
  const m = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)?$/);
  if (!m) return false;
  const [, scheme, host, path = '/*'] = m;
  try {
    const u = new URL(url);
    if (scheme !== '*' && u.protocol !== scheme + ':') return false;
    if (host !== '*') {
      // Build a "host[:port]" string for comparison (Chrome patterns don't
      // typically include ports, but we'll accept them if present).
      const fullHost = u.port ? `${u.hostname}:${u.port}` : u.hostname;
      if (host.startsWith('*.')) {
        // *.foo.com matches foo.com AND any subdomain of foo.com
        // (but NOT notfoo.com — must end with .foo.com or be exactly foo.com)
        const base = host.slice(2);
        if (u.hostname !== base && !u.hostname.endsWith('.' + base)) return false;
      } else if (host !== u.hostname && host !== fullHost) {
        return false;
      }
    }
    // Path match (glob — Chrome treats * as matching any chars except ?)
    const pathPattern = path.replace(/\*/g, '.*').replace(/\?/g, '\\?');
    if (!new RegExp('^' + pathPattern + '$').test(u.pathname + u.search)) return false;
    return true;
  } catch { return false; }
}

function matchesAnyPattern(patterns, url) {
  return patterns.some(p => matchUrlPattern(p, url));
}

/* ---------- Get content scripts to inject for a URL ---------- */

export async function getInjectablesForUrl(url) {
  const database = await db();
  const all = await database.getAll(STORE_META);
  const injectables = { scripts: [], css: [], runAt: 'document_idle' };

  for (const ext of all) {
    if (!ext.enabled) continue;
    const manifest = ext.manifest;
    const cs = manifest.content_scripts || [];
    for (const entry of cs) {
      const matches = entry.matches || [];
      if (!matchesAnyPattern(matches, url)) continue;
      // This content script entry applies — collect its files
      for (const jsFile of (entry.js || [])) {
        const fileRec = await database.get(STORE_FILES, [ext.id, jsFile]);
        if (fileRec) {
          let code = fileRec.text;
          if (code === null && fileRec.blob) {
            code = await fileRec.blob.text();
          }
          injectables.scripts.push({
            extId: ext.id,
            extName: manifest.name,
            file: jsFile,
            code,
            runAt: entry.run_at || 'document_idle',
          });
        }
      }
      for (const cssFile of (entry.css || [])) {
        const fileRec = await database.get(STORE_FILES, [ext.id, cssFile]);
        if (fileRec) {
          let css = fileRec.text;
          if (css === null && fileRec.blob) css = await fileRec.blob.text();
          injectables.css.push({ extId: ext.id, file: cssFile, css });
        }
      }
    }
  }
  return injectables;
}

/* ---------- Userscript header parser ---------- */

function parseUserscriptHeader(code) {
  const m = code.match(/==\/?UserScript==([\s\S]*?)==\/?UserScript==/);
  if (!m) return {};
  const block = m[1];
  const out = { matches: [] };
  for (const line of block.split('\n')) {
    const lm = line.match(/^\s*\/\/\s*@(\S+)\s+(.+?)\s*$/);
    if (!lm) continue;
    const [, key, value] = lm;
    if (key === 'match' || key === 'include') out.matches.push(value);
    else if (key === 'name') out.name = value;
    else if (key === 'version') out.version = value;
    else if (key === 'description') out.description = value;
    else if (key === 'run-at') out.run_at = value;
  }
  if (!out.matches.length) out.matches = ['<all_urls>'];
  return out;
}

/* ---------- Helpers ---------- */

async function cryptoHash(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Chrome API shims ----------
 * These get injected into the proxied page alongside the extension's
 * content scripts so basic chrome.* calls don't throw.
 * ============================================================ */

export const CHROME_SHIM = `
(function() {
  if (window.chrome && window.chrome.runtime) return; // already shimmed
  const _storage = {};
  const _listeners = {};
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    id: 'shoolwork-extension-shim',
    onMessage: {
      addListener: (fn) => { (_listeners.message = _listeners.message || []).push(fn); },
      removeListener: (fn) => {
        if (_listeners.message) _listeners.message = _listeners.message.filter(f => f !== fn);
      },
    },
    sendMessage: (msg, cb) => {
      // No real background — fake async response
      if (cb) setTimeout(() => cb({}), 0);
    },
    onConnect: { addListener: () => {}, removeListener: () => {} },
    getURL: (path) => '/extension-resource/' + path,  // proxied by SW
  };
  window.chrome.storage = {
    local: {
      get: (keys, cb) => {
        const result = {};
        if (typeof keys === 'string') keys = [keys];
        if (Array.isArray(keys)) {
          for (const k of keys) if (k in _storage) result[k] = _storage[k];
        } else if (keys && typeof keys === 'object') {
          for (const k of Object.keys(keys)) result[k] = k in _storage ? _storage[k] : keys[k];
        } else {
          Object.assign(result, _storage);
        }
        if (cb) setTimeout(() => cb(result), 0);
        return Promise.resolve(result);
      },
      set: (items, cb) => {
        Object.assign(_storage, items);
        if (cb) setTimeout(cb, 0);
        return Promise.resolve();
      },
      remove: (keys, cb) => {
        if (typeof keys === 'string') keys = [keys];
        for (const k of keys) delete _storage[k];
        if (cb) setTimeout(cb, 0);
        return Promise.resolve();
      },
      clear: (cb) => {
        for (const k of Object.keys(_storage)) delete _storage[k];
        if (cb) setTimeout(cb, 0);
        return Promise.resolve();
      },
    },
    // Sync storage — same as local for shim purposes
    sync: null,
    onChanged: {
      addListener: () => {},
      removeListener: () => {},
    },
  };
  // Browser/Firefox alias
  window.browser = window.chrome;
})();
`;

window.__shoolworkExtensions = {
  installExtension,
  listExtensions,
  removeExtension,
  setExtensionEnabled,
  getInjectablesForUrl,
  CHROME_SHIM,
};
