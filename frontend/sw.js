/* Shoolwork Proxy — Ultraviolet service worker (self-contained, jsDelivr-compatible)
 *
 * This file is the ONLY separate file required by the frontend (the rest is
 * inlined into index.html). The browser doesn't allow SWs to be inlined
 * as data: or blob: URLs — they must be served as a real HTTP resource
 * from the same origin as the page that registers them.
 *
 * COMPATIBILITY: works on any static host (jsDelivr loader, GitHub Pages,
 * Netlify, Cloudflare Pages, S3, Vercel static) because the UV prefix is
 * computed RELATIVE to the SW's own URL at runtime.
 *
 * Config is inlined (no separate uv.config.js needed):
 *   - BACKEND_URL must be set below to point at your backend deployment
 *   - bare server is at BACKEND_URL/api/bare/
 *
 * Load order:
 *   1. uv.bundle.js (CDN) — defines the global `Ultraviolet` object
 *   2. THIS FILE — sets `self.__uv.config` with inlined bare URL
 *   3. uv.handler.js (CDN) — reads `self.__uv.config` and registers fetch handlers
 */

// ====================================================================
// CONFIG — your backend URL.
//
// Two ways to set this:
//   1. Edit this string directly (simplest)
//   2. Set self.BACKEND_URL in the SW proxy file BEFORE importScripts
//      (lets you configure from the loader without editing this file)
// ====================================================================
const BACKEND_URL = self.BACKEND_URL || 'https://your-backend.vercel.app';  // ← CHANGE THIS
// ====================================================================

importScripts('https://cdn.jsdelivr.net/npm/@titaniumnetwork-dev/ultraviolet@3.2.10/dist/uv.bundle.js');

// uv.handler.js requires self.__uv$cookies to be a string (it's normally
// injected into pages by UV, but in the SW context we need to set it manually).
self.__uv$cookies = self.__uv$cookies || '';

/* Compute the UV prefix RELATIVE to this SW's own scope.
 *
 * Why relative? Because the SW can only intercept requests on its own
 * origin + path-prefix. On jsDelivr the SW sits at
 * `cdn.jsdelivr.net/gh/user/repo@latest/frontend/sw.js`, so the UV prefix
 * must be `cdn.jsdelivr.net/gh/user/repo@latest/frontend/service/` —
 * something we don't know at authoring time.
 *
 * `self.registration.scope` gives us the directory the SW controls.
 * We append `service/` to it. Works on ANY host.
 */
const SW_SCOPE_DIR = (self.registration && self.registration.scope) || './';
const UV_PREFIX = SW_SCOPE_DIR + 'service/';

// Inline UV config (no separate uv.config.js file needed)
self.__uv = self.__uv || {};
self.__uv.config = {
  prefix: UV_PREFIX,
  bare: BACKEND_URL.replace(/\/+$/, '') + '/api/bare/',
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
};
self.__uv$bare = self.__uv.config.bare;

importScripts('https://cdn.jsdelivr.net/npm/@titaniumnetwork-dev/ultraviolet@3.2.10/dist/uv.handler.js');

// Take ownership immediately so the SW controls the page on first registration.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/* ---------- Extension injection post-processor ---------- */

const HTML_CONTENT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/application\/xhtml)/i;

async function getExtensionInjectables(proxiedUrl) {
  if (!proxiedUrl) return { scripts: [], css: [] };
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    if (!clients.length) return { scripts: [], css: [] };
    const client = clients[0];
    return await new Promise((resolve) => {
      const chan = new MessageChannel();
      chan.port1.onmessage = (e) => resolve(e.data || { scripts: [], css: [] });
      chan.port1.onmessageerror = () => resolve({ scripts: [], css: [] });
      client.postMessage({ type: 'shoolwork:get-injectables', url: proxiedUrl }, [chan.port2]);
      setTimeout(() => resolve({ scripts: [], css: [] }), 3000);
    });
  } catch (e) {
    return { scripts: [], css: [] };
  }
}

