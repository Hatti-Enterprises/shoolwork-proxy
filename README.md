# Shoolwork Proxy

An Ultraviolet-based web proxy with Google Drive syncing for **browser storage backup & restore** (cookies, localStorage, sessionStorage, IndexedDB, Cache API — including saved game progress).

- **Frontend:** Static single-file HTML (everything inlined — CSS, JS, even the icon). Can be hosted on any static file host (Netlify, Cloudflare Pages, GitHub Pages, S3, etc.). Needs ONE accompanying file (`sw.js`, ~11KB) because the browser spec doesn't allow service workers to be inlined.
- **Backend:** Separate Vercel serverless deployment — Bare server (for Ultraviolet) + Google OAuth + Drive sync helpers. CORS-enabled for cross-origin frontend, with `SameSite=None; Secure; Partitioned` cookies so the Drive session works across origins.

## Architecture (two separate servers)

```
shoolwork-proxy/
├── README.md
├── frontend/                       # ← Deploy as static site (any host)
│   ├── index.html                  #   Single HTML file (~177KB, all CSS+JS inlined)
│   ├── sw.js                       #   Service worker (~11KB, can't be inlined per spec)
│   ├── embed.html                  #   Optional: iframe-friendly embed page (~10KB)
│   └── (source files used for rebuilding:)
│       ├── index.template.html     #   Build template
│       ├── body.html               #   HTML body markup
│       ├── css/style.css           #   Stylesheet (gets inlined at build time)
│       └── js/
│           ├── idb-tiny.js         #   IndexedDB promise wrapper
│           ├── storage.js          #   Export/import all browser storage
│           ├── crypto.js           #   E2EE: PBKDF2 + AES-256-GCM + ZIP packaging
│           ├── extensions.js       #   .crx/.xpi/.user.js loader
│           ├── settings.js         #   Settings panel (28 options like GUST)
│           ├── sync.js              #   Google Drive auth + backup/restore
│           └── app.js               #   Tab management, search, navigation
└── backend/                        # ← Deploy to Vercel (serverless API only)
    ├── api/
    │   ├── _lib/
    │   │   └── shared.js           #   OAuth + Drive + CORS helpers
    │   ├── bare/[...path].js       #   Bare server endpoint
    │   ├── auth.js                 #   Google OAuth callback
    │   └── sync.js                 #   Drive file push/pull
    ├── package.json
    └── vercel.json
```

### Why two servers?

The split has real benefits:

- **Frontend can be hosted anywhere cheap (or free).** GitHub Pages, Cloudflare Pages, Netlify all serve static files for free. No Vercel pricing concerns.
- **Backend stays small.** Just `/api/*` endpoints — no static file routing, no large bundles.
- **Independent scaling.** Frontend is cached by CDN forever (immutable). Backend scales per-request on Vercel.
- **No coupling.** You can swap the frontend host without redeploying the backend. Or vice versa.

### Configuring the frontend to talk to the backend

After deploying both, set `BACKEND_URL` in **two places** in the frontend:

1. **`frontend/index.html`** — look for `window.SHoolworkBackendUrl = window.SHoolworkBackendUrl || '';` near the top of the inline `<script>` block (~line 1725). Replace `''` with your backend URL:
   ```js
   window.SHoolworkBackendUrl = 'https://your-backend.vercel.app';
   ```

2. **`frontend/sw.js`** — at the top, change:
   ```js
   const BACKEND_URL = 'https://your-backend.vercel.app';  // ← CHANGE THIS
   ```

If you also use `embed.html`, set the same `window.SHoolworkBackendUrl` in its inline script.

### Configuring the backend to accept the frontend

Set `FRONTEND_ORIGIN` env var on the Vercel backend project to your frontend's exact origin:

```
FRONTEND_ORIGIN=https://your-frontend.pages.dev
```

If not set, the backend will echo back any `Origin` request header (works, but less secure for production).

## Browser Storage Sync (the headline feature)

Shoolwork Proxy can back up **all client-side browser storage** to a single encrypted file in your Google Drive `appDataFolder`, and restore it on any device. This covers:

| Storage Type | Use Cases |
|---|---|
| `document.cookie` | Logged-in sessions on proxied sites |
| `localStorage` | Site settings, game progress, dark mode prefs |
| `sessionStorage` | Form drafts, in-progress sessions |
| `IndexedDB` | Large game saves, PWA caches, offline data |
| `Cache API` | Service worker precaches |

### End-to-end encryption (AES-256-GCM)

