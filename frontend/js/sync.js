/* ============================================================
 * sync.js — Google Drive sync for browser storage backups
 *
 * E2EE flow:
 *   1. User enters a password (session-only; never persisted to disk)
 *   2. On export: storage.js → backup JSON → crypto.js encrypts with
 *      AES-256-GCM (PBKDF2-derived key) → encrypted ZIP blob
 *   3. Encrypted blob is uploaded to Drive as
 *      "shoolwork-proxy-backup.shoolwork.zip" in appDataFolder
 *   4. On restore: download encrypted blob → decrypt with password →
 *      unzip → parse backup.json → importBackup() applies it
 *
 * The Drive file is unreadable without the password. Even if Drive
 * is compromised, the backup remains encrypted.
 *
 * Modes:
 *   - Auto-sync (interval + beforeunload + focus) — uses session password
 *   - Manual export / import (Drive)
 *   - Manual download .zip (local file, encrypted)
 *   - Manual upload .zip (local file → decrypt → restore)
 * ============================================================ */

import { exportBackup, importBackup, humanSize } from './storage.js';
import {
  encryptBackup, decryptBackup, buildPlainZip,
  setPassword, getPassword, clearPassword, hasPassword,
  scorePassword, BACKUP_EXT,
} from './crypto.js';
// Use the access-aware apiFetch from access.js — adds X-Device-Key header
import { apiFetch } from './access.js';

// BACKEND_URL is set in the inline <script> at the top of index.html
// before this module loads. Used for redirect-based auth (sign in).
const BACKEND_URL = (typeof window !== 'undefined' && window.SHoolworkBackendUrl) || '';

const DRIVE_FILENAME = 'shoolwork-proxy-backup' + BACKUP_EXT;
const DRIVE_FOLDER = 'appDataFolder';
const SETTINGS_KEY = 'shoolwork:settings';
const SYNC_STATE_KEY = 'shoolwork:sync-state';

let autoSyncTimer = null;

/* ---------- Service provider mode ----------
 * 'full'   → Google Drive + manual file export/import
 * 'manual' → manual file export/import only (Drive UI hidden)
 */
function providerMode() {
  return getSettings().serviceProviderMode || 'full';
}
function isDriveEnabled() {
  return providerMode() === 'full';
}

/* ---------- Settings ---------- */
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}

function getSyncState() {
  try { return JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || '{}'); }
  catch { return {}; }
}

function setSyncState(patch) {
  const cur = getSyncState();
  const next = Object.assign({}, cur, patch);
  localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(next));
  return next;
}

