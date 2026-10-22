# Shoolwork Proxy — jsDelivr Loader (multi-file, no build needed)

Two tiny files you host on your own domain. They fetch the latest frontend
from jsDelivr (which serves files directly from your GitHub repo) and run it
— with all CSS/JS modules loading separately from jsDelivr.

**No build step. No single-file compilation. Just push to GitHub.**

## How it works

```
1. User visits your-domain.com/
2. Loader (index.html) fetches frontend/index.html from jsDelivr
3. Injects <base href="jsDelivr-URL"> + <script>window.SHoolworkBackendUrl=...</script>
4. document.write() replaces the page with the fetched HTML
5. Browser resolves ./css/style.css → jsDelivr (via <base> tag)
6. Browser loads ./js/app.js → jsDelivr (via <base> tag)
7. ES module imports (import { x } from './storage.js') → jsDelivr
8. JS registers /sw.js → YOUR domain (location.href, NOT affected by <base>)
9. /sw.js (proxy) sets self.BACKEND_URL, then importScripts() real sw.js from jsDelivr
10. SW computes UV prefix from self.registration.scope = YOUR domain
11. Proxy works — URL bar shows YOUR domain
```

## Files

- **`index.html`** — the loader. Fetches latest frontend from jsDelivr,
  injects `<base>` tag (so CSS/JS load from jsDelivr) + `BACKEND_URL`
  (so API calls go to your backend). URL bar shows YOUR domain.
- **`sw-proxy.js`** — rename to `sw.js` on your host. Sets `BACKEND_URL`,
  then `importScripts` the real `sw.js` from jsDelivr. SW must be same-origin.

## Setup (4 steps, no build)

### 1. Edit the two loader files

In **both** `index.html` and `sw-proxy.js`, set:
```js
const GITHUB_REPO = 'your-username/shoolwork-proxy';
const BRANCH = 'main';
const BACKEND_URL = 'https://your-backend.vercel.app';
```

That's it. No need to edit `frontend/sw.js` or `frontend/index.html` —
the loader injects `BACKEND_URL` into both at runtime.

### 2. Push to GitHub

```bash
git add .
git commit -m "Configure for jsDelivr loader"
git push
```

### 3. Host the two loader files

Upload `index.html` (as `index.html`) and `sw-proxy.js` (as `sw.js`) to
any static host:

- **Vercel** — new project, Root Directory = `loader/`, deploy
- **Cloudflare Pages** — drag-and-drop the `loader/` folder
- **Netlify** — drag-and-drop the `loader/` folder
- **GitHub Pages** — push to `gh-pages` branch, enable Pages

### 4. Visit your domain

`https://your-domain.com/` → loader fetches latest from jsDelivr → proxy runs.

## Why this works

| What | Resolves via | Goes to |
|---|---|---|
| `<link href="./css/style.css">` | `<base>` tag → jsDelivr | jsDelivr CDN |
| `<script src="./js/app.js">` | `<base>` tag → jsDelivr | jsDelivr CDN |
| `import { x } from './storage.js'` | Module URL (jsDelivr) → jsDelivr | jsDelivr CDN |
| `navigator.serviceWorker.register('sw.js', ...)` | `location.href` (NOT `<base>`) → YOUR domain | YOUR domain |
| UV prefix (`location.href + 'service/'`) | `location.href` (NOT `<base>`) → YOUR domain | YOUR domain |

The `<base>` tag only affects HTML attribute URL resolution. JavaScript's
`location.href` is NOT affected — so the SW registration and UV prefix stay
on your domain while CSS/JS load from jsDelivr.
