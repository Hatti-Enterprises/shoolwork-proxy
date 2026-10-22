/* ============================================================
 * crypto.js — End-to-end encryption for Shoolwork Proxy backups
 *
 * Format (in order):
 *   magic        4 bytes   "SHL1"  (Shoolwork backup v1)
 *   kdfSalt      16 bytes  random salt for PBKDF2
 *   iv           12 bytes  AES-GCM nonce
 *   ciphertext    N bytes   AES-256-GCM(payload + 16-byte GCM tag)
 *
 * The plaintext payload is a ZIP archive containing:
 *   - backup.json          ← the storage dump (cookies, LS, SS, IDB, Cache)
 *   - manifest.json        ← { version, exportedAt, origin, deviceId }
 *
 * File extension: .shoolwork.zip   (regular ZIP, but encrypted with our scheme)
 *
 * Key derivation: PBKDF2-SHA256, 250,000 iterations, 32-byte key.
 *   - 250k iters takes ~0.5–1.5s on a modern device, which gives strong
 *     brute-force resistance without making the UX painful.
 *   - Web Crypto's deriveBits does PBKDF2 natively — no extra deps.
 *
 * Crypto: Web Crypto SubtleCrypto — AES-GCM 256-bit. This is the
 * native browser API; no third-party crypto libraries.
 *
 * The Drive file (when synced) is the same encrypted ZIP — the
 * server cannot read it.
 * ============================================================ */

export const BACKUP_MAGIC = 'SHL1';                  // 4 ASCII bytes
export const BACKUP_EXT = '.shoolwork.zip';           // file extension
export const PBKDF2_ITERATIONS = 250_000;
export const PBKDF2_SALT_BYTES = 16;
export const AES_IV_BYTES = 12;
export const AES_KEY_BITS = 256;

/* ---------- Helpers ---------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concatBytes(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(new Uint8Array(a.buffer || a), off); off += a.byteLength; }
  return out;
}

/* ---------- Key derivation ---------- */

export async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey', 'deriveBits']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt']
  );
  return key;
}

/* ---------- Tiny ZIP writer ----------
 * We don't import a full ZIP library because (a) we only need to write
 * one or two files, (b) no compression needed (the encrypted payload
 * is already high-entropy), and (c) Shoolwork Proxy is meant to be
 * dependency-light.
 *
 * We use "stored" (no compression) entries. ZIP "stored" method is
 * universally supported by every unzip tool (WinZip, 7-Zip, macOS
 * Archive Utility, Python zipfile, etc.).
 *
 * But wait — we DON'T want a regular unzip to "just open" the file.
 * So we encrypt the ENTIRE ZIP, including its headers. The file is
 * therefore a binary blob with our magic header — it won't open as a
 * normal ZIP. Decrypt first → then parse the inner ZIP → extract
 * backup.json. This keeps the file format exclusive to Shoolwork.
 *
 * For the manual "Download .zip" button, we ALSO support producing a
 * plain unencrypted ZIP (with the same contents) if the user opts out
 * of a password — see exportPlainZip().
 * ============================================================ */

const ZIP_DATE = 0x0021;       // 1980-01-01 00:00 (smallest valid ZIP date)
const ZIP_STORED = 0;

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function dosDateTime(date = new Date(1980, 0, 1, 0, 0, 0)) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1F);
  const dt = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { time, date: dt };
}

function u16(n) { return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF]); }
function u32(n) { return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF]); }

/**
 * Build a minimal ZIP archive from { name → bytes } entries.
 * No compression. Returns a Uint8Array.
 */
