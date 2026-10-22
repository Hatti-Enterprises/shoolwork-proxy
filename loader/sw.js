// ============================================================
// CONFIG
// ============================================================
const BACKEND_URL = 'https://shoolwork-proxy-backend.vercel.app';
// ============================================================

importScripts('https://cdn.jsdelivr.net/npm/@titaniumnetwork-dev/ultraviolet@3.2.10/dist/uv.bundle.js');

var SW_SCOPE_DIR = (self.registration && self.registration.scope) || './';
var UV_PREFIX = SW_SCOPE_DIR + 'service/';
var BARE_URL = BACKEND_URL.replace(/\/+$/, '') + '/api/bare';

// UV config — the page-side script reads this to encode URLs
self.__uv$config = {
  prefix: UV_PREFIX,
  bare: BARE_URL,
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
};
self.__uv$bare = BARE_URL;
self.__uv$cookies = '';

// Create a BareClient for fetching proxied content
var bareClient = new Ultraviolet.BareClient(BARE_URL);

// Register the SW fetch handler — this is what intercepts /service/ requests
self.addEventListener('fetch', function(event) {
  var url = event.request.url;
  
  // Only intercept requests to our UV prefix
  if (!url.includes(UV_PREFIX)) return;
  
  // Decode the proxied URL
  var encodedPath = url.slice(url.indexOf(UV_PREFIX) + UV_PREFIX.length).split('?')[0];
  var targetUrl;
  try {
    targetUrl = Ultraviolet.codec.xor.decode(encodedPath);
  } catch (e) {
    return; // Not a valid UV URL — let it pass through
  }
  
  // Fetch the target via the bare server
  event.respondWith(
    fetch(BARE_URL + '/v3', {
      mode:'cors',
      method: event.request.method,
      headers: {
        'X-Bare-URL': targetUrl,
        'X-Bare-Host': new URL(targetUrl).hostname,
        'X-Bare-Port': new URL(targetUrl).port || (new URL(targetUrl).protocol === 'https:' ? '443' : '80'),
        'X-Bare-Protocol': new URL(targetUrl).protocol,
        'X-Bare-Path': new URL(targetUrl).pathname + new URL(targetUrl).search,
        'X-Bare-Headers': JSON.stringify({}),
      },
    }).then(function(res) {
      // Return the response, removing headers that would break the iframe
      var newHeaders = new Headers(res.headers);
      newHeaders.delete('content-security-policy');
      newHeaders.delete('content-security-policy-report-only');
      newHeaders.delete('x-frame-options');
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: newHeaders,
      });
    }).catch(function(err) {
      console.error('[SW] Proxy fetch failed:', err);
      return new Response('Proxy error: ' + err.message, { status: 502, headers: { 'Content-Type': 'text/plain' } });
    })
  );
});

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });