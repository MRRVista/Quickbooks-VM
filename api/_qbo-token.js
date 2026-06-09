// ─────────────────────────────────────────────────────────────────────────────
//  _qbo-token.js — Intuit OAuth2 access-token minting (production)
//  Shared helper for all QuickBooks endpoints in this proxy.
//
//  SELF-HEALING REFRESH TOKEN (v3 — June 2026)
//  ───────────────────────────────────────────
//  Intuit rotates the refresh token on (roughly) every use and retires the old
//  one after a short grace window; it also hard-expires after ~100 days of
//  inactivity. The original version was STATELESS: it read the refresh token
//  from an env var and threw away the rotated token Intuit hands back on every
//  refresh — so it always re-presented the ORIGINAL token, which inevitably
//  went stale and 400'd ("Incorrect or invalid refresh token"). That is why the
//  connection kept dying and needed constant manual re-mints.
//
//  This version PERSISTS the rotated refresh token to a Redis/KV store (Upstash)
//  via its REST API using plain fetch (no npm dependency, no build change):
//    1. Read the current refresh token from KV.
//       └─ If KV is empty/unconfigured, fall back to QBO_REFRESH_TOKEN env var.
//    2. Exchange it with Intuit for an access token.
//    3. Intuit returns a (usually new) refresh token → WRITE IT BACK to KV.
//       └─ Next call reads the fresh one. The chain self-heals forever.
//
//  v3 change: the Upstash/Vercel integration names its REST env vars differently
//  depending on how the store was connected (KV_REST_API_*, UPSTASH_REDIS_REST_*,
//  or a custom-prefixed STORAGE_*). v2 only looked for KV_REST_API_* and so
//  reported kvEnabled:false even when a store was connected under a different
//  name. v3 auto-detects ALL the common names so it Just Works regardless of how
//  the store was wired.
//
//  Required Vercel env vars (all from ONE production Intuit app — Client ID,
//  Secret, and Refresh Token MUST come from the same app or Intuit returns 400):
//    QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REFRESH_TOKEN, QBO_REALM_ID
//
//  KV REST vars (any one of these name-pairs works; auto-injected by the
//  Upstash integration when you connect a store):
//    KV_REST_API_URL          + KV_REST_API_TOKEN
//    UPSTASH_REDIS_REST_URL   + UPSTASH_REDIS_REST_TOKEN
//    <PREFIX>_REST_API_URL    + <PREFIX>_REST_API_TOKEN   (custom prefix)
//
//  Optional:
//    QBO_KV_KEY   — KV key name for the token (default: "qbo:refresh_token")
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// ── Auto-detect the KV REST endpoint + token across all the names the Upstash /
//    Vercel integration may use. Returns { url, token, urlVar, tokenVar }. ─────
function detectKv() {
  const env = process.env;
  // 1) Exact well-known pairs, in priority order.
  const KNOWN_PAIRS = [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['REDIS_REST_API_URL', 'REDIS_REST_API_TOKEN'],
  ];
  for (const [u, t] of KNOWN_PAIRS) {
    if (env[u] && env[t]) return { url: env[u], token: env[t], urlVar: u, tokenVar: t };
  }
  // 2) Generic discovery: any *_REST_API_URL that has a matching *_REST_API_TOKEN
  //    (covers a custom Storage prefix like MYKV_REST_API_URL/_TOKEN).
  for (const k of Object.keys(env)) {
    if (/_REST_API_URL$/.test(k) && env[k]) {
      const tVar = k.replace(/_REST_API_URL$/, '_REST_API_TOKEN');
      if (env[tVar]) return { url: env[k], token: env[tVar], urlVar: k, tokenVar: tVar };
    }
    // Upstash-style prefix: <PREFIX>_REDIS_REST_URL / _TOKEN
    if (/_REDIS_REST_URL$/.test(k) && env[k]) {
      const tVar = k.replace(/_REDIS_REST_URL$/, '_REDIS_REST_TOKEN');
      if (env[tVar]) return { url: env[k], token: env[tVar], urlVar: k, tokenVar: tVar };
    }
  }
  return { url: '', token: '', urlVar: null, tokenVar: null };
}