/* ---------- UI wiring ---------- */
export function initSyncUI() {
  // Password modal buttons
  document.getElementById('pwdSetBtn')?.addEventListener('click', () => openPasswordModal('set'));
  document.getElementById('pwdEnterBtn')?.addEventListener('click', () => openPasswordModal('enter'));
  document.getElementById('pwdClearBtn')?.addEventListener('click', clearPasswordHandler);
  document.getElementById('pwdModalClose')?.addEventListener('click', closePasswordModal);
  document.getElementById('pwdModalCancel')?.addEventListener('click', closePasswordModal);
  document.getElementById('pwdModalSubmit')?.addEventListener('click', submitPasswordModal);
  document.getElementById('pwdModalInput')?.addEventListener('input', updatePasswordStrength);
  document.getElementById('pwdModalInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitPasswordModal();
    if (e.key === 'Escape') closePasswordModal();
  });
  document.getElementById('pwdModalRemember')?.addEventListener('change', e => {
    const confirmLbl = document.getElementById('pwdModalConfirmWrap');
    if (confirmLbl) confirmLbl.hidden = !e.target.checked;
  });
  document.getElementById('pwdToggleShow')?.addEventListener('click', () => {
    const input = document.getElementById('pwdModalInput');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  document.querySelector('#pwdModal .modal__backdrop')?.addEventListener('click', closePasswordModal);

  // Main action buttons
  document.getElementById('signinBtn')?.addEventListener('click', startSignIn);
  document.getElementById('signoutBtn')?.addEventListener('click', signOut);
  document.getElementById('exportNowBtn')?.addEventListener('click', () => pushBackup({ manual: true }));
  document.getElementById('importNowBtn')?.addEventListener('click', pullAndRestore);
  document.getElementById('downloadJsonBtn')?.addEventListener('click', downloadLocalBackup);
  document.getElementById('uploadJsonBtn')?.addEventListener('click', uploadAndRestore);

  // Update capability table
  updateCapabilityTable();

  // Apply current service provider mode (hide Drive UI if manual-only)
  applyProviderModeUI();

  // React live when the host flips the toggle in Settings
  window.addEventListener('shoolwork:provider-mode-changed', () => applyProviderModeUI());

  // Check session status on load — only relevant in full mode
  if (isDriveEnabled()) {
    refreshAuthState().then(state => {
      if (state.signedIn) {
        document.getElementById('syncSignin').hidden = true;
        document.getElementById('syncActions').hidden = false;
        document.getElementById('syncMeta').hidden = false;
        setStatus('online', 'Signed in · last backup ' + (getSyncState().lastBackup || 'never'));
        maybeAutoSync();
      } else {
        setStatus('offline', 'Not signed in');
      }
    });
  } else {
    // Manual-only mode: skip Drive auth check, show manual-only status
    const actions = document.getElementById('syncActions');
    if (actions) actions.hidden = false; // show the manual export/import buttons
    setStatus('online', 'Manual mode · Drive sync disabled');
  }

  // Update password panel state
  refreshPasswordPanel();

  // Auto-sync triggers — only fire when Drive is enabled
  window.addEventListener('focus', () => {
    if (!isDriveEnabled()) return;
    const s = getSettings();
    if (s.autoSync && hasPassword()) pullAndRestore({ silent: true }).catch(() => {});
  });
  window.addEventListener('beforeunload', () => {
    if (!isDriveEnabled()) return;
    const s = getSettings();
    if (s.syncOnUnload && hasPassword()) {
      pushBackup({ beacon: true }).catch(() => {});
    }
  });
}

/* ---------- Provider mode UI ---------- */
function applyProviderModeUI() {
  const mode = providerMode();
  const driveEnabled = mode === 'full';

  // Update the sync view title + subtitle to match the mode
  const title = document.getElementById('syncTitle');
  const subtitle = document.getElementById('syncSubtitle');
  if (title) {
    title.textContent = driveEnabled ? 'Google Drive Sync' : 'Manual Backup';
  }
  if (subtitle) {
    if (driveEnabled) {
      subtitle.innerHTML = 'End-to-end encrypted backup of all browser storage — cookies, localStorage, sessionStorage, IndexedDB, Cache API. Encrypted with <strong>AES-256-GCM</strong> using a password-derived key (PBKDF2, 250k iterations). The Drive file is unreadable without your password.';
    } else {
      subtitle.innerHTML = 'End-to-end encrypted backup of all browser storage — cookies, localStorage, sessionStorage, IndexedDB, Cache API. Encrypted with <strong>AES-256-GCM</strong> using a password-derived key (PBKDF2, 250k iterations). Drive sync is disabled by the host — use the manual export/import buttons below to back up to a local <code>.shoolwork.zip</code> file.';
    }
  }

  // Hide Drive-only UI elements when in manual mode
  const driveOnly = [
    'syncSignin',       // "Sign in with Google" panel
    'syncStatus',       // Drive connection status dot
    'syncMeta',         // last backup / size / encryption / devices
  ];
  for (const id of driveOnly) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = !driveEnabled;
    el.classList.toggle('is-drive-only', !driveEnabled);
  }

  // Hide auto-sync setting rows in the Settings view when Drive is disabled
  document.querySelectorAll('.setting[data-key="autoSync"], .setting[data-key="autoSyncInterval"], .setting[data-key="syncOnUnload"]')
    .forEach(el => { el.hidden = !driveEnabled; });
  document.querySelectorAll('.settings__group[data-group="sync"] h2')
    .forEach(h => { h.textContent = driveEnabled ? 'Google Drive Sync' : 'Manual Sync'; });

  // Always show the manual export/import buttons
  const actions = document.getElementById('syncActions');
  if (actions) {
    actions.hidden = false;
    // In manual mode, hide the Drive-only action buttons (Export now / Restore now / Sign out)
    actions.querySelectorAll('[data-drive-only]').forEach(b => { b.hidden = !driveEnabled; });
  }

  // Update chrome nav label (Home / Proxy / Settings / Drive Sync)
  const navBtn = document.querySelector('.chrome__nav-btn[data-view="sync"]');
  if (navBtn) navBtn.textContent = driveEnabled ? 'Drive Sync' : 'Backup';

  // If switching to manual mode while signed in, sign out cleanly
  if (!driveEnabled) {
    refreshAuthState().then(state => {
      if (state.signedIn) signOut().catch(() => {});
    });
    // Stop the auto-sync timer
    if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  }
}