Every backup is **end-to-end encrypted** with a password you choose. The server (and Google Drive) only ever sees ciphertext — they cannot read your data.

**Crypto stack:**
- **KDF:** PBKDF2-SHA256, 250,000 iterations, 16-byte random salt
- **Cipher:** AES-256-GCM with a 12-byte random IV (per-file)
- **Implementation:** native Web Crypto `SubtleCrypto` — no third-party crypto libraries

**File format (`*.shoolwork.zip`):**

```
+-----------+----------+----------+---------------------------+
|  magic    | kdfSalt  |    iv    |    ciphertext + GCM tag    |
| "SHL1"    |  16 B    |   12 B   |       variable length     |
+-----------+----------+----------+---------------------------+
```

After decryption, the plaintext is a standard ZIP archive containing:
- `manifest.json` — version, exportedAt, origin, deviceId, storage counts
- `backup.json` — the full storage dump

The ZIP can be unzipped with any standard tool (WinZip, 7-Zip, macOS Archive Utility, `unzip`) after decryption.

### Password handling

- The password is **never** persisted to `localStorage` — that would defeat the purpose of E2EE.
- For auto-sync, the user enters the password once per browser session.
- "Remember for this browser session" stores it in `sessionStorage` (cleared when the browser closes).
- Without the password, nobody — not even us — can decrypt your backup.

### Modes
- **Auto-sync** — pushes an encrypted snapshot every N minutes AND on `beforeunload`, pulls on tab focus.
- **Manual** — Settings → "Export now" / "Restore now" buttons, plus a downloadable `.shoolwork.zip` file you can decrypt offline.

The Drive file is named `shoolwork-proxy-backup.shoolwork.zip` and lives in `appDataFolder` (private to the app — other apps cannot see it).

### Service provider mode (host toggle)

The proxy host can choose which sync modes are exposed to users via the **Settings → Service Provider (Host)** section:

| Mode | Drive UI | Manual file export/import | Google OAuth required? |
|---|---|---|---|
| `full` (default) | ✓ | ✓ | Yes — `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REDIRECT_URI` |
| `manual` | hidden | ✓ | No — env vars optional |

When the host switches to **manual-only mode**:
- The Drive Sync view renames itself to "Manual Backup"
- Drive sign-in panel, status dot, and meta panel are hidden
- The "Export to Drive" / "Restore from Drive" / "Sign out" buttons are hidden
- Only "Download .zip" and "Restore from file…" buttons remain
- The auto-sync / auto-sync-interval / sync-on-unload settings are hidden (they only matter for Drive)
- The top chrome nav label changes from "Drive Sync" to "Backup"
- If the user was previously signed in to Drive, they're signed out cleanly

This lets hosts deploy Shoolwork Proxy **without** setting up Google OAuth credentials — useful for quick local deployments, isolated instances, or cases where Drive sync isn't needed.

### Embedding in an iframe (on your own site)

By default, browsers block sites from being embedded in iframes via `X-Frame-Options: DENY`. Shoolwork Proxy overrides this on every response:

```json
// vercel.json — frame-friendly headers on ALL paths
{
  "source": "/(.*)",
  "headers": [
    { "key": "X-Frame-Options",        "value": "ALLOWALL" },
    { "key": "Content-Security-Policy", "value": "frame-ancestors *;" },
    { "key": "Access-Control-Allow-Origin", "value": "*" }
  ]
}
```

This means you can drop Shoolwork Proxy inside an iframe on any parent page (school portal, dashboard, etc.).

**Option A — Standalone embed page (recommended):**

```html
<iframe
  src="https://your-shoolwork.vercel.app/embed.html?url=https://wikipedia.org"
  style="width: 100%; height: 100%; border: none;"
  allow="fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; gamepad; gyroscope; picture-in-picture"
></iframe>
```

The `/embed.html` page is a stripped-down version of the proxy UI — just the address bar + iframe, no top chrome or bookmarks. Perfect for tight spaces.

**Option B — Full app with `?embed=1`:**

```html
<iframe
  src="https://your-shoolwork.vercel.app/?embed=1"
  style="width: 100%; height: 100%; border: none;"
></iframe>
```

The full Shoolwork Proxy UI loads in a compact mode (smaller chrome, no title in header). Auto-jumps to the Proxy view.

**Option C — Open a specific URL via query param:**

```html
<iframe
  src="https://your-shoolwork.vercel.app/embed.html?url=https://example.com"
></iframe>
```

**Parent ↔ iframe communication (postMessage):**

The embed sends and receives messages from the parent window:

```js
// Parent page
window.addEventListener('message', e => {
  if (e.data?.type === 'shoolwork:ready') {
    console.log('Shoolwork embed is loaded');
  }
  if (e.data?.type === 'shoolwork:navigation') {
    console.log('User navigated to:', e.data.url);
  }
});

// Navigate the embed from the parent
iframe.contentWindow.postMessage({
  type: 'shoolwork:navigate',
  url: 'https://example.com'
}, '*');
```

### Browser extensions (Chrome / Firefox / userscripts)

Shoolwork Proxy can load `.crx`, `.xpi`, and `.user.js` files and inject their content scripts into proxied pages. Go to **Extensions** in the top nav, drop a file in the upload zone, and matching content scripts are auto-injected into proxied HTML before the page reaches the iframe.

**What works:**

| Feature | Status | Notes |
|---|---|---|
| `content_scripts` | ✅ Yes | Injected into proxied HTML before iframe load |
| `chrome.storage.local` | ✅ Shim | Backed by in-page memory |
| `chrome.runtime.sendMessage` | ⚠️ Shim | No-op — no real background page to receive |
| `webRequest` blocking | ⚠️ Limited | SW sees all proxied requests but synchronous blocking is hard |
| `cookies` API | ⚠️ Shim | Proxied origin only |
| `browser_action` / `page_action` | ❌ No | No toolbar in the proxied page |
| `background` scripts | ❌ No | SW can't run persistent background timers |
| `tabs` API | ❌ No | Extension can't see real browser tabs |
| Native messaging | ❌ No | Browser doesn't expose it to page context |

**Best fit:** content-script-only extensions (uBlock Origin Lite, Dark Reader, userscripts, ad blockers, custom CSS, password autofill shims).

**Worst fit:** extensions needing background pages (1Password, Bitwarden full, Grammarly, LastPass) — they'll run in degraded mode.

**How to install:**
1. Download the extension as a `.crx` (Chrome Web Store → "Pack extension" or use a CRX downloader), `.xpi` (Firefox AMO), or `.user.js` (Greasy Fork / OpenUserJS).
2. Open Shoolwork Proxy → click **Extensions** in the top nav.
3. Drop the file in the upload zone (or click to browse).
4. The extension appears in the list with an enable/disable toggle and remove button.
5. Visit a matching URL in the proxy tab — the content script runs automatically.

Extensions are stored in IndexedDB (per-browser, per-origin). They are NOT included in the Drive backup (to avoid redistributing third-party code).

### Decrypting a backup offline

If you ever want to decrypt a `.shoolwork.zip` outside of Shoolwork Proxy, here's a one-liner:

```bash
# Decrypt with OpenSSL (PBKDF2 + AES-256-GCM)
node -e '
  const fs = require("fs");
  const crypto = require("crypto");
  const data = fs.readFileSync(process.argv[2]);
  const pwd = process.argv[3];
  const salt = data.subarray(4, 20);
  const iv = data.subarray(20, 32);
  const ct = data.subarray(32);
  const key = crypto.pbkdf2Sync(pwd, salt, 250000, 32, "sha256");
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const dec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  fs.writeFileSync("backup.zip", dec);
  console.log("Wrote backup.zip (" + dec.length + " bytes)");
' my-backup.shoolwork.zip "your password"
unzip backup.zip
cat backup.json
```

## Local Development

### Backend

```bash
cd backend
npm install
npm run dev   # starts Vercel dev server on port 3000
```

### Frontend

The frontend is a single static HTML file (`index.html`), already built. To serve it locally:

```bash
cd frontend
python3 -m http.server 8080   # or: npx serve .
```

Then visit `http://localhost:8080/`.

For local dev, the frontend defaults to `BACKEND_URL = ''` (same-origin), so it expects the backend on the same host. To point at a separately-running backend, edit the `window.SHoolworkBackendUrl` line in `index.html` (and `BACKEND_URL` in `sw.js`).

If you edit any source JS or CSS, rebuild the single-file HTML:

```bash
node /home/z/my-project/scripts/build-frontend.js
```

## Deploy — exact steps (two servers)

There are **three** deployment patterns:

| Pattern | When to use | Frontend host | Effort |
|---|---|---|---|
| **Path A: Full mode** | You want Drive sync + admin panel | Any static host | 8 steps |
| **Path B: Manual-only mode** | Just want the proxy, no Drive | Any static host | 5 steps |
| **Path C: jsDelivr loader** ⭐ | You update often + don't want to redeploy | Your own domain (2 tiny files) | 4 steps |

