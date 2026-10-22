/* /api/access — public access-control endpoints for the frontend.
 *
 * Endpoints:
 *   GET  /api/access/status                → { enabled: bool }
 *   POST /api/access/verify                body: { code, label? }  → { ok, deviceKey? }
 *
 * The verify endpoint:
 *   1. Looks up the code in KV
 *   2. If unused, marks it used + generates a device key + returns the key
 *   3. If already used, returns 401
 *
 * The device key is stored in localStorage by the frontend and sent
 * with every subsequent request via the X-Device-Key header.
 */
const { sendJSON, applyCORS, handlePreflight } = require('../_lib/shared');
const { claimCode, isAccessControlEnabled, countActiveDevices, verifyDeviceKey } = require('../_lib/access-store');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  applyCORS(req, res);

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const method = (req.method || 'GET').toUpperCase();
  const path = url.pathname.replace(/^\/api\/access\/?/, '').toLowerCase();

  /* ---------- /status ---------- */
  if (path === 'status' && method === 'GET') {
    try {
      const enabled = await isAccessControlEnabled();
      const counts = await countActiveDevices();
      return sendJSON(res, 200, {
        enabled,
        devices: counts,
      });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to check access status', detail: e.message });
    }
  }

  /* ---------- /verify ---------- */
  if (path === 'verify' && method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJSON(res, 400, { error: 'Invalid JSON body' });
    }
    const code = (body && body.code || '').trim();
    const label = (body && body.label || '').trim().slice(0, 80);  // truncate label
    if (!code) return sendJSON(res, 400, { error: 'Missing code' });

    try {
      const result = await claimCode(code, label);
      if (!result.ok) {
        return sendJSON(res, 401, { error: result.error });
      }
      return sendJSON(res, 200, { ok: true, deviceKey: result.deviceKey });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to claim code', detail: e.message });
    }
  }

  /* ---------- /check (verify an existing device key, no code needed) ---------- */
  if (path === 'check' && method === 'POST') {
    const deviceKey = req.headers['x-device-key'];
    if (!deviceKey) return sendJSON(res, 200, { valid: false, role: null });
    try {
      const role = await verifyDeviceKey(deviceKey);
      return sendJSON(res, 200, { valid: !!role, role });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to verify device', detail: e.message });
    }
  }

  return sendJSON(res, 404, { error: 'Unknown access action', path, method });
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      try { resolve(JSON.parse(buf.toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
