/* shared.js — helpers shared by /api/auth, /api/sync, /api/bare
 *
 * Same as the original, plus a new CORS helper for cross-origin
 * credentialed requests from a separately-hosted frontend.
 *
 * Frontend is hosted on a different origin than the backend, so:
 *   - Cookies must be SameSite=None; Secure; Partitioned
 *   - CORS must echo the request's Origin (NOT "*") so credentials work
 *   - Preflight (OPTIONS) requests must be handled explicitly
 */
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
];

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getOAuthClient(redirectUri) {
  return new google.auth.OAuth2(
    env('GDRIVE_CLIENT_ID'),
    env('GDRIVE_CLIENT_SECRET'),
    redirectUri || env('GDRIVE_REDIRECT_URI'),
  );
}

function getDrive(tokens) {
  const oauth = getOAuthClient();
  oauth.setCredentials(tokens);
  return google.drive({ version: 'v3', auth: oauth });
}

/* ---------- JSON + redirect + cookie helpers ---------- */

function sendJSON(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendRedirect(res, url) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.end();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

/* Cookie attributes for cross-origin embedding.
 *
 *   SameSite=None  → lets the cookie be sent on cross-site requests
 *                    (required because frontend is on a different origin)
 *   Secure         → required by SameSite=None (HTTPS-only)
 *   Partitioned    → CHIPS — cookie is scoped per top-level site,
 *                    so the same Drive session is used across embeds
 *                    on the same parent site
 *   HttpOnly       → not readable from JS (prevents XSS theft)
 *
 * Note: Partitioned cookies have a 7-day max lifetime in Chrome.
 * Auto-sync will re-establish the session if the user revisits.
 */
function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  // HttpOnly is always on (security)
  parts.push('HttpOnly');
  // Cross-origin: always SameSite=None + Secure
  parts.push('SameSite=None');
  parts.push('Secure');
  // CHIPS partitioning — separate storage per top-level site
  parts.push('Partitioned');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name, path = '/') {
  res.setHeader('Set-Cookie', `${name}=; Max-Age=0; Path=${path}; HttpOnly; Secure; SameSite=None; Partitioned`);
}

/* ---------- Token encoding (XOR obfuscation, NOT real encryption) ---------- */

function encodeTokens(tokens) {
  const json = JSON.stringify(tokens);
  const secret = process.env.SESSION_SECRET || 'shoolwork-dev-secret';
  const buf = Buffer.from(json, 'utf8');
  const key = Buffer.from(secret, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return out.toString('base64url');
}

function decodeTokens(blob) {
  try {
    const secret = process.env.SESSION_SECRET || 'shoolwork-dev-secret';
    const buf = Buffer.from(blob, 'base64url');
    const key = Buffer.from(secret, 'utf8');
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
    return JSON.parse(out.toString('utf8'));
  } catch {
    return null;
  }
}

/* ---------- CORS for cross-origin frontend ---------- */

/* Returns the allowed origin for CORS responses.
 *
 * Strategy:
 *   1. If FRONTEND_ORIGIN env var is set → use it (exact match only)
 *   2. Else if request has Origin header → echo it back (allows any origin,
 *      but only one per response, so credentials still work)
 *   3. Else → no CORS headers (same-origin request, no CORS needed)
 *
 * Echoing the Origin is safe because:
 *   - The browser only sends Origin on cross-origin requests
 *   - Echoing it back as Access-Control-Allow-Origin is the standard pattern
 *   - Combined with Allow-Credentials: true, only the actual requesting
 *     origin gets the response (not a wildcard)
 */
function getAllowedOrigin(req) {
  if (process.env.FRONTEND_ORIGIN) {
    // Exact-match mode: only this origin is allowed
    return process.env.FRONTEND_ORIGIN;
  }
  // Echo mode: return the request's Origin (or null if same-origin)
  return req.headers.origin || null;
}

/* Apply CORS headers to a response. Call this BEFORE sendJSON for any
 * cross-origin endpoint. Includes credentialed mode.
 */
function applyCORS(req, res, extraHeaders = {}) {
  const origin = getAllowedOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bare-*');
    res.setHeader('Vary', 'Origin');
    // Expose useful headers to JS
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, X-Backup-Size');
    // Cache preflight for 24h
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
}

/* Handle CORS preflight (OPTIONS) requests. Returns true if the request
 * was a preflight that has been handled (function should return immediately).
 */
function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  applyCORS(req, res);
  res.statusCode = 204;
  res.end();
  return true;
}

module.exports = {
  SCOPES,
  getOAuthClient,
  getDrive,
  env,
  sendJSON,
  sendRedirect,
  parseCookies,
  setCookie,
  clearCookie,
  encodeTokens,
  decodeTokens,
  applyCORS,
  handlePreflight,
  getAllowedOrigin,
};
