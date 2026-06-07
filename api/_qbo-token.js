// ─────────────────────────────────────────────────────────────────────────────
//  _qbo-token.js — Intuit OAuth2 access-token minting (production)
//  Shared helper for all QuickBooks endpoints in this proxy.
//
//  The browser (VistaBalancer) NEVER sees these credentials. They live only in
//  Vercel env vars and are used server-side here to exchange the long-lived
//  refresh token for a short-lived access token on each cold start, cached in
//  module memory for its ~1h lifetime.
//
//  Required Vercel env vars (from Randall's QuickBooks app on the Intuit
//  Developer dashboard → Production keys):
//    QBO_CLIENT_ID       — production Client ID
//    QBO_CLIENT_SECRET   — production Client Secret
//    QBO_REFRESH_TOKEN   — long-lived OAuth refresh token for the realm
//    QBO_REALM_ID         — 9341454566029927  (Vistamark Investments LLC)
//
//  NOTE: Intuit rotates the refresh token roughly every 24h of use and expires
//  it after ~100 days of inactivity. When QBO_REFRESH_TOKEN goes stale the
//  endpoints return 401 with a clear message; re-mint via the OAuth Playground
//  and update the Vercel env var. (A future enhancement could persist the
//  rotated refresh_token to Vercel KV; kept stateless here for simplicity and
//  to mirror the Wealthbox proxy's no-DB design.)
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// Module-memory cache (persists across warm invocations on the same instance).
let _cachedToken = null;       // { accessToken, expiresAt }

async function getAccessToken() {
  // Reuse a cached token if it has >60s of life left.
  if (_cachedToken && _cachedToken.expiresAt - Date.now() > 60_000) {
    return _cachedToken.accessToken;
  }

  const clientId     = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const refreshToken = process.env.QBO_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId && 'QBO_CLIENT_ID',
      !clientSecret && 'QBO_CLIENT_SECRET',
      !refreshToken && 'QBO_REFRESH_TOKEN',
    ].filter(Boolean).join(', ');
    const err = new Error('Missing QuickBooks env vars: ' + missing);
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
    const err = new Error(
      'Intuit token refresh failed (' + resp.status + '). ' +
      (data.error_description || data.error || data.raw || 'Refresh token may be expired — re-mint and update QBO_REFRESH_TOKEN.')
    );
    err.code = 'AUTH';
    err.status = resp.status === 400 ? 401 : resp.status;
    throw err;
  }

  // Intuit returns expires_in (seconds, typically 3600) and a possibly-rotated
  // refresh_token. We can't persist the rotated refresh_token without a store,
  // but the OLD one stays valid long enough for typical use; we surface the new
  // one in a header for manual capture if desired.
  _cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
    rotatedRefreshToken: data.refresh_token || null,
  };

  return _cachedToken.accessToken;
}

function lastRotatedRefreshToken() {
  return _cachedToken && _cachedToken.rotatedRefreshToken;
}

module.exports = { getAccessToken, lastRotatedRefreshToken };