function updateCapabilityTable() {
  const s = getSettings();
  const cell = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.textContent = s[key] === false ? 'No' : 'Yes';
  };
  cell('capCookies', 'syncCookies');
  cell('capLS', 'syncLocalStorage');
  cell('capSS', 'syncSessionStorage');
  cell('capIDB', 'syncIndexedDB');
  cell('capCache', 'syncCacheAPI');
}

function setStatus(kind, text) {
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncStatusText');
  if (dot) {
    dot.classList.remove('is-offline', 'is-syncing', 'is-online', 'is-error');
    dot.classList.add('is-' + kind);
  }
  if (txt) txt.textContent = text;
}

/* ---------- Password modal ---------- */

function openPasswordModal(mode) {
  const modal = document.getElementById('pwdModal');
  const title = document.getElementById('pwdModalTitle');
  const subtitle = document.getElementById('pwdModalSubtitle');
  const input = document.getElementById('pwdModalInput');
  const rememberLbl = document.getElementById('pwdModalRememberWrap');
  const confirmLbl = document.getElementById('pwdModalConfirmWrap');
  const submitBtn = document.getElementById('pwdModalSubmit');
  const hint = document.getElementById('pwdModalHint');

  if (!modal) return;

  modal.dataset.mode = mode;
  input.value = '';
  if (hint) hint.textContent = '';
  if (confirmLbl) confirmLbl.hidden = true;

  if (mode === 'set') {
    if (title) title.textContent = 'Set backup password';
    if (subtitle) subtitle.textContent = 'This password encrypts your browser backup with AES-256. Without it, nobody can read your backup — not even us. Store it safely; we cannot recover it.';
    if (submitBtn) submitBtn.textContent = 'Set password';
    if (rememberLbl) rememberLbl.hidden = false;
    input.type = 'password';
    input.placeholder = 'Choose a password (min 8 chars recommended)';
  } else if (mode === 'enter') {
    if (title) title.textContent = 'Enter backup password';
    if (subtitle) subtitle.textContent = 'Enter the password you used to encrypt this backup. Drive sync will use it for the rest of this session.';
    if (submitBtn) submitBtn.textContent = 'Unlock';
    if (rememberLbl) rememberLbl.hidden = false;
    input.type = 'password';
    input.placeholder = 'Your backup password';
  }

  modal.hidden = false;
  setTimeout(() => input.focus(), 50);
}

function closePasswordModal() {
  const modal = document.getElementById('pwdModal');
  if (modal) modal.hidden = true;
}

function updatePasswordStrength() {
  const input = document.getElementById('pwdModalInput');
  const meter = document.getElementById('pwdStrengthMeter');
  const label = document.getElementById('pwdStrengthLabel');
  if (!input || !meter) return;
  const { score, label: lbl, color } = scorePassword(input.value);
  meter.value = score;
  if (label) {
    label.textContent = lbl;
    label.style.color = color;
  }
}

