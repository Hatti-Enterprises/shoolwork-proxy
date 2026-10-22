/* /api/bare/* — Bare server endpoint for Ultraviolet proxy
 *
 * Ultraviolet talks to a "Bare server" to fetch cross-origin resources.
 * Cross-origin CORS headers are applied so a separately-hosted frontend
 * can fetch through this bare server.
 */
const { createBareServer } = require('@tomphttp/bare-server-node');
const { applyCORS, handlePreflight } = require('../_lib/shared');
const { verifyDeviceKey, isAccessControlEnabled } = require('../_lib/access-store');

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
  // CORS preflight for cross-origin frontend
  if (handlePreflight(req, res)) return;
  applyCORS(req, res);

  // Access control: verify device key if enabled.
  // We only gate the actual bare-route requests, not the bare server's
  // version-info endpoint (which the SW probes during init).
  const bare = getBareServer();
  const isBareRoute = bare.shouldRoute(req);
  if (isBareRoute) {
    try {
      const enabled = await isAccessControlEnabled();
      if (enabled) {
        const deviceKey = req.headers['x-device-key'];
        if (!deviceKey) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ error: 'Device key required' }));
        }
        const role = await verifyDeviceKey(deviceKey);
        if (!role) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ error: 'Device key invalid or revoked' }));
        }
      }
    } catch {
      // KV not configured — fail open
    }
  }

  try {
    if (isBareRoute) {
      await bare.routeRequest(req, res);
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Bare route not handled', url: req.url }));
  } catch (e) {
    console.error('[bare]', e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Bare server error', detail: e.message }));
    }
  }
};