const _KV = detectKv();
const KV_URL   = _KV.url;
const KV_TOKEN = _KV.token;
const KV_KEY   = process.env.QBO_KV_KEY || 'qbo:refresh_token';
const KV_ENABLED = !!(KV_URL && KV_TOKEN);

// Module-memory cache (persists across warm invocations on the same instance).
let _cachedToken = null;       // { accessToken, expiresAt, rotatedRefreshToken }

// ── KV helpers (Upstash REST API; no SDK) ────────────────────────────────────
async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const v = j && typeof j.result !== 'undefined' ? j.result : null;
    return (v === null || v === '') ? null : v;
  } catch (_) {
    return null;   // KV must never break the auth path — degrade to env var.
  }
}

async function kvSet(key, value) {
  if (!KV_ENABLED || !value) return false;
  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: String(value),
    });
    return r.ok;
  } catch (_) {
    return false;  // best-effort; a failed write just means we re-seed next time
  }
}

// ── Resolve the refresh token to use: KV first, env var as fallback/seed ──────
async function resolveRefreshToken() {
  const fromKv = await kvGet(KV_KEY);
  if (fromKv) return { token: fromKv, source: 'kv' };
  const fromEnv = process.env.QBO_REFRESH_TOKEN;
  if (fromEnv) return { token: fromEnv, source: 'env' };
  return { token: null, source: 'none' };
}

async function getAccessToken() {
  if (_cachedToken && _cachedToken.expiresAt - Date.now() > 60_000) {
    return _cachedToken.accessToken;
  }

  const clientId     = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const missing = [
      !clientId && 'QBO_CLIENT_ID',
      !clientSecret && 'QBO_CLIENT_SECRET',
    ].filter(Boolean).join(', ');
    const err = new Error('Missing QuickBooks env vars: ' + missing);
    err.code = 'CONFIG';
    throw err;
  }

  const { token: refreshToken, source: tokenSource } = await resolveRefreshToken();
  if (!refreshToken) {
    const err = new Error(
      'No refresh token available. Seed QBO_REFRESH_TOKEN (env) or the KV key ' +
      KV_KEY + ' by re-minting in the Intuit OAuth Playground.'
    );
    err.code = 'CONFIG';
    throw err;
  }

  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }

  if (!resp.ok || !data.access_token) {
    const detail = data.error_description || data.error || data.raw || '';
    let hint = '';
    if (resp.status === 400) {
      hint = ' (token source=' + tokenSource + '. If you just re-minted, the ' +
             'Client ID/Secret in Vercel must come from the SAME production app ' +
             'you minted the refresh token from.)';
    }
    const err = new Error(
      'Intuit token refresh failed (' + resp.status + '). ' +
      (detail || 'Refresh token invalid or expired.') + hint
    );
    err.code = 'AUTH';
    err.status = resp.status === 400 ? 401 : resp.status;
    throw err;
  }

  // Persist the rotated refresh token so the NEXT call uses the fresh one.
  const rotated = data.refresh_token || null;
  if (rotated && (rotated !== refreshToken || (tokenSource === 'env' && KV_ENABLED))) {
    await kvSet(KV_KEY, rotated);
  }

  _cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
    rotatedRefreshToken: rotated,
  };

  return _cachedToken.accessToken;
}

function lastRotatedRefreshToken() {
  return _cachedToken && _cachedToken.rotatedRefreshToken;
}

// Non-secret status for diagnostics (?diag=1). Never returns token values.
function tokenDiagnostics() {
  return {
    kvEnabled: KV_ENABLED,
    kvUrlVar: _KV.urlVar,       // which env var name supplied the KV URL (no value)
    kvTokenVar: _KV.tokenVar,   // which env var name supplied the KV token (no value)
    kvKey: KV_KEY,
    hasEnvSeed: !!process.env.QBO_REFRESH_TOKEN,
    hasClientId: !!process.env.QBO_CLIENT_ID,
    hasClientSecret: !!process.env.QBO_CLIENT_SECRET,
    clientIdFingerprint: process.env.QBO_CLIENT_ID
      ? (process.env.QBO_CLIENT_ID.slice(0, 4) + '…' + process.env.QBO_CLIENT_ID.slice(-4))
      : null,
    realmId: process.env.QBO_REALM_ID || '9341454566029927',
  };
}

module.exports = { getAccessToken, lastRotatedRefreshToken, tokenDiagnostics };