For most people, **Path C** is now the recommended approach — push to GitHub, users automatically get the latest version. See `loader/README.md` for full details.

Both Path A and Path B deploy **two separate servers**: a static frontend (any host) and a Vercel backend.

---

### Path C — jsDelivr loader (recommended for frequent updates)

Instead of hosting the full 145KB frontend, you host just TWO tiny files on your domain that fetch the latest version from jsDelivr (which serves files directly from your GitHub repo):

- `loader/index.html` (4.5KB) — fetches latest `frontend/index.html` from jsDelivr, `document.write`s it
- `loader/sw-proxy.js` (1.5KB) — 1-line SW that `importScripts` the real `sw.js` from jsDelivr

**Why?** Push to GitHub → users automatically get the new version. No redeploy step.

#### Step 1 — Edit the loader files

In **both** `loader/index.html` and `loader/sw-proxy.js`, set:
```js
const GITHUB_REPO = 'your-username/shoolwork-proxy';  // ← your repo
const BRANCH = 'main';                                // ← your default branch
```

#### Step 2 — Set BACKEND_URL in the frontend source

Edit `frontend/sw.js`:
```js
const BACKEND_URL = 'https://your-backend.vercel.app';  // ← your backend
```

Edit `frontend/index.template.html` (the `window.SHoolworkBackendUrl` line near the top):
```js
window.SHoolworkBackendUrl = 'https://your-backend.vercel.app';
```

Then rebuild the frontend (so jsDelivr serves the updated version):
```bash
node scripts/build-frontend.js
```

#### Step 3 — Push to GitHub

```bash
git add .
git commit -m "Configure for jsDelivr loader"
git push
```

jsDelivr auto-detects the push (within ~10 min, or instant if you use `@latest`).

#### Step 4 — Host the two loader files

Upload `loader/index.html` (as `index.html`) and `loader/sw-proxy.js` (as `sw.js`) to any static host:

- **Vercel** — new project, Root Directory = `loader/`, deploy
- **Cloudflare Pages** — drag-and-drop the `loader/` folder
- **Netlify** — drag-and-drop the `loader/` folder
- **GitHub Pages** — push to `gh-pages` branch, enable Pages in repo settings

Visit your domain → loader fetches latest from jsDelivr → proxy runs. Every future push to GitHub auto-propagates to users.

See `loader/README.md` for full details + troubleshooting.

---

### Path A — Full mode (Drive + manual sync)

#### Step 1 — Get the code onto GitHub

```bash
# From the project root:
git init
git add .
git commit -m "Initial commit: Shoolwork Proxy"
git branch -M main
git remote add origin https://github.com/<your-username>/shoolwork-proxy.git
git push -u origin main
```

If you don't have a GitHub account, create one at https://github.com/signup (free).

#### Step 2 — Deploy the BACKEND to Vercel

The backend is in the `backend/` subdirectory. Vercel needs to treat that as the project root.

1. Go to https://vercel.com/ → sign in with GitHub.
2. Click **Add New → Project**.
3. Find `shoolwork-proxy` in the import list → click **Import**.
4. On the configure page:
   - **Root Directory**: click "Edit" → select the `backend/` folder → **Continue**
   - **Framework Preset**: "Other" (auto-detected) — leave it
   - **Build Command**: leave empty (Vercel reads `backend/vercel.json`)
   - **Install Command**: `npm install` (default)
5. Don't click Deploy yet — expand **Environment Variables** first.

#### Step 3 — Create a Google OAuth client

1. Go to the **Google Cloud Console**: https://console.cloud.google.com/
2. Sign in with any Google account.
3. Click the project dropdown at the top → **New Project** → name it `shoolwork-proxy` → **Create**.
4. From the left sidebar: **APIs & Services → Library** → search for **Google Drive API** → click it → **Enable**.
5. From the left sidebar: **APIs & Services → OAuth consent screen**:
   - User type: **External** → **Create**
   - App name: `Shoolwork Proxy`
   - User support email: your email
   - Developer contact email: your email
   - Click **Save and Continue** through Scopes and Test Users (defaults are fine)
   - Under **Test users**, click **+ Add Users** → add your own Google account email → **Save**
