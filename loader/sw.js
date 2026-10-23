// ============================================================
// CONFIG
// ============================================================
const BACKEND_URL = 'https://shoolwork-proxy-backend.vercel.app';
// ============================================================

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
var UV_CDN = 'https://cdn.jsdelivr.net/npm/@titaniumnetwork-dev/ultraviolet@3.2.10/dist';

// The script that gets injected into every proxied HTML page.
// This is what UV's handler.js normally does — but since we can't load
// uv.handler.js in the SW, we inject it into the PAGE instead.
var UV_INJECT = '<scr' + 'ipt>' +
  'self.__uv$config=' + JSON.stringify(self.__uv$config) + ';' +
  'self.__uv$bare="' + self.__uv$bare + '";' +
  'self.__uv$cookies="";' +
  '</scr' + 'ipt>' +
  '<script src="' + UV_CDN + '/uv.bundle.js"></script>' +
  '<script src="' + UV_CDN + '/uv.client.js"></script>' +
  '<script src="' + UV_CDN + '/uv.handler.js"></script>';

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

  // Forward the request headers from the original request
  var forwardHeaders = {};
  var reqHeaders = event.request.headers;
  reqHeaders.forEach(function(value, key) {
    if (key.startsWith('x-bare-') || key === 'content-type' || key === 'accept' || key === 'accept-language' || key === 'cookie') {
      forwardHeaders[key] = value;
    }
  });

  event.respondWith(
    fetch(BARE_HTTP, {
      method: event.request.method,
      headers: {
        'X-Bare-URL': targetUrl,
        'X-Bare-Host': target.hostname,
        'X-Bare-Port': target.port || (target.protocol === 'https:' ? '443' : '80'),
        'X-Bare-Protocol': target.protocol,
        'X-Bare-Path': target.pathname + target.search,
        'X-Bare-Headers': JSON.stringify(forwardHeaders),
      },
      body: event.request.method !== 'GET' && event.request.method !== 'HEAD' ? event.request.body : undefined,
    }).then(function(res) {
      // Get the real response headers from the bare server
      var bareHeaders = {};
      try {
        var xBareHeaders = res.headers.get('x-bare-headers');
        if (xBareHeaders) bareHeaders = JSON.parse(xBareHeaders);
      } catch (e) {}

      var contentType = res.headers.get('content-type') || bareHeaders['content-type'] || '';
      var isHtml = contentType.indexOf('text/html') !== -1 || contentType.indexOf('application/xhtml') !== -1;

      if (!isHtml) {
        // Not HTML — return as-is with CORS headers stripped
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
      }

      // HTML — inject UV scripts so the page rewrites its own URLs
      return res.text().then(function(html) {
        var modifiedHtml;
        if (/<head[^>]*>/i.test(html)) {
          modifiedHtml = html.replace(/(<head[^>]*>)/i, '$1' + UV_INJECT);
        } else if (/<html[^>]*>/i.test(html)) {
          modifiedHtml = html.replace(/(<html[^>]*>)/i, '$1<head>' + UV_INJECT + '</head>');
        } else {
          modifiedHtml = UV_INJECT + html;
        }

        var newHeaders = new Headers();
        newHeaders.set('content-type', 'text/html; charset=utf-8');
        // Copy safe headers from bare response
        for (var key in bareHeaders) {
          var lk = key.toLowerCase();
          if (lk !== 'content-security-policy' && lk !== 'content-security-policy-report-only' &&
              lk !== 'x-frame-options' && lk !== 'transfer-encoding' && lk !== 'content-length' &&
              lk !== 'content-encoding') {
            newHeaders.set(lk, bareHeaders[key]);
          }
        }

        return new Response(modifiedHtml, {
          status: 200,
          statusText: 'OK',
          headers: newHeaders,
        });
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