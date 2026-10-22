/* /api/bare/* — Bare server endpoint for Ultraviolet proxy
 *
 * Vercel-specific fixes:
 *   1. Vercel strips trailing slashes → bare server routes need them
 *   2. Vercel passes relative URLs → bare server does new URL(req.url)
 *      which needs absolute URLs
 *   3. /api/bare/ (empty catch-all) → Vercel 404s
 *
 * IMPORTANT: shouldRoute uses req.url.startsWith('/api/bare/')
 * but routeRequest uses new URL(req.url) which needs absolute URL.
 * So we keep req.url RELATIVE for shouldRoute, then temporarily make
 * it absolute for routeRequest.
 */
const { createBareServer } = require('@tomphttp/bare-server-node');
const { applyCORS, handlePreflight } = require('../_lib/shared');

let bareServer = null;

function getBareServer() {
  if (bareServer) return bareServer;
  bareServer = createBareServer('/api/bare/', {
    logErrors: true,
    blockLocal: true,
  });
  return bareServer;
}

module.exports = async (req, res) => {
  // Fix 1: Add trailing slash if missing (bare server routes are /v3/ not /v3)
  if (req.url) {
    var urlPath = req.url.split('?')[0];
    var queryStr = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    if (urlPath.match(/^\/api\/bare\/[^/]+$/) && !urlPath.endsWith('/')) {
      req.url = urlPath + '/' + queryStr;
    }
  }

  // CORS
  if (handlePreflight(req, res)) return;
  applyCORS(req, res);

  var bare = getBareServer();

  // Fix 3: Handle bare server root manually
  var checkPath = req.url ? req.url.split('?')[0] : '';
  if (checkPath === '/api/bare/' || checkPath === '/api/bare') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      versions: ['v1', 'v2', 'v3'],
      language: 'NodeJS',
      memoryUsage: Math.round((process.memoryUsage().heapUsed / 1048576) * 100) / 100,
      project: {
        name: 'bare-server-node',
        description: 'TOMPHTTP NodeJS Bare Server',
        repository: 'https://github.com/tomphttp/bare-server-node',
        version: '2.0.6'
      }
    }));
  }

  // shouldRoute checks: req.url.startsWith('/api/bare/')
  // req.url is still RELATIVE here so this works
  var isBareRoute = bare.shouldRoute(req);

  if (isBareRoute) {
    // Fix 2: Make URL absolute ONLY for routeRequest
    var origUrl = req.url;
    var host = req.headers.host || 'localhost';
    if (req.url && !req.url.startsWith('http')) {
      req.url = 'https://' + host + req.url;
    }

    try {
      await bare.routeRequest(req, res);
    } catch (e) {
      console.error('[bare] routeRequest error:', e);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Bare server error', detail: e.message }));
      }
    }

    req.url = origUrl;
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Bare route not handled', url: req.url }));
};