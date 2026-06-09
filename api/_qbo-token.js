// ─────────────────────────────────────────────────────────────────────────────
//  _qbo-token.js — Intuit OAuth2 access-token minting (production)
//  Shared helper for all QuickBooks endpoints in this proxy.
//
//  SELF-HEALING REFRESH TOKEN (v2 — June 2026)
//  ───────────────────────────────────────────
//  Intuit rotates the refresh token on (roughly) every use and retires the old
//  one after a short grace window; it also hard-expires after ~100 days of
//  inactivity. The previous version of this file was STATELESS: it read the
//  refresh token from an env var and threw away the rotated token Intuit hands
//  back on every refresh — so it always re-presented the ORIGINAL token, which
//  inevitably went stale and 400'd ("Incorrect or invalid refresh token").
//  That is why the connection kept dying and needed constant manual re-mints.
//
//  This version PERSISTS the rotated refresh token to Vercel KV (Upstash Redis)
//  via its REST API using plain fetch (no npm dependency, no build change). The
//  flow is now:
//
//    1. Read the current refresh token from KV.
//       └─ If KV is empty/unconfigured, fall back to the QBO_REFRESH_TOKEN env
//          var (first-run seed). So the proxy works the moment you re-mint,
//          even before a KV store is connected.
//    2. Exchange it with Intuit for an access token.
//    3. Intuit returns a (usually new) refresh token → WRITE IT BACK to KV.
//       └─ Next call reads the fresh one. The chain self-heals forever.
//
//  Once a KV store is connected + seeded once, you never re-mint again.
//
//  Required Vercel env vars (all from ONE production Intuit app — the Client ID,
//  Secret, and Refresh Token MUST come from the same app or Intuit returns 400):
//    QBO_CLIENT_ID       — production Client ID
//    QBO_CLIENT_SECRET   — production Client Secret
//    QBO_REFRESH_TOKEN   — long-lived OAuth refresh token (first-run seed only;
//                          after KV is seeded, KV is authoritative)
//    QBO_REALM_ID        — 9341454566029927  (Vistamark Investments LLC)
//
//  Auto-injected when you connect a Vercel KV / Upstash store to the project
//  (Storage → Upstash → Connect). If absent, the proxy silently runs in the
//  old env-var-only mode (still works, just not self-healing):
//    KV_REST_API_URL     — e.g. https://xxx.upstash.io
//    KV_REST_API_TOKEN   — bearer token for the KV REST API
//
//  Optional:
//    QBO_KV_KEY          — KV key name to store the token under
//                          (default: "qbo:refresh_token")
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const KV_URL   = process.env.KV_REST_API_URL   || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const KV_KEY   = process.env.QBO_KV_KEY        || 'qbo:refresh_token';
const KV_ENABLED = !!(KV_URL && KV_TOKEN);

// Module-memory cache (persists across warm invocations on the same instance).
let _cachedToken = null;       // { accessToken, expiresAt, rotatedRefreshToken }

// ── KV helpers (Upstash REST API; no SDK) ────────────────────────────────────
// Upstash REST supports GET /get/<key> and POST /set/<key> with the value in
// the body. Responses look like { "result": "<value>" } (null if missing).
async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const v = j && typeof j.result !== 'undefined' ? j.result : null;
    return (v === null || v === '' ) ? null : v;
  } catch (_) {
    return null;   // KV must never break the auth path — degrade to env var.
  }
}

async function kvSet(key, value) {
  if (!KV_ENABLED || !value) return false;
  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'text/plain',
      },
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
  // Reuse a cached access token if it has >60s of life left.
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
    // Helpful, specific message. A 400 "invalid_grant" on a freshly-minted
    // token almost always means the token was minted under a DIFFERENT app
    // than QBO_CLIENT_ID/SECRET, or in Sandbox instead of Production.
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
    // 400 from Intuit = bad credential → surface as 401 to the caller.
    err.status = resp.status === 400 ? 401 : resp.status;
    throw err;
  }

  // Persist the rotated refresh token so the NEXT call uses the fresh one.
  // This is the whole point of v2 — without it the chain goes stale.
  const rotated = data.refresh_token || null;
  if (rotated && rotated !== refreshToken) {
    await kvSet(KV_KEY, rotated);
  } else if (rotated && tokenSource === 'env' && KV_ENABLED) {
    // First run from env seed: write it into KV so KV becomes authoritative.
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