async function postProcessResponse(response, proxiedUrl) {
  if (!response || response.status !== 200) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!HTML_CONTENT_TYPES.test(contentType)) return response;

  try {
    const html = await response.text();
    const injectables = await getExtensionInjectables(proxiedUrl);
    if (!injectables.scripts.length && !injectables.css.length) {
      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const shimsAndScripts = [
      CHROME_SHIM_INLINE,
      ...injectables.scripts.map(s => '//# sourceURL=shoolwork-ext://' + s.extId + '/' + s.file + '\n' + s.code),
    ].join('\n;\n');

    const cssBlock = injectables.css.map(c => c.css).join('\n/* --- */\n');
    const cssTag = cssBlock ? '<style data-shoolwork-ext>' + escapeHtml(cssBlock) + '</style>' : '';

    const scriptTag = '<scr' + 'ipt data-shoolwork-ext>' + shimsAndScripts + '</scr' + 'ipt>';
    let modifiedHtml;
    if (/<head[^>]*>/i.test(html)) {
      modifiedHtml = html.replace(/(<head[^>]*>)/i, '$1' + cssTag + scriptTag);
    } else if (/<html[^>]*>/i.test(html)) {
      modifiedHtml = html.replace(/(<html[^>]*>)/i, '$1<head>' + cssTag + scriptTag + '</head>');
    } else {
      modifiedHtml = cssTag + scriptTag + html;
    }

    const newHeaders = new Headers(response.headers);
    newHeaders.delete('content-security-policy');
    newHeaders.delete('content-security-policy-report-only');
    newHeaders.delete('x-frame-options');
    newHeaders.set('content-length', new TextEncoder().encode(modifiedHtml).length.toString());

    return new Response(modifiedHtml, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (e) {
    console.error('[shoolwork-sw] post-process failed:', e);
    return response;
  }
}

function escapeHtml(s) {
  return String(s).replace(/<\/style>/g, '<\\/style>');
}

const CHROME_SHIM_INLINE = `
(function() {
  if (window.chrome && window.chrome.runtime) return;
  const _storage = {};
  const _listeners = {};
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    id: 'shoolwork-extension-shim',
    onMessage: { addListener: () => {}, removeListener: () => {} },
    sendMessage: (msg, cb) => { if (cb) setTimeout(() => cb({}), 0); },
    onConnect: { addListener: () => {}, removeListener: () => {} },
    getURL: (path) => '/extension-resource/' + path,
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
      set: (items, cb) => { Object.assign(_storage, items); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
      remove: (keys, cb) => {
        if (typeof keys === 'string') keys = [keys];
        for (const k of keys) delete _storage[k];
        if (cb) setTimeout(cb, 0);
        return Promise.resolve();
      },
      clear: (cb) => { for (const k of Object.keys(_storage)) delete _storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  };
  window.browser = window.chrome;
})();
`;

const originalRespondWith = FetchEvent.prototype.respondWith;
FetchEvent.prototype.respondWith = function (promise) {
  const req = this.request;
  const url = req.url;
  if (!url.includes(UV_PREFIX)) {
    return originalRespondWith.call(this, promise);
  }
  let proxiedUrl = null;
  try {
    const path = url.slice(url.indexOf(UV_PREFIX) + UV_PREFIX.length);
    if (self.Ultraviolet && Ultraviolet.codec && Ultraviolet.codec.xor) {
      proxiedUrl = Ultraviolet.codec.xor.decode(path.split('?')[0]);
    }
  } catch {}

  const wrapped = Promise.resolve(promise).then(resp => postProcessResponse(resp, proxiedUrl));
  return originalRespondWith.call(this, wrapped);
};

self.addEventListener('message', async (e) => {
  if (!e.data || e.data.type !== 'shoolwork:get-injectables') return;
  const port = e.ports[0];
  if (!port) return;
  try {
    const injectables = await lookupInjectables(e.data.url);
    port.postMessage(injectables);
  } catch (err) {
    port.postMessage({ scripts: [], css: [], error: err.message });
  }
});

async function lookupInjectables(url) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('shoolwork-extensions', 1);
    req.onsuccess = async () => {
      const db = req.result;
      try {
        const tx = db.transaction(['meta', 'files'], 'readonly');
        const metaStore = tx.objectStore('meta');
        const filesStore = tx.objectStore('files');
        const allMeta = await new Promise((res, rej) => {
          const r = metaStore.getAll();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const injectables = { scripts: [], css: [] };
        for (const ext of allMeta) {
          if (!ext.enabled) continue;
          for (const cs of (ext.manifest.content_scripts || [])) {
            if (!matchesAnyPattern(cs.matches || [], url)) continue;
            for (const jsFile of (cs.js || [])) {
              const fileRec = await new Promise((res, rej) => {
                const r = filesStore.get([ext.id, jsFile]);
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
              });
              if (fileRec) {
                let code = fileRec.text;
                if (code === null && fileRec.blob) code = await fileRec.blob.text();
                injectables.scripts.push({
                  extId: ext.id,
                  extName: ext.manifest.name,
                  file: jsFile,
                  code,
                  runAt: cs.run_at || 'document_idle',
                });
              }
            }
            for (const cssFile of (cs.css || [])) {
              const fileRec = await new Promise((res, rej) => {
                const r = filesStore.get([ext.id, cssFile]);
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
              });
              if (fileRec) {
                let css = fileRec.text;
                if (css === null && fileRec.blob) css = await fileRec.blob.text();
                injectables.css.push({ extId: ext.id, file: cssFile, css });
              }
            }
          }
        }
        resolve(injectables);
      } catch (err) {
        reject(err);
      } finally {
        db.close();
      }
    };
    req.onerror = () => resolve({ scripts: [], css: [] });
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: ['extId', 'path'] });
        s.createIndex('by_extId', 'extId');
      }
    };
  });
}

function matchesAnyPattern(patterns, url) {
  return patterns.some(p => matchUrlPattern(p, url));
}

function matchUrlPattern(pattern, url) {
  if (pattern === '<all_urls>') return true;
  const m = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)?$/);
  if (!m) return false;
  const [, scheme, host, path = '/*'] = m;
  try {
    const u = new URL(url);
    if (scheme !== '*' && u.protocol !== scheme + ':') return false;
    if (host !== '*') {
      if (host.startsWith('*.')) {
        const base = host.slice(2);
        if (u.hostname !== base && !u.hostname.endsWith('.' + base)) return false;
      } else if (u.hostname !== host) return false;
    }
    const pathPattern = path.replace(/\*/g, '.*').replace(/\?/g, '\\?');
    if (!new RegExp('^' + pathPattern + '$').test(u.pathname + u.search)) return false;
    return true;
  } catch { return false; }
}