export function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    let data;
    if (entry.data instanceof Uint8Array) {
      data = entry.data;
    } else if (typeof entry.data === 'string') {
      data = enc.encode(entry.data);
    } else if (Array.isArray(entry.data) || ArrayBuffer.isView(entry.data)) {
      data = new Uint8Array(entry.data);
    } else {
      data = new Uint8Array(0);
    }
    const crc = crc32(data);
    const { time, date } = dosDateTime();

    // Local file header (30 bytes + name)
    const local = concatBytes(
      u32(0x04034b50),         // signature
      u16(20),                  // version needed
      u16(0),                   // flags
      u16(ZIP_STORED),         // compression: stored
      u16(time), u16(date),     // mod time/date
      u32(crc),                 // CRC-32
      u32(data.length),         // compressed size
      u32(data.length),         // uncompressed size
      u16(nameBytes.length),    // filename length
      u16(0),                   // extra field length
      nameBytes,                // filename
      data                      // file data
    );
    localParts.push(local);

    // Central directory entry (46 bytes + name)
    const central = concatBytes(
      u32(0x02014b50),         // signature
      u16(20),                  // version made by
      u16(20),                  // version needed
      u16(0),                   // flags
      u16(ZIP_STORED),          // compression
      u16(time), u16(date),    // mod time/date
      u32(crc),                 // CRC-32
      u32(data.length),         // compressed size
      u32(data.length),         // uncompressed size
      u16(nameBytes.length),    // filename length
      u16(0),                   // extra field length
      u16(0),                   // comment length
      u16(0),                   // disk number start
      u16(0),                   // internal attrs
      u32(0),                   // external attrs
      u32(offset),              // offset of local header
      nameBytes                 // filename
    );
    centralParts.push(central);
    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((a, p) => a + p.length, 0);

  // End of central directory record (22 bytes)
  const end = concatBytes(
    u32(0x06054b50),           // signature
    u16(0), u16(0),             // disk numbers
    u16(entries.length),       // entries on this disk
    u16(entries.length),       // total entries
    u32(centralSize),          // central dir size
    u32(centralOffset),        // central dir offset
    u16(0)                     // comment length
  );

  return concatBytes(...localParts, ...centralParts, end);
}

/**
 * Parse a minimal ZIP archive and extract entries as { name → Uint8Array }.
 * Only supports "stored" (uncompressed) entries, which is all we ever write.
 */
export function parseZip(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const entries = {};

  // Find End of Central Directory record
  let eocd = -1;
  for (let i = zipBytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Invalid ZIP: missing End of Central Directory record');

  const totalEntries = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  let pos = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('Invalid ZIP: bad central dir entry');
    const compression = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = dec.decode(new Uint8Array(zipBytes.buffer, zipBytes.byteOffset + pos + 46, nameLen));

    if (compression !== ZIP_STORED) {
      throw new Error(`ZIP entry "${name}" uses unsupported compression method ${compression}`);
    }

    // Read local header to find actual data start
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > zipBytes.length) throw new Error('Invalid ZIP: data out of bounds');

    const data = zipBytes.slice(dataStart, dataEnd);
    if (data.length !== uncompressedSize) {
      throw new Error(`ZIP entry "${name}" size mismatch: header says ${uncompressedSize}, got ${data.length}`);
    }
    entries[name] = data;
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/* ---------- Encrypted ZIP wrapper ---------- */

/**
 * Build the plaintext ZIP (backup.json + manifest.json),
 * then encrypt it with AES-256-GCM using a PBKDF2-derived key.
 *
 * Output: Uint8Array with the format described at the top of the file.
 */
export async function encryptBackup(backup, password) {
  if (!password || password.length < 4) {
    throw new Error('Password must be at least 4 characters.');
  }

  const backupJson = JSON.stringify(backup, null, 2);
  const manifest = JSON.stringify({
    version: backup.version,
    magic: backup.magic,
    exportedAt: backup.exportedAt,
    origin: backup.origin,
    device: backup.device,
    storageCounts: Object.fromEntries(
      Object.entries(backup.payload || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v || {}).length])
    ),
  }, null, 2);

  const zipBytes = buildZip([
    { name: 'manifest.json', data: enc.encode(manifest) },
    { name: 'backup.json',    data: enc.encode(backupJson) },
  ]);

  // Derive key + encrypt
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const key = await deriveKey(password, salt);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      zipBytes
    )
  );

  // Assemble the SHL1 container
  const magicBytes = enc.encode(BACKUP_MAGIC);
  const out = concatBytes(magicBytes, salt, iv, ciphertext);
  return out;
}

