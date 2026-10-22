// ============================================================
// CONFIG
// ============================================================
const BACKEND_URL = 'https://shoolwork-proxy-backend.vercel.app';
// ============================================================
// Stub navigator.serviceWorker — UV bundle accesses it at top level
// but it's undefined inside a SW context
if (!self.navigator.serviceWorker) self.navigator.serviceWorker = { addEventListener: function(){} };

importScripts('https://cdn.jsdelivr.net/npm/@titaniumnetwork-dev/ultraviolet@3.2.10/dist/uv.bundle.js');

self.__uv$cookies = '';
var SW_SCOPE_DIR = (self.registration && self.registration.scope) || './';
var UV_PREFIX = SW_SCOPE_DIR + 'service/';

self.__uv$config = {
  prefix: UV_PREFIX,
  bare: BACKEND_URL.replace(/\/+$/, '') + '/api/bare/',
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
};
self.__uv$bare = self.__uv$config.bare;

var BARE_HTTP = BACKEND_URL.replace(/\/+$/, '') + '/api/bare/v3';

self.addEventListener('fetch', function(event) {
  var url = event.request.url;
  if (!url.includes(UV_PREFIX)) return;

  var encodedPath = url.slice(url.indexOf(UV_PREFIX) + UV_PREFIX.length).split('?')[0];
  var targetUrl;
  try {
    targetUrl = Ultraviolet.codec.xor.decode(encodedPath);
  } catch (e) {
    return;
  }

  var target = new URL(targetUrl);

  event.respondWith(
    fetch(BARE_HTTP, {
      method: event.request.method,
      headers: {
        'X-Bare-URL': targetUrl,
        'X-Bare-Host': target.hostname,
        'X-Bare-Port': target.port || (target.protocol === 'https:' ? '443' : '80'),
        'X-Bare-Protocol': target.protocol,
        'X-Bare-Path': target.pathname + target.search,
        'X-Bare-Headers': JSON.stringify({}),
      },
    }).then(function(res) {
      var newHeaders = new Headers(res.headers);
      newHeaders.delete('x-bare-headers');
      newHeaders.delete('x-bare-status');
      newHeaders.delete('content-security-policy');
      newHeaders.delete('content-security-policy-report-only');
      newHeaders.delete('x-frame-options');
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }).catch(function(err) {
      return new Response('Proxy error: ' + err.message, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' }
      });
    })
  );
});

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });