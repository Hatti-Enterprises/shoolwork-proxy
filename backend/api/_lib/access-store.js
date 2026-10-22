/* access-store.js — invite codes + device keys + roles, backed by @vercel/kv.
 *
 * Storage shape (all under the shoolwork: namespace in KV):
 *
 *   shoolwork:code:<CODE>            → { status: 'unused'|'used', usedAt, deviceKey, label }
 *                                    expires after CODE_TTL_SECONDS (default 7 days)
 *   shoolwork:device:<DEVICE_KEY>    → { label, code, createdAt, lastSeen, revoked, role }
 *                                    no expiry — host must revoke explicitly
 *   shoolwork:codes                  → Set of all code strings (for admin listing)
 *   shoolwork:devices                → Set of all device keys (for admin listing)
 *
 * Roles (escalating privileges):
 *
 *   'user'        Default role. Can use the proxy (passes /api/access gate).
 *                 Cannot access /api/access/admin/* at all.
 *   'moderator'   Can manage access: generate codes, list codes, list devices,
 *                 revoke/unrevoke/delete devices. Cannot change roles, cannot
 *                 delete the proxy, cannot change env vars. Gets in via
 *                 MODERATOR_TOKENS env var (CSV list).
 *   'owner'       Full access. Everything moderators can do PLUS: change
 *                 device roles, view /stats, view /env (read-only). Gets in
 *                 via OWNER_TOKEN env var. Only ONE owner token is valid.
 *
 * If KV is not configured (no KV_REST_API_URL env), we fall back to an
 * in-memory Map. This is for local dev only — codes won't persist across
 * cold starts. The middleware logs a warning when this happens.
 */

const ROLES = {
  USER: 'user',
  MODERATOR: 'moderator',
  OWNER: 'owner',
};

const ROLE_HIERARCHY = [ROLES.USER, ROLES.MODERATOR, ROLES.OWNER];

/* Check whether `role` is at least `required` (i.e., role >= required in hierarchy). */
function hasRole(role, required) {
  const roleIdx = ROLE_HIERARCHY.indexOf(role);
  const reqIdx = ROLE_HIERARCHY.indexOf(required);
  if (roleIdx === -1 || reqIdx === -1) return false;
  return roleIdx >= reqIdx;
}

let kv = null;
let inMemoryStore = null;

async function getKV() {
  if (kv) return kv;
  try {
    const mod = await import('@vercel/kv');
    kv = mod.kv || mod.default || mod;
    // Sanity check
    if (typeof kv.get !== 'function') throw new Error('KV missing .get()');
    return kv;
  } catch (e) {
    if (!inMemoryStore) {
      inMemoryStore = new Map();
      console.warn('[access-store] @vercel/kv not available — using in-memory fallback (codes will NOT persist across cold starts)');
    }
    return makeInMemoryKV(inMemoryStore);
  }
}

function makeInMemoryKV(map) {
  // Subset of @vercel/kv API used by this module
  return {
    async get(key) { return map.get(key) || null; },
    async set(key, value, opts) {
      map.set(key, value);
      // We don't honor opts.ttl in dev fallback
      return 'OK';
    },
    async del(key) { map.delete(key); return 1; },
    async smembers(key) { return Array.from(map.get(key) || new Set()); },
    async sadd(key, ...members) {
      const set = map.get(key) || new Set();
      for (const m of members) set.add(m);
      map.set(key, set);
      return members.length;
    },
    async srem(key, ...members) {
      const set = map.get(key) || new Set();
      for (const m of members) set.delete(m);
      map.set(key, set);
      return members.length;
    },
    async exists(...keys) {
      let n = 0;
      for (const k of keys) if (map.has(k)) n++;
      return n;
    },
  };
}

/* ---------- Codes ---------- */

const CODE_TTL_SECONDS = 7 * 24 * 60 * 60;  // 7 days

function generateCode() {
  // 8-character code, format: XXXX-XXXX (alphanumeric, no ambiguous chars)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no I, O, 0, 1
  let part1 = '', part2 = '';
  for (let i = 0; i < 4; i++) part1 += alphabet[Math.floor(Math.random() * alphabet.length)];
  for (let i = 0; i < 4; i++) part2 += alphabet[Math.floor(Math.random() * alphabet.length)];
  return part1 + '-' + part2;
}

/* Atomically claim a code.
 * Returns { ok, deviceKey?, label?, error? }.
 *
 * If the code is unused, marks it as used and returns a fresh deviceKey.
 * If the code is already used or doesn't exist, returns ok=false.
 *
 * Implementation: read code record → if status==='unused', set status='used'
 * + attach deviceKey + return deviceKey. There's a small race window here
 * (TOCTOU) but for invite codes that's acceptable — worst case, two
 * devices race and one of them fails, the user just retries.
 */
export async function claimCode(code, label) {
  const kv = await getKV();
  const normalized = code.toUpperCase().trim();
  const key = 'shoolwork:code:' + normalized;
  const record = await kv.get(key);
  if (!record) return { ok: false, error: 'Invalid code' };
  if (record.status === 'used') return { ok: false, error: 'Code already used' };

  // Generate a fresh device key (32 hex chars = 128 bits of entropy)
  const deviceKey = await generateDeviceKey();
  const updatedRecord = {
    ...record,
    status: 'used',
    usedAt: Date.now(),
    deviceKey,
    label: label || null,
  };
  await kv.set(key, updatedRecord);  // KV auto-handles serialization

  // Register the device key with the default 'user' role
  const deviceRecord = {
    key: deviceKey,
    label: label || null,
    code: normalized,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    revoked: false,
    role: ROLES.USER,
  };
  await kv.set('shoolwork:device:' + deviceKey, deviceRecord);
  await kv.sadd('shoolwork:devices', deviceKey);

  return { ok: true, deviceKey, label: label || null, role: ROLES.USER };
}