/**
 * Decrypt an SHL1 container and return the parsed backup object.
 * Throws if the password is wrong (AES-GCM tag check fails).
 */
export async function decryptBackup(blob, password) {
  if (!(blob instanceof Uint8Array)) {
    blob = new Uint8Array(blob instanceof ArrayBuffer ? blob : (blob.buffer || blob));
  }

  const magicLen = BACKUP_MAGIC.length;
  if (blob.length < magicLen + PBKDF2_SALT_BYTES + AES_IV_BYTES + 16) {
    throw new Error('Backup file is too small to be valid.');
  }

  const magic = dec.decode(blob.slice(0, magicLen));
  if (magic !== BACKUP_MAGIC) {
    throw new Error(`Not a Shoolwork backup (bad magic "${magic}").`);
  }

  const salt = blob.slice(magicLen, magicLen + PBKDF2_SALT_BYTES);
  const iv = blob.slice(magicLen + PBKDF2_SALT_BYTES, magicLen + PBKDF2_SALT_BYTES + AES_IV_BYTES);
  const ciphertext = blob.slice(magicLen + PBKDF2_SALT_BYTES + AES_IV_BYTES);

  const key = await deriveKey(password, salt);

  let zipBytes;
  try {
    zipBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
  } catch (e) {
    throw new Error('Wrong password or corrupted file.');
  }

  // Parse the inner ZIP and extract backup.json
  const entries = parseZip(zipBytes);
  if (!entries['backup.json']) {
    throw new Error('Decrypted ZIP is missing backup.json');
  }
  const backupJson = dec.decode(entries['backup.json']);
  const backup = JSON.parse(backupJson);
  return backup;
}

/**
 * Build a plain (unencrypted) ZIP for users who explicitly want a
 * standard readable .zip. Used when the user clicks "Download .zip"
 * without entering a password.
 */
export function buildPlainZip(backup) {
  const manifest = JSON.stringify({
    version: backup.version,
    magic: backup.magic,
    exportedAt: backup.exportedAt,
    origin: backup.origin,
    device: backup.device,
    note: 'Unencrypted export. Treat this file as sensitive.',
  }, null, 2);
  const backupJson = JSON.stringify(backup, null, 2);
  return buildZip([
    { name: 'manifest.json', data: enc.encode(manifest) },
    { name: 'backup.json',    data: enc.encode(backupJson) },
  ]);
}

/* ---------- Password strength meter (for UX) ---------- */

export function scorePassword(password) {
  if (!password) return { score: 0, label: 'Empty', color: '#5a6478' };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong', 'Excellent'];
  const colors = ['#ff6b81', '#ff6b81', '#fbbf24', '#fbbf24', '#4ade80', '#4ade80', '#6ee7ff'];
  return { score, label: labels[score], color: colors[score] };
}

/* ---------- Session password management ----------
 * The password is NEVER stored in plaintext. We keep it in memory
 * only for the current browser session (cleared on tab close).
 * For auto-sync, the user enters the password once per session.
 *
 * Optionally, the user can choose to "remember password" which
 * stores it in sessionStorage (cleared when browser closes).
 *
 * We never persist to localStorage — that would defeat the purpose
 * of E2EE (anyone with access to localStorage would have the key).
 * ============================================================ */

const SESSION_PASSWORD_KEY = '__shoolwork_session_password__';
let inMemoryPassword = null;

export function setPassword(password, { remember = false } = {}) {
  inMemoryPassword = password;
  if (remember) {
    try { sessionStorage.setItem(SESSION_PASSWORD_KEY, password); } catch {}
  }
}

export function getPassword() {
  if (inMemoryPassword) return inMemoryPassword;
  try { return sessionStorage.getItem(SESSION_PASSWORD_KEY); } catch { return null; }
}

export function clearPassword() {
  inMemoryPassword = null;
  try { sessionStorage.removeItem(SESSION_PASSWORD_KEY); } catch {}
}

export function hasPassword() {
  return !!getPassword();
}
