/* Shoolwork Proxy — jsDelivr SW Proxy
 *
 * This file lives on YOUR domain (alongside index.html). It's a tiny
 * stub that importScripts() the real sw.js from jsDelivr.
 *
 * Why? Because service workers MUST be served same-origin. The real
 * sw.js lives in your GitHub repo (served via jsDelivr at
 * cdn.jsdelivr.net/gh/.../frontend/sw.js), but the browser won't let
 * the page register a SW from a cross-origin URL. So we host this tiny
 * proxy file on your domain — it just imports the real SW from jsDelivr.
 *
 * The real SW (at jsDelivr) computes its UV prefix RELATIVE to its own
 * scope at runtime (self.registration.scope = YOUR domain), so it works
 * on any host.
 *
 * CONFIG: set GITHUB_REPO, BRANCH, and BACKEND_URL below.
 * The BACKEND_URL is passed to the real SW via self.BACKEND_URL so you
 * don't need to edit frontend/sw.js — just edit this one file.
 */

// ============================================================
// CONFIG — EDIT THESE THREE LINES (must match loader/index.html)
// ============================================================
const GITHUB_REPO = 'your-username/shoolwork-proxy';  // ← CHANGE THIS
const BRANCH = 'main';                                // ← usually 'main' or 'master'
const BACKEND_URL = 'https://your-backend.vercel.app'; // ← your Vercel backend URL
// ============================================================

// Pass BACKEND_URL to the real SW before it loads.
// The real sw.js reads: const BACKEND_URL = self.BACKEND_URL || '...default...';
self.BACKEND_URL = BACKEND_URL;

// Import the real SW from jsDelivr — it has all the UV config + extension logic.
importScripts(`https://cdn.jsdelivr.net/gh/${GITHUB_REPO}@${BRANCH}/frontend/sw.js`);
