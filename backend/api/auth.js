/* /api/auth — Google OAuth callback + status checker
 *
 * Cross-origin flow (frontend.example.com ↔ backend.vercel.app):
 *   1. User on frontend clicks "Sign in with Google"
 *   2. Frontend redirects to BACKEND/api/auth?start=1&return_to=<frontend URL>
 *   3. Backend redirects to Google OAuth (state cookie set on backend origin)
 *   4. Google redirects back to BACKEND/api/auth?code=...&state=...
 *   5. Backend exchanges code for tokens, sets SameSite=None; Partitioned cookie
 *   6. Backend redirects to the frontend URL captured in step 2 (or FRONTEND_ORIGIN)
 *   7. Frontend's subsequent fetch() calls to BACKEND/api/sync include the cookie
 *      (credentials: 'include')
 */
const {
  SCOPES, getOAuthClient, env,
  sendJSON, sendRedirect, parseCookies, setCookie, clearCookie,
  encodeTokens, decodeTokens,
  applyCORS, handlePreflight,
} = require('./_lib/shared');
const { verifyDeviceKey, isAccessControlEnabled } = require('./_lib/access-store');

const SESSION_COOKIE = 'shoolwork_session';
const STATE_COOKIE = 'shoolwork_oauth_state';
const RETURN_TO_COOKIE = 'shoolwork_return_to';

/* Access-control middleware: same logic as in sync.js.
 * Returns true if allowed; false if rejected.
 */
async function requireAccess(req, res) {
  try {
    const enabled = await isAccessControlEnabled();
    if (!enabled) return true;
  } catch {
    return true;
  }
  const deviceKey = req.headers['x-device-key'] || (req.url && new URL(req.url, 'http://x').searchParams.get('device_key'));
  if (!deviceKey) {
    sendJSON(res, 401, { error: 'Device key required' });
    return false;
  }
  const role = await verifyDeviceKey(deviceKey);
  if (!role) {
    sendJSON(res, 403, { error: 'Device key invalid or revoked' });
    return false;
  }
  return true;
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  /* ---- CORS preflight for any cross-origin request ---- */
  if (handlePreflight(req, res)) return;

  /* ---- Status check ---- */
  if (url.searchParams.get('status') === '1') {
    applyCORS(req, res);
    const allowed = await requireAccess(req, res);
    if (!allowed) return;
    const cookies = parseCookies(req);
    const tokens = decodeTokens(cookies[SESSION_COOKIE]);
    if (tokens && tokens.access_token) {
      return sendJSON(res, 200, {
        signedIn: true,
        scope: tokens.scope || SCOPES.join(' '),
      });
    }
    return sendJSON(res, 200, { signedIn: false });
  }

  /* ---- Sign out ---- */
  if (url.searchParams.get('signout') === '1') {
    applyCORS(req, res);
    const allowed = await requireAccess(req, res);
    if (!allowed) return;
    clearCookie(res, SESSION_COOKIE);
    return sendJSON(res, 200, { signedOut: true });
  }

  /* ---- Start OAuth flow ----
   * Frontend passes ?return_to=<URL> + ?device_key=<KEY> so we know where
   * to send the user back AND we can verify access on the callback.
   * The device_key is embedded in the OAuth state cookie so the callback
   * (which has no headers) can still enforce access control.
   */
  if (url.searchParams.get('start') === '1') {
    applyCORS(req, res);
    const allowed = await requireAccess(req, res);
    if (!allowed) return;
    const returnTo = url.searchParams.get('return_to') || process.env.FRONTEND_ORIGIN || '/';
    if (!isAllowedReturnTo(returnTo)) {
      return sendJSON(res, 400, { error: 'Invalid return_to URL' });
    }
    const deviceKey = req.headers['x-device-key'] || url.searchParams.get('device_key');
    const oauth = getOAuthClient();
    // State format: <random>__<deviceKey> — lets us verify device on callback
    const randPart = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const statePayload = deviceKey ? randPart + '__' + deviceKey : randPart;
    setCookie(res, STATE_COOKIE, statePayload, {
      maxAge: 600, path: '/',
    });
    setCookie(res, RETURN_TO_COOKIE, encodeURIComponent(returnTo), {
      maxAge: 600, path: '/',
    });
    const authUrl = oauth.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      state: statePayload,
      prompt: 'consent',
    });
    return sendRedirect(res, authUrl);
  }

  /* ---- OAuth callback (Google redirects back here) ---- */
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const cookies = parseCookies(req);
  const returnToRaw = cookies[RETURN_TO_COOKIE] ? decodeURIComponent(cookies[RETURN_TO_COOKIE]) : null;

  if (error) {
    const dest = returnToRaw || process.env.FRONTEND_ORIGIN || '/';
    return sendRedirect(res, dest + (dest.includes('?') ? '&' : '?') + 'auth_error=' + encodeURIComponent(error));
  }

  if (!code) {
    return sendJSON(res, 400, { error: 'Missing code parameter' });
  }

  const expectedState = cookies[STATE_COOKIE];
  clearCookie(res, STATE_COOKIE);
  clearCookie(res, RETURN_TO_COOKIE);

  if (!state || state !== expectedState) {
    return sendJSON(res, 400, { error: 'OAuth state mismatch (possible CSRF)' });
  }

  // Extract device key from state (format: <rand>__<deviceKey>)
  const stateParts = state.split('__');
  const stateDeviceKey = stateParts.length === 2 ? stateParts[1] : null;
  if (stateDeviceKey) {
    try {
      const enabled = await isAccessControlEnabled();
      if (enabled) {
        const role = await verifyDeviceKey(stateDeviceKey);
        if (!role) {
          return sendJSON(res, 403, { error: 'Device key invalid or revoked during OAuth flow' });
        }
      }
    } catch {
      // KV not configured — fail open
    }
  }

  try {
    const oauth = getOAuthClient();
    const { tokens } = await oauth.getToken(code);
    if (!tokens.access_token) throw new Error('No access_token in OAuth response');

    const cookieValue = encodeTokens(tokens);
    setCookie(res, SESSION_COOKIE, cookieValue, {
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    });

    // Redirect back to the frontend (with optional success flag)
    const dest = returnToRaw || process.env.FRONTEND_ORIGIN || '/';
    const sep = dest.includes('?') ? '&' : '?';
    return sendRedirect(res, dest + sep + 'auth=success');
  } catch (e) {
    return sendJSON(res, 500, { error: 'OAuth token exchange failed', detail: e.message });
  }
};

/* Validate that return_to is on an allowed origin.
 *   - Matches FRONTEND_ORIGIN env var
 *   - OR is http://localhost:* (for local dev)
 *   - OR is the same origin as the backend itself
 */
function isAllowedReturnTo(returnTo) {
  if (!returnTo) return false;
  let u;
  try { u = new URL(returnTo); } catch { return false; }
  // Allow localhost for dev
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  // Allow FRONTEND_ORIGIN exact match
  if (process.env.FRONTEND_ORIGIN) {
    try {
      const allowed = new URL(process.env.FRONTEND_ORIGIN);
      if (u.origin === allowed.origin) return true;
    } catch {}
  }
  // Allow same-origin (no FRONTEND_ORIGIN set, frontend == backend)
  return false;
}