function submitPasswordModal() {
  const modal = document.getElementById('pwdModal');
  const input = document.getElementById('pwdModalInput');
  const confirmInput = document.getElementById('pwdModalConfirm');
  const rememberChk = document.getElementById('pwdModalRemember');
  const hint = document.getElementById('pwdModalHint');
  const mode = modal?.dataset.mode;
  const password = input?.value || '';

  if (password.length < 4) {
    if (hint) { hint.textContent = 'Password must be at least 4 characters.'; hint.style.color = 'var(--danger)'; }
    return;
  }

  if (mode === 'set') {
    if (rememberChk?.checked && confirmInput?.value !== password) {
      if (hint) { hint.textContent = 'Passwords do not match.'; hint.style.color = 'var(--danger)'; }
      return;
    }
    setPassword(password, { remember: !!rememberChk?.checked });
    toast('Backup password set', 'success');
    closePasswordModal();
  } else if (mode === 'enter') {
    setPassword(password, { remember: !!rememberChk?.checked });
    toast('Backup password set', 'success');
    closePasswordModal();
    // If signed in, immediately try to pull & decrypt to verify the password
    refreshAuthState().then(state => {
      if (state.signedIn) pullAndRestore({ silent: true, verifyOnly: true }).catch(() => {});
    });
  }

  refreshPasswordPanel();
}

function clearPasswordHandler() {
  clearPassword();
  toast('Session password cleared', 'info');
  refreshPasswordPanel();
}

function refreshPasswordPanel() {
  const has = hasPassword();
  const set = document.getElementById('pwdSetBtn');
  const enter = document.getElementById('pwdEnterBtn');
  const clear = document.getElementById('pwdClearBtn');
  const indicator = document.getElementById('pwdIndicator');
  if (set) set.hidden = has;
  if (enter) enter.hidden = has;
  if (clear) clear.hidden = !has;
  if (indicator) {
    indicator.textContent = has ? 'Password set for this session' : 'No password — backups cannot be encrypted';
    indicator.style.color = has ? 'var(--success)' : 'var(--warning)';
  }
}

/* ---------- Auth ---------- */

export async function refreshAuthState() {
  try {
    const res = await apiFetch('/api/auth?status=1', { credentials: 'include' });
    if (!res.ok) return { signedIn: false };
    return await res.json();
  } catch {
    return { signedIn: false };
  }
}

export function startSignIn() {
  // Redirect to backend's auth endpoint, passing our current URL as return_to
  const returnUrl = window.location.origin + window.location.pathname;
  window.location.href = BACKEND_URL + '/api/auth?start=1&return_to=' + encodeURIComponent(returnUrl);
}

export async function signOut() {
  try { await apiFetch('/api/auth?signout=1', { method: 'POST', credentials: 'include' }); } catch {}
  clearPassword();
  setSyncState({ lastBackup: null, lastSize: null });
  setStatus('offline', 'Signed out');
  location.reload();
}

/* ---------- Drive operations (via backend proxy) ---------- */

