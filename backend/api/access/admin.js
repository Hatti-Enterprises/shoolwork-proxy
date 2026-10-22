/* /api/access/admin/* — host-only admin endpoints with role-based access.
 *
 * Roles (escalating privileges):
 *
 *   'user'       Default. Cannot access /admin/* at all — 401 on every admin route.
 *   'moderator'  Can manage access: codes (generate/list), devices (list/revoke/unrevoke/delete).
 *                Cannot change roles, cannot view /stats, cannot view /env.
 *   'owner'      Full access. Everything moderators can do PLUS:
 *                - role management (setDeviceRole)
 *                - view /stats
 *                - view /env (read-only)
 *
 * Auth: clients send `Authorization: Bearer <token>` where token is:
 *   - One of OWNER_TOKENS     → grants 'owner' role
 *   - One of MODERATOR_TOKENS → grants 'moderator' role
 *
 * Token sources (checked in order):
 *   1. Env vars OWNER_TOKEN / MODERATOR_TOKENS (CSV) — preferred for production
 *   2. Hardcoded arrays in _lib/auth-config.js — simpler but less secure
 *      (anyone with repo read access can extract them)
 *
 * Endpoints (role required in brackets):
 *
 *   POST /api/access/admin/login                  [any]      body: { token } → { ok, role }
 *   GET  /api/access/admin/codes                   [moderator]               → { codes: [...] }
 *   POST /api/access/admin/codes/generate         [moderator] body: { count, label } → { codes: [...] }
 *   GET  /api/access/admin/devices                [moderator]               → { devices: [...] }
 *   POST /api/access/admin/devices/revoke         [moderator] body: { deviceKey } → { ok }
 *   POST /api/access/admin/devices/unrevoke       [moderator] body: { deviceKey } → { ok }
 *   POST /api/access/admin/devices/delete         [moderator] body: { deviceKey } → { ok }
 *   POST /api/access/admin/devices/set-role       [owner]     body: { deviceKey, role } → { ok }
 *   GET  /api/access/admin/stats                  [owner]                   → { ... }
 *   GET  /api/access/admin/env                    [owner]                   → { env: {...} } (read-only, secrets redacted)
 */
const { sendJSON, applyCORS, handlePreflight } = require('../_lib/shared');
const {
  generateCodes, listCodes, listDevices,
  revokeDevice, unrevokeDevice, deleteDevice,
  isAccessControlEnabled, countActiveDevices,
  setDeviceRole, ROLES, ROLE_HIERARCHY, hasRole,
} = require('../_lib/access-store');
// Hardcoded token arrays — see auth-config.js for security trade-off
const { OWNER_TOKENS, MODERATOR_TOKENS } = require('../_lib/auth-config');

/* Resolve the list of valid owner tokens.
 * Checks env var OWNER_TOKEN first (single string), then falls back to
 * the hardcoded OWNER_TOKENS array.
 */
function getOwnerTokens() {
  const tokens = [];
  if (process.env.OWNER_TOKEN) tokens.push(process.env.OWNER_TOKEN);
  for (const t of OWNER_TOKENS || []) if (t) tokens.push(t);
  return tokens;
}

/* Resolve the list of valid moderator tokens.
 * Checks env var MODERATOR_TOKENS (CSV) first, then falls back to the
 * hardcoded MODERATOR_TOKENS array.
 */
function getModeratorTokens() {
  const tokens = [];
  if (process.env.MODERATOR_TOKENS) {
    for (const t of process.env.MODERATOR_TOKENS.split(',')) {
      const trimmed = t.trim();
      if (trimmed) tokens.push(trimmed);
    }
  }
  for (const t of MODERATOR_TOKENS || []) if (t) tokens.push(t);
  return tokens;
}

/* Determine role from Authorization header.
 * Returns { role: 'owner'|'moderator'|null, reason: string }
 */