6. From the left sidebar: **APIs & Services → Credentials**:
   - Click **+ Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `Shoolwork Proxy`
   - **Authorized JavaScript origins**: leave empty (we don't use JS-origin checks)
   - **Authorized redirect URIs**: add `https://localhost:3000/api/auth` now (we'll add the production URL after the backend is deployed)
   - Click **Create**
7. A modal appears with your **Client ID** and **Client Secret**. Copy both — you'll need them in step 4.

#### Step 4 — Add environment variables to the Vercel BACKEND project

In the Vercel project's Environment Variables section, add these variables:

| Name | Value | Environments |
|---|---|---|
| `GDRIVE_CLIENT_ID` | (from step 3.7) | Production, Preview, Development |
| `GDRIVE_CLIENT_SECRET` | (from step 3.7) | Production, Preview, Development |
| `GDRIVE_REDIRECT_URI` | `https://<your-backend-vercel-domain>/api/auth` (placeholder for now — fix after deploy) | Production |
| `SESSION_SECRET` | any random 32+ char string, e.g. run `openssl rand -hex 32` | Production, Preview, Development |
| `FRONTEND_ORIGIN` | `https://<your-frontend-domain>` (placeholder for now — fix after frontend deploy) | Production |

> Note: You won't know your Vercel domain until after the first deploy. Use placeholders now and fix them in step 7.

> **Admin tokens (owner + moderator) are NOT in env vars.** They are hardcoded as arrays in `backend/api/_lib/auth-config.js`. Edit that file directly to set your tokens, then redeploy. See the **Access control** section below.

> **For access control:** After the first deploy, set up **Vercel KV** in your backend project's Storage tab (free tier: 256MB, 30k req/day). Vercel auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` env vars — no manual setup needed. Without KV, access control silently falls back to "disabled" (anyone can use the proxy). See the **Access control** section below.

5. Click **Deploy**. Wait ~1 minute. Vercel assigns a backend URL like `https://shoolwork-proxy-backend-<random>.vercel.app`.

#### Step 5 — Deploy the FRONTEND (static site)

You can host the frontend anywhere. Two options:

**Option A: Vercel (separate project)**

1. In Vercel: **Add New → Project** → import the same `shoolwork-proxy` repo.
2. **Root Directory**: click "Edit" → select the `frontend/` folder → **Continue**
3. **Framework Preset**: "Other" — leave it
4. **Build Command**: leave empty (the frontend is already built — `index.html` is committed)
5. **Output Directory**: `./` (the frontend is flat — no `dist/`)
6. Don't add env vars — the frontend reads `BACKEND_URL` from inline JS.
7. Click **Deploy**.

**Option B: Cloudflare Pages / Netlify / GitHub Pages / S3**

Upload the contents of `frontend/` to your static host. The frontend is just 2 files (`index.html` + `sw.js`) plus optional `embed.html`. Any static file host works.

#### Step 6 — Configure `BACKEND_URL` in the frontend

Edit `frontend/index.html` (locally, then redeploy — or via your static host's web editor if it has one):

1. Find this line near the top of the inline `<script>` block (~line 1725):
   ```js
   window.SHoolworkBackendUrl = window.SHoolworkBackendUrl || '';
   ```
2. Change `''` to your backend Vercel URL:
   ```js
   window.SHoolworkBackendUrl = 'https://shoolwork-proxy-backend-<random>.vercel.app';
   ```
3. Edit `frontend/sw.js` at the top:
   ```js
   const BACKEND_URL = 'https://shoolwork-proxy-backend-<random>.vercel.app';  // ← CHANGE THIS
   ```
4. (Optional) Edit `frontend/embed.html` the same way.
5. Redeploy the frontend.

#### Step 7 — Update the Google redirect URI + Vercel env vars

Now that you know both URLs:

1. **Vercel backend project → Settings → Environment Variables**:
   - Edit `GDRIVE_REDIRECT_URI` → set to `https://<your-backend-domain>/api/auth`
   - Edit `FRONTEND_ORIGIN` → set to `https://<your-frontend-domain>` (your static host URL)
2. **Google Cloud Console → APIs & Services → Credentials** → click your OAuth client → **Edit**:
   - Add `https://<your-backend-domain>/api/auth` to **Authorized redirect URIs**
   - Click **Save**
3. **Vercel backend → Deployments → latest → ⋯ → Redeploy**

#### Step 8 — Verify Drive sync works

1. Visit `https://<your-frontend-domain>/` → click **Drive Sync** in the top nav.
2. Click **Sign in with Google** → consent screen appears → approve.
3. You should be redirected to the backend, then back to your frontend URL with "Signed in" status.
4. Click **Set password…** → choose a password (min 4 chars) → click **Set password**.
5. Click **Export to Drive** → toast appears "Encrypted backup uploaded".
6. To verify: open a new incognito window, visit the frontend URL, sign in, click **Enter password…** with the same password, click **Restore from Drive** → all browser storage should be restored.

You're done! Drive sync is now live across two separate servers.

---

### Path B — Manual-only mode (no Drive, no Google OAuth)

If you just want the proxy + iframe embedding + extensions + manual `.shoolwork.zip` backup/restore, skip Google entirely.

#### Step 1 — Get the code onto GitHub (same as Path A step 1)

#### Step 2 — Deploy the BACKEND to Vercel (no env vars)

1. Import the repo into Vercel.
2. **Root Directory**: `backend/`
3. Leave all defaults — do NOT add any environment variables.
4. Click **Deploy**. Note your backend URL.

#### Step 3 — Deploy the FRONTEND (static site)

Same as Path A step 5 — upload the contents of `frontend/` to any static host.

#### Step 4 — Configure `BACKEND_URL` in the frontend

Same as Path A step 6 — set `window.SHoolworkBackendUrl` in `index.html` and `BACKEND_URL` in `sw.js`.

#### Step 5 — Switch to manual-only mode in the UI

1. Visit your frontend URL → click **Settings** in the top nav.
2. Scroll to **Service Provider (Host)** section → change **Sync mode** dropdown to **Manual file only (no Drive)**.
3. The Drive UI disappears. You now have:
   - New tab page with clock + search + favorites
   - Multi-tab proxy browser with devtools
   - Address bar + bookmarks
   - Extension loader (drag-and-drop `.crx` / `.xpi` / `.user.js`)
   - Embeddable iframe mode (`/embed.html?url=...` or `/?embed=1`)
   - AES-256-GCM encrypted `.shoolwork.zip` export/import for backups

You're done! Manual-only mode is now live.

---

### Optional — Custom domains

- **Backend**: Vercel project → **Settings → Domains** → add your domain (e.g. `api.schoolwork.proxy.com`).
- **Frontend**: Your static host's domain settings (each host has its own flow).
- If using Drive sync, update `GDRIVE_REDIRECT_URI` to the new backend domain, AND add the new redirect URI in Google Cloud Console.
- Update `BACKEND_URL` in `frontend/index.html` and `frontend/sw.js` if the backend domain changes.
- Update `FRONTEND_ORIGIN` env var on the backend if the frontend domain changes.

### Optional — Use Vercel CLI instead of Git

If you prefer the CLI for the backend:

```bash
npm install -g vercel
cd shoolwork-proxy/backend
vercel login
vercel link       # links to your Vercel project
vercel env add GDRIVE_CLIENT_ID          # paste value when prompted
vercel env add GDRIVE_CLIENT_SECRET
vercel env add GDRIVE_REDIRECT_URI
vercel env add SESSION_SECRET
vercel env add FRONTEND_ORIGIN
vercel --prod     # deploys to production
```

For the frontend, use any static file deploy tool (Cloudflare's `wrangler pages deploy`, Netlify's `netlify deploy`, GitHub Pages via `gh-pages`, S3 via `aws s3 cp`, etc.).

### Rebuilding the frontend from source

If you edit any of the source files under `frontend/js/` or `frontend/css/`, rebuild the single-file `index.html`:

```bash
node /home/z/my-project/scripts/build-frontend.js
```

This reads `frontend/index.template.html`, `frontend/body.html`, `frontend/css/style.css`, and all `frontend/js/*.js` files, concatenates + inlines them, and writes `frontend/index.html`.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Drive sign-in shows "redirect_uri_mismatch" | The URI in `GDRIVE_REDIRECT_URI` env var doesn't match what's in Google Cloud Console. Update both to `https://<exact-backend-domain>/api/auth` and redeploy. |
| Drive sign-in shows "access blocked" | You're not in the OAuth consent screen's **Test users** list. Add your Google account email in Google Cloud Console → OAuth consent screen → Test users. |
| Drive sign-in redirects but no cookie | Check that `FRONTEND_ORIGIN` env var on backend matches your frontend domain exactly (including scheme). Cookies use `SameSite=None; Secure; Partitioned` — must be HTTPS on both ends. |
| CORS error in browser console | Backend's `applyCORS` echoes the request Origin. If you set `FRONTEND_ORIGIN` env var, it must match your frontend's exact origin (e.g. `https://my-frontend.pages.dev`). |
| `MISSING_BARE_HEADER` error in console | Normal — the bare server expects `X-Bare-*` headers which Ultraviolet sends automatically. If you see it from a debugging fetch, ignore it. |
| Service worker registration fails | SW scope is `/service/`. Make sure `sw.js` is deployed to the root of your frontend (same origin as `index.html`). Hard refresh (Ctrl+Shift+R) to clear the old SW. |
| Extension doesn't inject | Open devtools → Console → look for the extension's console.log. If silent, the URL didn't match — check the manifest's `content_scripts[].matches` patterns. |
| `Encrypted backup is unreadable` after restore | Wrong password. The session password is per-browser — re-enter it via **Drive Sync → Enter password…** |
| Proxied page shows "WebSocket connection failed" | Vercel serverless has no WebSocket support. Affects Discord voice, some multiplayer games. No fix on Vercel — would need a different backend host (Railway, Fly.io) with persistent connections. |

### Telemetry / privacy

Shoolwork Proxy does not phone home. There is no analytics, no telemetry, no error reporting. Your proxied traffic goes through your own Vercel deployment's bare server. The Vercel provider can see request URLs (but not response bodies, since UV's bare server streams them) — if this matters, self-host the bare server on your own infra.

## Cloak (about:blank + tab disguise)

Two cloak features to hide what the proxy tab is:

### Tab title + favicon cloak

Settings → Cloak → enter a tab title and/or favicon URL, OR click one of the quick presets (Google Classroom, Drive, Docs, Canvas, Outlook, Reset). Title and favicon update live and persist across sessions in localStorage.

### About:blank cloak

Click the **about:blank icon** (top-right corner of the chrome toolbar, next to the theme toggle). This opens a new tab showing `about:blank` in the address bar, but renders the proxy inside it via `document.write`. The browser history + address bar show `about:blank` — anyone glancing at the tab sees nothing suspicious.

**Note:** some browsers (Chrome, Edge) block popups by default. You'll see a "Popup blocked" toast — click the blocked-popup icon in the address bar and allow popups for the site, then try again.

## Access control (anti-sharing)

Prevents the proxy URL from being shared and used by people you didn't invite.

### Three roles

| Role | Can use proxy | Manage codes | Revoke devices | Change roles | View stats/env | How to get |
|---|---|---|---|---|---|---|
| **user** (default) | ✓ | — | — | — | — | Enter an invite code at the gate |
| **moderator** | ✓ | ✓ | ✓ | — | — | Sign in at `/?admin=1` with a `MODERATOR_TOKENS` token |
| **owner** | ✓ | ✓ | ✓ | ✓ | ✓ | Sign in at `/?admin=1` with the `OWNER_TOKEN` |

**Escalating privileges:** moderator ⊇ user, owner ⊇ moderator ⊇ user.

- A `user` is anyone who entered a valid invite code — they can use the proxy but cannot access `/api/access/admin/*` at all.
- A `moderator` can generate new invite codes, list codes + devices, and revoke/unrevoke/delete devices. They CANNOT change device roles, view /stats, or view /env.
- The `owner` can do everything a moderator can do, PLUS change any device's role (e.g. promote a user to moderator), view the stats panel, and view a redacted env-var summary.

### How it works (single-use code + device key)

```
1. Owner generates N invite codes via /?admin=1 panel
   └─ Each code is 8 chars: XXXX-XXXX (no I/O/0/1 to avoid confusion)
2. Owner gives one code to each trusted person (off-band: in person, DM, etc.)
3. Person enters code at the access gate (shown on first visit)
   └─ Backend marks code as "used" + generates a fresh 128-bit device key
   └─ Device key stored in localStorage, sent with every API request
   └─ New device's role is "user" by default
   └─ Code is now useless — even if shared, it's already consumed
4. If someone DOES get the device key, owner/moderator can revoke it from admin panel
   └─ Next request from that device gets 403 → user sees "Device Revoked"
5. Owner can promote a user to moderator by changing their role in the admin panel
   └─ That user can then sign in at /?admin=1 with a moderator token
```

**Why this resists sharing better than a regular password:**
- Code is one-shot — sharing the code AFTER first use is useless
- Device key can be revoked by host at any time
- Host sees all devices (label, code, last-seen, status, role) in the admin panel
- No fingerprinting required (works on identical school devices)

### Setup

1. **Set up Vercel KV** (free tier: 256MB, 30k req/day):
   - Vercel dashboard → your backend project → **Storage → Create → KV**
   - Connect it to your backend project (Vercel auto-injects `KV_REST_API_URL` + `KV_REST_API_TOKEN` env vars)
2. **Set role tokens** by editing `backend/api/_lib/auth-config.js` directly:
   ```js
   const OWNER_TOKENS = [
     'your-owner-password-here',  // ← change this
   ];
   const MODERATOR_TOKENS = [
     'mod-alice',   // ← give one to each trusted moderator
     'mod-bob',
     'mod-carol',
   ];
   ```
   These arrays are checked on every admin request. Anyone with one of the `OWNER_TOKENS` values gets owner role; anyone with a `MODERATOR_TOKENS` value gets moderator role. To rotate: edit the file + redeploy.

   > ⚠️ **Security trade-off:** these tokens are baked into the deployed code. If your GitHub repo is public, anyone can read them. The user accepts this trade-off because the proxy is low-stakes. If you want stronger security, set `OWNER_TOKEN` and `MODERATOR_TOKENS` env vars in Vercel instead — the backend checks env vars first, then falls back to the hardcoded arrays.
3. **Redeploy the backend.**

### Admin panel — standalone HTML file (not on the public frontend)

The admin panel is **not part of the public frontend**. It's a standalone HTML file you open locally on your own machine:

```
backend/admin/admin.html
```

**To use it:**

1. Download or clone the repo to your computer
2. Open `backend/admin/admin.html` in your browser (double-click, or `file:///path/to/admin.html`)
3. At the top, enter your backend URL (e.g. `https://your-backend.vercel.app`) → click **Save** (stored in localStorage for next time)
4. Paste your owner or moderator token → click **Sign in**
5. The panel shows your role badge (OWNER purple / MODERATOR cyan) and adapts the UI:
   - **Moderators** see: Generate codes, Devices (read-only role badges), Codes history
   - **Owners** additionally see: Stats panel + role-change dropdowns on each device

The admin.html file makes cross-origin fetch() calls directly to your backend. Because the backend's CORS helper echoes the request Origin, this works from any origin — including `file://` (treated as null origin).

### Generating invite codes (owner or moderator)

1. Open `backend/admin/admin.html` locally
2. Sign in with your token (from `auth-config.js`)
3. **Generate invite codes** section → set count + optional label → click **Generate**
4. Codes appear in the textarea → click **Copy all** → distribute them

### Managing devices (owner or moderator)

In the admin panel, **Devices** section shows:
- Truncated device key + label (auto-generated as `device-YYYY-MM-DD` if no label was set)
- Which code it claimed
- Created date + last-seen timestamp
- Status badge: Active / Revoked
- Role column: read-only badge (moderator) or dropdown (owner)
- **Revoke** / **Unrevoke** / **Delete** buttons

When you revoke a device, that device's next API request gets `403 Device key invalid or revoked` → the access gate re-appears with "Device Revoked" message → the user must enter a NEW invite code to regain access.

### Changing roles (owner only)

Owners see a dropdown in the Role column for each device. Select `user`, `moderator`, or `owner` to change that device's role. The user's role takes effect on their next API request — no need for them to refresh.

**Note:** promoting a user to moderator/owner doesn't auto-grant them a token. They still need to be told a moderator/owner token separately (the host adds it to `auth-config.js`). The role change just records their privilege level in KV for audit purposes.

### Stats panel (owner only)

The Stats section (visible to owners only) shows:
- Total / unused / used code counts
- Total / active / revoked device counts
- Role breakdown: how many users / moderators / owners are registered

### Other access-control options (not built-in, but documented)

| Option | How to set up | Pros | Cons |
|---|---|---|---|
| **Cloudflare Access in front of backend** | Put your Vercel backend domain behind Cloudflare Access (Zero Trust). Each user signs in via email/GitHub/Google to Cloudflare before reaching the backend. | Very strong — each user must be in your email allowlist. Free for up to 50 users. | Adds a login step before the proxy. Doesn't gate the frontend (frontend is still public). |
| **TOTP (Authenticator app)** | We didn't build this, but the structure supports it — would need a `totp_secret` per user + 30s-rotating codes. | Codes expire every 30s — sharing a code is useless after that. | Requires each user to set up an authenticator app. Not great for a school scenario where users share devices. |
| **Time-limited codes** | Generate codes with an explicit expiry timestamp. After X hours, the code is useless regardless of whether it was claimed. | Good for events / temporary access. | Doesn't help once a device key is issued (the key persists). |
| **IP allowlist** | Vercel edge middleware that checks `req.headers['x-forwarded-for']` against an IP list. | Simple. | School IPs are shared — anyone on the school network gets in. Home IPs rotate. Not effective for your scenario. |
| **Obscure URL** | Use a long random subdomain like `https://xyz123abc.vercel.app`. | Zero setup. | Anyone with the link gets in. Useless once shared. |

The built-in single-use code + device-key system is the best fit for your scenario. If you want one of the alternatives instead (or in addition), let me know.

## License

MIT