async function driveFindFile() {
  const res = await apiFetch('/api/sync?action=find', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to query Drive');
  const data = await res.json();
  return data.fileId || null;
}

async function driveUpload(content) {
  // content is an encrypted Uint8Array. We base64 it for JSON transport.
  const b64 = bytesToBase64(content);
  const res = await apiFetch('/api/sync?action=upload', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: DRIVE_FILENAME,
      content_b64: b64,
      folder: DRIVE_FOLDER,
      encrypted: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Upload failed: ' + err);
  }
  return res.json();
}

async function driveDownload(fileId) {
  const res = await apiFetch('/api/sync?action=download&fileId=' + encodeURIComponent(fileId), { credentials: 'include' });
  if (!res.ok) throw new Error('Download failed');
  const data = await res.json();
  if (data.content_b64) return base64ToBytes(data.content_b64);
  if (data.content) {
    // Backward-compat: unencrypted JSON from older versions
    // (will fail decrypt with a clear error message)
    const json = JSON.stringify(data.content);
    return new TextEncoder().encode(json);
  }
  throw new Error('Drive file is empty or in an unsupported format.');
}

/* ---------- High-level ops ---------- */

export async function pushBackup({ manual = false, beacon = false } = {}) {
  const settings = getSettings();
  if (!settings.autoSync && !manual && !beacon) return;

  const password = getPassword();
  if (!password) {
    if (manual) {
      toast('Set a backup password first.', 'error');
      openPasswordModal('set');
    }
    return;
  }

  setStatus('syncing', 'Backing up (encrypting)…');
  try {
    const backup = await exportBackup({
      cookies: settings.syncCookies !== false,
      localStorage: settings.syncLocalStorage !== false,
      sessionStorage: settings.syncSessionStorage !== false,
      indexedDB: settings.syncIndexedDB !== false,
      cacheAPI: settings.syncCacheAPI !== false,
    });

    const encrypted = await encryptBackup(backup, password);
    const size = encrypted.byteLength;

    if (beacon) {
      // sendBeacon with a small JSON wrapper around base64
      const payload = JSON.stringify({
        filename: DRIVE_FILENAME,
        content_b64: bytesToBase64(encrypted),
        folder: DRIVE_FOLDER,
        encrypted: true,
      });
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(BACKEND_URL + '/api/sync?action=uploadBeacon', blob);
      setSyncState({ lastBackup: new Date().toISOString(), lastSize: humanSize(size) });
      return;
    }

    await driveUpload(encrypted);
    setSyncState({ lastBackup: new Date().toISOString(), lastSize: humanSize(size) });
    setStatus('online', `Backed up · ${humanSize(size)} · ${new Date().toLocaleTimeString()}`);
    toast(`Encrypted backup uploaded (${humanSize(size)})`, 'success');
    updateMeta();
  } catch (e) {
    setStatus('error', 'Backup failed: ' + e.message);
    toast('Backup failed: ' + e.message, 'error');
  }
}

export async function pullAndRestore({ silent = false, verifyOnly = false } = {}) {
  const password = getPassword();
  if (!password) {
    if (!silent) {
      toast('Enter your backup password first.', 'info');
      openPasswordModal('enter');
    }
    return null;
  }

  setStatus('syncing', 'Downloading & decrypting…');
  try {
    const fileId = await driveFindFile();
    if (!fileId) {
      setStatus('online', 'No backup found yet. Sign in and export to create one.');
      if (!silent) toast('No backup file in Drive yet', 'info');
      return null;
    }
    const encrypted = await driveDownload(fileId);
    if (!encrypted || encrypted.length === 0) {
      setStatus('online', 'Backup file is empty.');
      return null;
    }

    let backup;
    try {
      backup = await decryptBackup(encrypted, password);
    } catch (e) {
      // Wrong password
      setStatus('error', 'Wrong password — could not decrypt.');
      if (!silent) {
        toast('Wrong password. Re-enter your backup password.', 'error');
        openPasswordModal('enter');
      }
      return null;
    }

    if (verifyOnly) {
      setStatus('online', `Password verified · last backup ${getSyncState().lastBackup || 'just now'}`);
      if (!silent) toast('Password verified against Drive backup.', 'success');
      return { verified: true };
    }

    const settings = getSettings();
    const result = await importBackup(backup, {
      cookies: settings.syncCookies !== false,
      localStorage: settings.syncLocalStorage !== false,
      sessionStorage: settings.syncSessionStorage !== false,
      indexedDB: settings.syncIndexedDB !== false,
      cacheAPI: settings.syncCacheAPI !== false,
      clearFirst: true,
    });

    setStatus('online', `Restored · ${new Date().toLocaleTimeString()}`);
    if (!silent) toast(`Restored ${result.counts.localStorage + result.counts.indexedDB} stores`, 'success');
    return result;
  } catch (e) {
    setStatus('error', 'Restore failed: ' + e.message);
    if (!silent) toast('Restore failed: ' + e.message, 'error');
  }
}

export function downloadLocalBackup() {
  const password = getPassword();
  exportBackup().then(async backup => {
    let blob, filename;
    if (password) {
      const encrypted = await encryptBackup(backup, password);
      blob = new Blob([encrypted], { type: 'application/octet-stream' });
      filename = `shoolwork-proxy-backup-${new Date().toISOString().slice(0, 10)}${BACKUP_EXT}`;
      toast('Encrypted backup downloaded', 'success');
    } else {
      // Ask for a password
      const pwd = await promptPassword('Encrypt backup with password?');
      if (!pwd) {
        // Fall back to plain ZIP
        const zipBytes = buildPlainZip(backup);
        blob = new Blob([zipBytes], { type: 'application/zip' });
        filename = `shoolwork-proxy-backup-${new Date().toISOString().slice(0, 10)}.zip`;
        toast('Downloaded unencrypted ZIP (no password set)', 'info');
      } else {
        const encrypted = await encryptBackup(backup, pwd);
        blob = new Blob([encrypted], { type: 'application/octet-stream' });
        filename = `shoolwork-proxy-backup-${new Date().toISOString().slice(0, 10)}${BACKUP_EXT}`;
        toast('Encrypted backup downloaded', 'success');
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }).catch(e => toast('Download failed: ' + e.message, 'error'));
}

export function uploadAndRestore() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,' + BACKUP_EXT + ',application/zip,application/octet-stream';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());

      // Check if it's an encrypted SHL1 container
      const magic = new TextDecoder().decode(buf.slice(0, 4));
      let backup;
      if (magic === 'SHL1') {
        // Encrypted — need password
        let pwd = getPassword();
        if (!pwd) {
          pwd = await promptPassword('Enter password for this encrypted backup');
          if (!pwd) { toast('No password provided', 'error'); return; }
        }
        try {
          backup = await decryptBackup(buf, pwd);
        } catch (e) {
          // Maybe wrong session password — ask again
          pwd = await promptPassword('Wrong password. Re-enter password for this backup');
          if (!pwd) { toast('No password provided', 'error'); return; }
          backup = await decryptBackup(buf, pwd);
        }
        // Adopt the working password as the session password
        setPassword(pwd, { remember: false });
        refreshPasswordPanel();
      } else {
        // Try as plain ZIP
        try {
          const { parseZip } = await import('./crypto.js');
          const entries = parseZip(buf);
          if (!entries['backup.json']) throw new Error('Missing backup.json in ZIP');
          backup = JSON.parse(new TextDecoder().decode(entries['backup.json']));
        } catch {
          // Try as raw JSON
          backup = JSON.parse(new TextDecoder().decode(buf));
        }
      }

      const result = await importBackup(backup, { clearFirst: true });
      toast(`Restored ${result.counts.localStorage + result.counts.indexedDB} stores from file`, 'success');
    } catch (e) {
      toast('Invalid backup file: ' + e.message, 'error');
    }
  };
  input.click();
}

