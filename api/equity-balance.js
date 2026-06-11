// ─────────────────────────────────────────────────────────────────────────────
//  /api/equity-balance — LIVE equity-account balance, from QuickBooks.
//
//  Built to surface PARTNER PROFIT DISTRIBUTIONS (the "Owner draws" equity
//  account) below the net P&L line in VistaBalancer. Distributions are equity
//  draws, NOT P&L items, so they never appear in /api/pnl-ytd — this endpoint
//  reads them straight off the equity account's CurrentBalance.
//
//  Mirrors api/cash-position.js exactly: shared _qbo-token.js OAuth, same CORS
//  allowlist, same ACCESS_TOKEN / ?key= gate (now via shared _gate.js —
//  fail-closed + timing-safe, June 2026 hardening), same realm default, same
//  ?diag=1 (gate booleans pre-auth; token internals only with a valid key) and
//  ?debug=1 (raw body, requires valid key).
//
//  Account selection:
//    - Default name substring: "Owner draws" (override env QBO_EQUITY_ACCOUNT_NAME)
//    - Matches QBO Account.Name CONTAINS substring (case-insensitive),
//      AccountType = 'Equity', Active. If several match, the one with the
//      largest ABSOLUTE balance wins (distribution accounts carry the action).
//    - Returns ALL matching equity accounts too (accounts[]) so the caller can
//      see per-account detail (e.g. per-partner sub-accounts) if they exist.
//
//  Sign note: in QBO an owner-draws/distributions equity account typically
//  carries a DEBIT balance, which the API may return as negative. We return
//  the raw CurrentBalance AND an absolute `distributions` convenience field so
//  the UI can render "$50,000 distributed" without worrying about sign.
//
//  Shape consumed by the app:
//      { source, pulledAt, account:{ id, name, accountType, accountSubType },
//        currentBalance, distributions, accounts:[...], currency }
//
//  Auth: header ACCESS_TOKEN:<secret>  OR  ?key=<secret>  vs VB_ACCESS_TOKEN
//  CORS: locked to vistabalancer.app (+ localhost).
// ─────────────────────────────────────────────────────────────────────────────

const { getAccessToken, tokenDiagnostics } = require('./_qbo-token.js');
const { enforceGate, gateInfo } = require('./_gate.js');

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

function equityAccountsQueryUrl(realmId) {
  const q = encodeURIComponent("select Id, Name, AccountType, AccountSubType, CurrentBalance, Active from Account where AccountType = 'Equity'");
  return `${QBO_BASE}/v3/company/${realmId}/query?query=${q}&minorversion=70`;
}

function matchEquity(queryBody, wantName) {
  const rows = (queryBody && queryBody.QueryResponse && queryBody.QueryResponse.Account) || [];
  const want = String(wantName || '').toLowerCase().trim();
  const matches = rows.filter(a =>
    (a.Active === undefined || a.Active === true) &&
    String(a.Name || '').toLowerCase().includes(want)
  );
  // largest absolute balance first — the distribution account carries the action
  matches.sort((a, b) => Math.abs(+b.CurrentBalance || 0) - Math.abs(+a.CurrentBalance || 0));
  return matches;
}

async function computeEquity(accessToken, realmId, wantName) {
  const url = equityAccountsQueryUrl(realmId);
  const r = await getJson(url, accessToken);
  if (!r.ok) { const e = new Error('Equity account query failed (' + r.status + ')'); e.detail = r.body; e.httpStatus = r.status; throw e; }
  const matches = matchEquity(r.body, wantName);
  if (!matches.length) { const e = new Error('No matching equity account for "' + wantName + '"'); e.httpStatus = 404; throw e; }
  const top = matches[0];
  const raw = r2(top.CurrentBalance);
  return {
    source: 'QuickBooks Account.CurrentBalance (live, Equity)',
    pulledAt: new Date().toISOString(),
    account: {
      id: top.Id,
      name: top.Name,
      accountType: top.AccountType,
      accountSubType: top.AccountSubType || null,
    },
    currentBalance: raw,
    distributions: Math.abs(raw),   // sign-agnostic convenience for the UI
    accounts: matches.map(a => ({
      id: a.Id, name: a.Name, subType: a.AccountSubType || null,
      currentBalance: r2(a.CurrentBalance), distributions: Math.abs(r2(a.CurrentBalance)),
    })),
    currency: 'USD',
  };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  const diag  = req.query && (req.query.diag === '1'  || req.query.diag === 'true');

  // Allow ?name= override for ad-hoc lookups; default to the distributions account.
  const wantName = (req.query && req.query.name) || process.env.QBO_EQUITY_ACCOUNT_NAME || 'Owner draws';

  if (diag) {
    const gate = gateInfo(req);
    let tdiag = null;
    if (gate.keyMatches) { try { tdiag = typeof tokenDiagnostics === 'function' ? tokenDiagnostics() : {}; } catch (_) { tdiag = {}; } }
    return res.status(200).json({
      diag: true,
      endpoint: 'equity-balance',
      gate,
      token: gate.keyMatches ? tdiag : 'redacted — pass the gate key to see token diagnostics',
      equityAccountName: wantName,
      note: 'keyMatches=false → your key does not equal VB_ACCESS_TOKEN. ' +
            'equityAccountName is the Account.Name substring matched (Equity type). ' +
            'Override with env QBO_EQUITY_ACCOUNT_NAME or ?name=.',
    });
  }

  if (!enforceGate(req, res)) return;

  const realmId = process.env.QBO_REALM_ID || '9341454566029927';

  try {
    const accessToken = await getAccessToken();

    if (debug) {
      const url = equityAccountsQueryUrl(realmId);
      const r = await getJson(url, accessToken);
      return res.status(200).json({ debug: true, qboStatus: r.status, qboUrl: url, equityAccountName: wantName, rawResponse: r.body });
    }

    const result = await computeEquity(accessToken, realmId, wantName);
    return res.status(200).json(result);

  } catch (err) {
    const status = err.httpStatus || err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({ error: err.message || 'Unexpected error', detail: err.detail || null, code: err.code || null });
  }
};