function getRoleFromAuth(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return { role: null, reason: 'no-token' };
  const token = auth.slice('Bearer '.length).trim();

  // Check owner tokens
  for (const ownerToken of getOwnerTokens()) {
    if (constantTimeEqual(token, ownerToken)) {
      return { role: ROLES.OWNER, reason: 'ok' };
    }
  }

  // Check moderator tokens
  for (const modToken of getModeratorTokens()) {
    if (constantTimeEqual(token, modToken)) {
      return { role: ROLES.MODERATOR, reason: 'ok' };
    }
  }

  // No tokens configured at all
  if (getOwnerTokens().length === 0 && getModeratorTokens().length === 0) {
    return { role: null, reason: 'not-configured' };
  }
  return { role: null, reason: 'bad-token' };
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Require a minimum role for an admin route.
 * Returns the role if allowed; otherwise sends an error response and returns null.
 */
async function requireRole(req, res, requiredRole) {
  const { role, reason } = getRoleFromAuth(req);
  if (reason === 'not-configured') {
    sendJSON(res, 503, { ok: false, error: 'Admin access not configured — set OWNER_TOKEN and/or MODERATOR_TOKENS env vars' });
    return null;
  }
  if (!role) {
    sendJSON(res, 401, { ok: false, error: 'Unauthorized' });
    return null;
  }
  if (!hasRole(role, requiredRole)) {
    sendJSON(res, 403, { ok: false, error: `Forbidden — requires ${requiredRole} role, you have ${role}` });
    return null;
  }
  return role;
}

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  applyCORS(req, res);

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const method = (req.method || 'GET').toUpperCase();
  const path = url.pathname.replace(/^\/api\/access\/admin\/?/, '').toLowerCase();

  /* ---------- /login — exchange token for role (any valid token works) ---------- */
  if (path === 'login' && method === 'POST') {
    const { role, reason } = getRoleFromAuth(req);
    if (reason === 'not-configured') {
      return sendJSON(res, 503, { ok: false, error: 'Admin access not configured — set OWNER_TOKEN and/or MODERATOR_TOKENS env vars' });
    }
    return sendJSON(res, 200, { ok: !!role, role });
  }

  /* All other admin endpoints require at least moderator */
  const role = await requireRole(req, res, ROLES.MODERATOR);
  if (!role) return;

  /* ---------- /codes ---------- */
  if (path === 'codes' && method === 'GET') {
    try {
      const codes = await listCodes();
      return sendJSON(res, 200, { codes });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to list codes', detail: e.message });
    }
  }

  /* ---------- /codes/generate ---------- */
  if (path === 'codes/generate' && method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch { body = {}; }
    const count = Math.min(100, Math.max(1, parseInt(body.count, 10) || 1));
    const label = (body.label || '').trim().slice(0, 80);
    try {
      const codes = await generateCodes(count, label);
      return sendJSON(res, 200, { codes, label });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to generate codes', detail: e.message });
    }
  }

  /* ---------- /devices ---------- */
  if (path === 'devices' && method === 'GET') {
    try {
      const devices = await listDevices();
      return sendJSON(res, 200, { devices });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to list devices', detail: e.message });
    }
  }

  /* ---------- /devices/revoke ---------- */
  if (path === 'devices/revoke' && method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch { body = {}; }
    const deviceKey = (body.deviceKey || '').trim();
    if (!deviceKey) return sendJSON(res, 400, { error: 'Missing deviceKey' });
    try {
      const result = await revokeDevice(deviceKey);
      if (!result.ok) return sendJSON(res, 404, { error: result.error });
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to revoke device', detail: e.message });
    }
  }

  /* ---------- /devices/unrevoke ---------- */
  if (path === 'devices/unrevoke' && method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch { body = {}; }
    const deviceKey = (body.deviceKey || '').trim();
    if (!deviceKey) return sendJSON(res, 400, { error: 'Missing deviceKey' });
    try {
      const result = await unrevokeDevice(deviceKey);
      if (!result.ok) return sendJSON(res, 404, { error: result.error });
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to unrevoke device', detail: e.message });
    }
  }

  /* ---------- /devices/delete ---------- */
  if (path === 'devices/delete' && method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch { body = {}; }
    const deviceKey = (body.deviceKey || '').trim();
    if (!deviceKey) return sendJSON(res, 400, { error: 'Missing deviceKey' });
    try {
      const result = await deleteDevice(deviceKey);
      if (!result.ok) return sendJSON(res, 404, { error: result.error });
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to delete device', detail: e.message });
    }
  }

  /* ---------- /devices/set-role (OWNER ONLY) ---------- */
  if (path === 'devices/set-role' && method === 'POST') {
    // Require owner role specifically
    if (!hasRole(role, ROLES.OWNER)) {
      return sendJSON(res, 403, { ok: false, error: `Forbidden — requires ${ROLES.OWNER} role, you have ${role}` });
    }
    let body;
    try { body = await readBody(req); }
    catch { body = {}; }
    const deviceKey = (body.deviceKey || '').trim();
    const newRole = (body.role || '').trim();
    if (!deviceKey) return sendJSON(res, 400, { error: 'Missing deviceKey' });
    if (!ROLE_HIERARCHY.includes(newRole)) {
      return sendJSON(res, 400, { error: `Invalid role. Must be one of: ${ROLE_HIERARCHY.join(', ')}` });
    }
    try {
      const result = await setDeviceRole(deviceKey, newRole);
      if (!result.ok) return sendJSON(res, 404, { error: result.error });
      return sendJSON(res, 200, { ok: true, role: newRole });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to set role', detail: e.message });
    }
  }

  /* ---------- /stats (OWNER ONLY) ---------- */
  if (path === 'stats' && method === 'GET') {
    if (!hasRole(role, ROLES.OWNER)) {
      return sendJSON(res, 403, { ok: false, error: `Forbidden — requires ${ROLES.OWNER} role, you have ${role}` });
    }
    try {
      const enabled = await isAccessControlEnabled();
      const counts = await countActiveDevices();
      const codes = await listCodes();
      const unusedCodes = codes.filter(c => c.status === 'unused').length;
      const usedCodes = codes.filter(c => c.status === 'used').length;
      return sendJSON(res, 200, {
        enabled,
        codes: { total: codes.length, unused: unusedCodes, used: usedCodes },
        devices: counts,
      });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Failed to fetch stats', detail: e.message });
    }
  }

  /* ---------- /env (OWNER ONLY — read-only) ---------- */
  if (path === 'env' && method === 'GET') {
    if (!hasRole(role, ROLES.OWNER)) {
      return sendJSON(res, 403, { ok: false, error: `Forbidden — requires ${ROLES.OWNER} role, you have ${role}` });
    }
    // Return a redacted summary of relevant env vars + hardcoded config
    const env = {
      // Hardcoded in _lib/auth-config.js
      OWNER_TOKENS_HARDCODED: getOwnerTokens().length > process.env.OWNER_TOKEN ? `${getOwnerTokens().length} (incl. hardcoded)` : `${getOwnerTokens().length} (env+hardcoded)`,
      MODERATOR_TOKENS_HARDCODED: getModeratorTokens().length > (process.env.MODERATOR_TOKENS ? process.env.MODERATOR_TOKENS.split(',').filter(Boolean).length : 0)
        ? `${getModeratorTokens().length} (incl. hardcoded)`
        : `${getModeratorTokens().length} (env+hardcoded)`,
      // Env vars (redacted)
      OWNER_TOKEN: process.env.OWNER_TOKEN ? '(set, hidden)' : '(not set)',
      MODERATOR_TOKENS: process.env.MODERATOR_TOKENS
        ? `(set, ${process.env.MODERATOR_TOKENS.split(',').filter(Boolean).length} tokens)`
        : '(not set)',
      GDRIVE_CLIENT_ID: process.env.GDRIVE_CLIENT_ID ? '(set, hidden)' : '(not set)',
      GDRIVE_CLIENT_SECRET: process.env.GDRIVE_CLIENT_SECRET ? '(set, hidden)' : '(not set)',
      GDRIVE_REDIRECT_URI: process.env.GDRIVE_REDIRECT_URI || '(not set)',
      FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || '(not set)',
      SESSION_SECRET: process.env.SESSION_SECRET ? '(set, hidden)' : '(not set)',
      KV_REST_API_URL: process.env.KV_REST_API_URL ? '(set, hidden)' : '(not set)',
    };
    return sendJSON(res, 200, { env });
  }

  return sendJSON(res, 404, { error: 'Unknown admin action', path, method });
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