/* ---------- Password prompt (simple, no modal) ---------- */
function promptPassword(message) {
  // Use the modal flow by opening the modal and returning a promise
  return new Promise(resolve => {
    // For now, use a native prompt; could be replaced with a styled modal
    const pwd = window.prompt(message + ' (min 4 chars)', '');
    resolve(pwd && pwd.length >= 4 ? pwd : null);
  });
}

function updateMeta() {
  const state = getSyncState();
  const lb = document.getElementById('lastBackup');
  const ls = document.getElementById('lastSize');
  const dc = document.getElementById('deviceCount');
  if (lb) lb.textContent = state.lastBackup ? new Date(state.lastBackup).toLocaleString() : '—';
  if (ls) ls.textContent = state.lastSize || '—';
  if (dc) dc.textContent = state.deviceCount || '1';
}

/* ---------- Auto-sync scheduler ---------- */

export function maybeAutoSync() {
  const s = getSettings();
  if (!s.autoSync) {
    if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
    return;
  }
  const intervalMs = (parseInt(s.autoSyncInterval, 10) || 5) * 60 * 1000;
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  autoSyncTimer = setInterval(() => pushBackup({ manual: false }).catch(() => {}), intervalMs);
}

/* ---------- Bytes <-> base64 ---------- */

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function base64ToBytes(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------- Toast ---------- */
function toast(msg, kind = 'info') {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast is-' + kind;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 4000);
  setTimeout(() => el.remove(), 4500);
}

window.__shoolworkSync = { pushBackup, pullAndRestore, refreshAuthState, startSignIn, signOut };