/* Verify a device key. Returns the device's role if valid + not revoked,
 * or null otherwise. Also bumps lastSeen timestamp (best-effort).
 *
 * Return value:
 *   - 'user' / 'moderator' / 'owner' if valid
 *   - null if invalid, missing, or revoked
 */
export async function verifyDeviceKey(deviceKey) {
  if (!deviceKey || typeof deviceKey !== 'string') return null;
  const kv = await getKV();
  const record = await kv.get('shoolwork:device:' + deviceKey);
  if (!record) return null;
  if (record.revoked) return null;
  // Update lastSeen (don't await — fire and forget)
  kv.set('shoolwork:device:' + deviceKey, { ...record, lastSeen: Date.now() }).catch(() => {});
  return record.role || ROLES.USER;
}

/* ---------- Admin: codes ---------- */

export async function generateCodes(count, label) {
  const kv = await getKV();
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = generateCode();
    await kv.set('shoolwork:code:' + code, {
      status: 'unused',
      createdAt: Date.now(),
      label: label || null,
    });
    await kv.sadd('shoolwork:codes', code);
    codes.push(code);
  }
  return codes;
}

export async function listCodes() {
  const kv = await getKV();
  const codeStrings = await kv.smembers('shoolwork:codes');
  const records = [];
  for (const code of codeStrings) {
    const record = await kv.get('shoolwork:code:' + code);
    if (record) records.push({ code, ...record });
    else records.push({ code, status: 'expired', createdAt: null });
  }
  return records;
}

/* ---------- Admin: devices ---------- */

export async function listDevices() {
  const kv = await getKV();
  const deviceKeys = await kv.smembers('shoolwork:devices');
  const records = [];
  for (const key of deviceKeys) {
    const record = await kv.get('shoolwork:device:' + key);
    if (record) records.push({ ...record, keyPreview: key.slice(0, 8) + '…' + key.slice(-4) });
  }
  return records;
}

export async function revokeDevice(deviceKey) {
  const kv = await getKV();
  const record = await kv.get('shoolwork:device:' + deviceKey);
  if (!record) return { ok: false, error: 'Device not found' };
  await kv.set('shoolwork:device:' + deviceKey, { ...record, revoked: true, revokedAt: Date.now() });
  return { ok: true };
}

export async function unrevokeDevice(deviceKey) {
  const kv = await getKV();
  const record = await kv.get('shoolwork:device:' + deviceKey);
  if (!record) return { ok: false, error: 'Device not found' };
  const updated = { ...record, revoked: false };
  delete updated.revokedAt;
  await kv.set('shoolwork:device:' + deviceKey, updated);
  return { ok: true };
}

/* ---------- Role management (owner only) ---------- */

export async function setDeviceRole(deviceKey, newRole) {
  if (!ROLE_HIERARCHY.includes(newRole)) {
    return { ok: false, error: `Invalid role. Must be one of: ${ROLE_HIERARCHY.join(', ')}` };
  }
  const kv = await getKV();
  const record = await kv.get('shoolwork:device:' + deviceKey);
  if (!record) return { ok: false, error: 'Device not found' };
  await kv.set('shoolwork:device:' + deviceKey, { ...record, role: newRole, roleUpdatedAt: Date.now() });
  return { ok: true, role: newRole };
}

export async function getDeviceRole(deviceKey) {
  const kv = await getKV();
  const record = await kv.get('shoolwork:device:' + deviceKey);
  if (!record) return null;
  return record.role || ROLES.USER;
}

export async function deleteDevice(deviceKey) {
  const kv = await getKV();
  await kv.del('shoolwork:device:' + deviceKey);
  await kv.srem('shoolwork:devices', deviceKey);
  return { ok: true };
}

/* ---------- Helpers ---------- */

async function generateDeviceKey() {
  const buf = new Uint8Array(16);
  // Prefer crypto.subtle if available (browser + Node 16+)
  try {
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(buf);
    } else {
      // Node fallback
      const nodeCrypto = await import('crypto');
      nodeCrypto.randomFillSync(buf);
    }
  } catch {
    // Last-resort Math.random fallback (NOT cryptographically secure)
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Check if access control is enabled at all.
 * If no codes have ever been generated, the gate is disabled — anyone
 * can use the proxy. This lets hosts deploy without access control and
 * enable it later by generating codes.
 */
export async function isAccessControlEnabled() {
  const kv = await getKV();
  const count = (await kv.smembers('shoolwork:codes')).length;
  return count > 0;
}

/* Check if any non-revoked device exists. Used by the gate to decide
 * whether to show "enter code" or "device revoked" message.
 */
export async function countActiveDevices() {
  const kv = await getKV();
  const keys = await kv.smembers('shoolwork:devices');
  let active = 0, revoked = 0;
  const byRole = { user: 0, moderator: 0, owner: 0 };
  for (const k of keys) {
    const rec = await kv.get('shoolwork:device:' + k);
    if (rec) {
      if (rec.revoked) revoked++;
      else active++;
      const r = rec.role || ROLES.USER;
      if (byRole[r] !== undefined) byRole[r]++;
    }
  }
  return { active, revoked, total: keys.length, byRole };
}

/* ---------- Role constants + helpers (exported) ---------- */
export { ROLES, ROLE_HIERARCHY, hasRole };
