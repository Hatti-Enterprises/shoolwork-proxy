/* /api/sync — Google Drive backup file operations
 *
 * All actions require a valid session cookie (set by /api/auth).
 * CORS-enabled for cross-origin frontend (credentials: 'include' on client).
 *
 * Query params:
 *   ?action=find
 *       GET → { fileId: string|null }
 *   ?action=upload
 *       POST body: { filename, content_b64, folder='appDataFolder', encrypted: true }
 *       → { fileId, size, encrypted }
 *   ?action=uploadBeacon
 *       POST (sendBeacon) body: same as upload
 *       → 204 (no content, so sendBeacon counts as success)
 *   ?action=download&fileId=...
 *       GET → { content_b64?: string, content?: object, encrypted: bool }
 *   ?action=list
 *       GET → { files: [{ id, name, size, modifiedTime }] }
 */
const {
  getDrive, parseCookies, sendJSON, encodeTokens, decodeTokens,
  applyCORS, handlePreflight, getOAuthClient,
} = require('./_lib/shared');
const { verifyDeviceKey, isAccessControlEnabled } = require('./_lib/access-store');

const SESSION_COOKIE = 'shoolwork_session';

/* Access-control middleware: if access control is enabled, require a valid
 * device key in the X-Device-Key header. Returns true if request should
 * proceed, false if it was already rejected (caller should return immediately).
 *
 * NOTE: any role (user/moderator/owner) can call /api/sync — they're all
 * proxy users. The role distinction matters only for /api/access/admin/*.
 */
async function requireAccess(req, res) {
  try {
    const enabled = await isAccessControlEnabled();
    if (!enabled) return true;  // Access control disabled — allow
  } catch {
    return true;  // KV not configured — fail open
  }
  const deviceKey = req.headers['x-device-key'];
  if (!deviceKey) {
    sendJSON(res, 401, { error: 'Device key required' });
    return false;
  }
  const role = await verifyDeviceKey(deviceKey);
  if (!role) {
    sendJSON(res, 403, { error: 'Device key invalid or revoked' });
    return false;
  }
  // Stash role on req for downstream handlers (not used by sync, but consistent)
  req.deviceRole = role;
  return true;
}

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

async function requireTokens(req, res) {
  const cookies = parseCookies(req);
  const tokens = decodeTokens(cookies[SESSION_COOKIE]);
  if (!tokens || !tokens.access_token) {
    sendJSON(res, 401, { error: 'Not signed in' });
    return null;
  }
  // Refresh if expired
  if (tokens.expiry_date && tokens.expiry_date < Date.now() && tokens.refresh_token) {
    try {
      const oauth = getOAuthClient();
      oauth.setCredentials({ refresh_token: tokens.refresh_token });
      const refreshed = await oauth.refreshAccessToken();
      Object.assign(tokens, refreshed.credentials);
    } catch (e) {
      sendJSON(res, 401, { error: 'Session expired', detail: e.message });
      return null;
    }
  }
  return tokens;
}

module.exports = async (req, res) => {
  // CORS preflight first
  if (handlePreflight(req, res)) return;
  applyCORS(req, res);

  // Access control: verify device key if enabled
  const allowed = await requireAccess(req, res);
  if (!allowed) return;

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const action = url.searchParams.get('action') || 'find';
  const method = (req.method || 'GET').toUpperCase();

  /* ---------- find ---------- */
  if (action === 'find' && method === 'GET') {
    const tokens = await requireTokens(req, res);
    if (!tokens) return;
    try {
      const drive = getDrive(tokens);
      const list = await drive.files.list({
        spaces: 'appDataFolder',
        q: "name = 'shoolwork-proxy-backup.shoolwork.zip' or name = 'shoolwork-proxy-backup.json'",
        fields: 'files(id, name, size, modifiedTime)',
      });
      const files = list.data.files || [];
      const preferred = files.find(f => f.name === 'shoolwork-proxy-backup.shoolwork.zip')
                    || files.find(f => f.name === 'shoolwork-proxy-backup.json')
                    || files[0];
      const fileId = preferred?.id || null;
      return sendJSON(res, 200, { fileId, files, encrypted: !!(preferred && preferred.name && preferred.name.endsWith('.shoolwork.zip')) });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Drive list failed', detail: e.message });
    }
  }

  /* ---------- list ---------- */
  if (action === 'list' && method === 'GET') {
    const tokens = await requireTokens(req, res);
    if (!tokens) return;
    try {
      const drive = getDrive(tokens);
      const list = await drive.files.list({
        spaces: 'appDataFolder',
        fields: 'files(id, name, size, modifiedTime)',
        pageSize: 100,
      });
      return sendJSON(res, 200, { files: list.data.files || [] });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Drive list failed', detail: e.message });
    }
  }

  /* ---------- upload / uploadBeacon ---------- */
  if ((action === 'upload' || action === 'uploadBeacon') && method === 'POST') {
    const tokens = await requireTokens(req, res);
    if (!tokens) return;
    try {
      const body = await readBody(req);
      if (!body) return sendJSON(res, 400, { error: 'Missing body' });

      const filename = body.filename || 'shoolwork-proxy-backup.shoolwork.zip';
      const folder = body.folder || 'appDataFolder';

      let mimeType, bodyText;
      if (body.content_b64) {
        mimeType = 'application/octet-stream';
        bodyText = Buffer.from(body.content_b64, 'base64').toString('binary');
      } else if (body.content !== undefined) {
        mimeType = 'application/json';
        bodyText = JSON.stringify(body.content);
      } else {
        return sendJSON(res, 400, { error: 'Missing content or content_b64' });
      }

      const drive = getDrive(tokens);
      const existing = await drive.files.list({
        spaces: 'appDataFolder',
        q: `name = '${filename}'`,
        fields: 'files(id)',
      });
      const fileId = existing.data.files?.[0]?.id;

      let result;
      const media = { mimeType, body: bodyText };
      const metadata = { name: filename };

      if (fileId) {
        result = await drive.files.update({
          fileId,
          media,
          fields: 'id, size, modifiedTime',
        });
      } else {
        result = await drive.files.create({
          resourceBody: { ...metadata, parents: [folder] },
          media,
          fields: 'id, size, modifiedTime',
        });
      }

      if (action === 'uploadBeacon') {
        res.statusCode = 204;
        res.end();
        return;
      }
      return sendJSON(res, 200, {
        fileId: result.data.id,
        size: result.data.size || bodyText.length,
        modifiedTime: result.data.modifiedTime,
        encrypted: !!body.content_b64,
      });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Drive upload failed', detail: e.message });
    }
  }

  /* ---------- download ---------- */
  if (action === 'download' && method === 'GET') {
    const tokens = await requireTokens(req, res);
    if (!tokens) return;
    const fileId = url.searchParams.get('fileId');
    if (!fileId) return sendJSON(res, 400, { error: 'Missing fileId' });
    try {
      const drive = getDrive(tokens);
      const meta = await drive.files.get({
        fileId,
        fields: 'name, mimeType, size',
      });
      const isBinary = meta.data.mimeType === 'application/octet-stream'
                    || (meta.data.name || '').endsWith('.shoolwork.zip');
      const file = await drive.files.get({ fileId, alt: 'media' });
      if (isBinary) {
        const buf = Buffer.from(file.data);
        return sendJSON(res, 200, { content_b64: buf.toString('base64'), encrypted: true });
      }
      return sendJSON(res, 200, { content: file.data, encrypted: false });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Drive download failed', detail: e.message });
    }
  }

  return sendJSON(res, 404, { error: 'Unknown action', action, method });
};
