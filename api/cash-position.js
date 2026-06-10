// ─────────────────────────────────────────────────────────────────────────────
//  /api/cash-position — LIVE bank cash balance, from QuickBooks.
//
//  Returns the CurrentBalance of the firm's operating checking account so the
//  app can SEED (not lock) the Initial Cash field on the P&L Cash Projection.
//  The practitioner still edits the field by hand; this just shows the live
//  number with a "Use this" affordance.
//
//  Mirrors api/pnl-ytd.js conventions exactly: shared _qbo-token.js for OAuth,
//  same CORS allowlist, same ACCESS_TOKEN / ?key= auth, same realm default,
//  same ?diag=1 (no-secret health check, runs BEFORE the gate) and ?debug=1
//  (requires valid key, returns the raw QBO query body).
//
//  Account selection:
//    - Default account name: "Vistamark Investments Checking" (override via
//      env QBO_CASH_ACCOUNT_NAME). We match QBO Account.Name that CONTAINS the
//      configured string (case-insensitive), AccountType = 'Bank', Active=true,
//      and pick the one with the largest CurrentBalance if several match.
//    - Why name-contains rather than exact: QBO surfaces the account as
//      "Vistamark Investments Checking (9619)" in the UI but stores Name without
//      the trailing "(9619)" mask in most orgs — contains is the safe match.
//
//  Shape consumed by the app:
//      { source, pulledAt, account:{ id, name, accountType, accountSubType },
//        currentBalance, currency }
//
//  Auth: header ACCESS_TOKEN:<secret>  OR  ?key=<secret>  vs VB_ACCESS_TOKEN
//  CORS: locked to vistabalancer.app (+ localhost).
// ─────────────────────────────────────────────────────────────────────────────

const { getAccessToken, tokenDiagnostics } = require('./_qbo-token.js');

const QBO_BASE = 'https://quickbooks.api.intuit.com';

const ALLOWED_ORIGINS = new Set([
  'https://vistabalancer.app',
  'https://www.vistabalancer.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
]);

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin',
    (origin && ALLOWED_ORIGINS.has(origin)) ? origin : 'https://vistabalancer.app');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ACCESS_TOKEN');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

async function getJson(url, accessToken) {
  const r = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' },
  });
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch (_) { body = { raw: t }; }
  return { status: r.status, ok: r.ok, body };
}

function r2(v) { return Math.round((+v || 0) * 100) / 100; }

// Build the QBO Account query. We pull all Bank accounts (small list) and do
// the name-contains match in JS so we don't have to escape quoting in QBQL and
// so a slightly different stored name still resolves.
function bankAccountsQueryUrl(realmId) {
  const q = encodeURIComponent("select Id, Name, AccountType, AccountSubType, CurrentBalance, Active from Account where AccountType = 'Bank'");
  return `${QBO_BASE}/v3/company/${realmId}/query?query=${q}&minorversion=70`;
}

function pickAccount(queryBody, wantName) {
  const rows = (queryBody && queryBody.QueryResponse && queryBody.QueryResponse.Account) || [];
  const want = String(wantName || '').toLowerCase().trim();
  // active bank accounts whose name contains the configured string
  const matches = rows.filter(a =>
    (a.Active === undefined || a.Active === true) &&
    String(a.Name || '').toLowerCase().includes(want)
  );
  if (!matches.length) return null;
  // if several, take the largest current balance (the operating account)
  matches.sort((a, b) => (+b.CurrentBalance || 0) - (+a.CurrentBalance || 0));
  return matches[0];
}

async function computeCash(accessToken, realmId, wantName) {
  const url = bankAccountsQueryUrl(realmId);
  const r = await getJson(url, accessToken);
  if (!r.ok) { const e = new Error('Account query failed (' + r.status + ')'); e.detail = r.body; e.httpStatus = r.status; throw e; }
  const acct = pickAccount(r.body, wantName);
  if (!acct) { const e = new Error('No matching bank account for "' + wantName + '"'); e.httpStatus = 404; throw e; }
  return {
    source: 'QuickBooks Account.CurrentBalance (live)',
    pulledAt: new Date().toISOString(),
    account: {
      id: acct.Id,
      name: acct.Name,
      accountType: acct.AccountType,
      accountSubType: acct.AccountSubType || null,
    },
    currentBalance: r2(acct.CurrentBalance),
    currency: 'USD',
  };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const expected = process.env.VB_ACCESS_TOKEN;
  const got = req.headers['access_token'] || req.headers['x-access-token'] || (req.query && req.query.key);
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  const diag  = req.query && (req.query.diag === '1'  || req.query.diag === 'true');

  const wantName = process.env.QBO_CASH_ACCOUNT_NAME || 'Vistamark Investments Checking';

  // ── ?diag=1 — NO-SECRET health check, runs BEFORE the gate. ──────────────
  if (diag) {
    let tdiag = {};
    try { tdiag = typeof tokenDiagnostics === 'function' ? tokenDiagnostics() : {}; } catch (_) {}
    return res.status(200).json({
      diag: true,
      endpoint: 'cash-position',
      gate: {
        vbAccessTokenConfigured: !!expected,
        keyProvided: !!got,
        keyMatches: !!expected && got === expected,
        keyLengthSeen: got ? String(got).length : 0,
        expectedLength: expected ? String(expected).length : 0,
      },
      token: tdiag,
      cashAccountName: wantName,
      note: 'keyMatches=false → your ?key= does not equal VB_ACCESS_TOKEN. ' +
            'cashAccountName is the QBO Account.Name substring we match (Bank type). ' +
            'Override with env QBO_CASH_ACCOUNT_NAME.',
    });
  }

  if (expected) {
    if (got !== expected) return res.status(401).json({ error: 'Unauthorized', gate: true });
  }

  const realmId = process.env.QBO_REALM_ID || '9341454566029927';

  try {
    const accessToken = await getAccessToken();

    if (debug) {
      const url = bankAccountsQueryUrl(realmId);
      const r = await getJson(url, accessToken);
      return res.status(200).json({ debug: true, qboStatus: r.status, qboUrl: url, cashAccountName: wantName, rawResponse: r.body });
    }

    const result = await computeCash(accessToken, realmId, wantName);
    return res.status(200).json(result);

  } catch (err) {
    const status = err.httpStatus || err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({ error: err.message || 'Unexpected error', detail: err.detail || null, code: err.code || null });
  }
};
