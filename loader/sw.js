// ============================================================
// CONFIG
// ============================================================
const BACKEND_URL = 'https://shoolwork-proxy-backend.vercel.app';
// ============================================================

importScripts('https://cdn.jsdelivr.net/npm/@titaniumnetwork-dev/ultraviolet@3.2.10/dist/uv.bundle.js');
importScripts('https://cdn.jsdelivr.net/npm/@titaniumnetwork-dev/ultraviolet@3.2.10/dist/uv.client.js');

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

importScripts('https://cdn.jsdelivr.net/npm/@titaniumnetwork-dev/ultraviolet@3.2.10/dist/uv.handler.js');

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });