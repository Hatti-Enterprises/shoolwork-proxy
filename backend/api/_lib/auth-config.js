/* auth-config.js — Hardcoded admin + moderator tokens.
 *
 * ⚠️  SECURITY WARNING  ⚠️
 *
 * These tokens are baked into the deployed backend code. Anyone with read
 * access to your Vercel deployment source (e.g. if your GitHub repo is
 * public) can extract them. The user accepts this trade-off because the
 * proxy is a low-stakes site.
 *
 * If you want stronger security, move these to env vars (OWNER_TOKEN +
 * MODERATOR_TOKENS) and remove this file. The admin.js module already
 * supports both — it checks env vars first, then falls back to this file.
 *
 * To rotate: change the strings below + redeploy the backend. All existing
 * admin sessions are invalidated (because sessionStorage is per-tab).
 */

const OWNER_TOKENS = [
  'owner-shoolwork-change-me-please',
  // Add more owner tokens here if needed (rare — usually just one).
];

const MODERATOR_TOKENS = [
  // Add one token per trusted moderator.
  // Examples:
  // 'mod-alice-2024',
  // 'mod-bob-2024',
  // 'mod-carol-2024',
];

module.exports = {
  OWNER_TOKENS,
  MODERATOR_TOKENS,
};
