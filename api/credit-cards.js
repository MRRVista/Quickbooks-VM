// -----------------------------------------------------------------------------
//  /api/credit-cards - every Credit Card account on the QBO chart of accounts.
//
//  v1 (Jul 29 2026): built for the Vistamark Admin Portal's Credit Card
//  Expenses console (vistarandall.app/admin/credit-card-expenses). The portal
//  calls this SERVER-SIDE from its own authed route, so CORS matters only for
//  manual browser probes; the allowlist still gains the vistarandall origins.
//
//  Returns ALL Credit Card-type accounts, active and inactive alike (the
//  console shows the flag), sorted active-first then by name. QBO sign
//  convention: a positive CurrentBalance on a credit card is the amount OWED.
//
//  Response shape:
//      { source, pulledAt, count,
//        cards:[{ id, name, accountSubType, active, balance, currency }] }
//
//  Mirrors api/cash-position.js conventions: shared _qbo-token.js for OAuth,
//  same ACCESS_TOKEN / ?key= gate via _gate.js (fail-closed + timing-safe),
//  same realm default, same ?diag=1 and ?debug=1 semantics.
// -----------------------------------------------------------------------------

const { getAccessToken, tokenDiagnostics } = require('./_qbo-token.js');
const { enforceGate, gateInfo } = require('./_gate.js');

const QBO_BASE = 'https://quickbooks.api.intuit.com';

const ALLOWED_ORIGINS = new Set([
  'https://vistarandall.app',
  'https://www.vistarandall.app',
  'https://vistabalancer.app',
  'https://www.vistabalancer.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
]);

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin',
    (origin && ALLOWED_ORIGINS.has(origin)) ? origin : 'https://vistarandall.app');
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

function creditCardQueryUrl(realmId) {
  const q = encodeURIComponent(
    "select Id, Name, AccountType, AccountSubType, CurrentBalance, Active, CurrencyRef from Account where AccountType = 'Credit Card' maxresults 1000"
  );
  return `${QBO_BASE}/v3/company/${realmId}/query?query=${q}&minorversion=70`;
}

function shapeCards(queryBody) {
  const rows = (queryBody && queryBody.QueryResponse && queryBody.QueryResponse.Account) || [];
  const cards = rows.map(a => ({
    id: a.Id,
    name: a.Name,
    accountSubType: a.AccountSubType || null,
    active: a.Active === undefined ? true : !!a.Active,
    balance: r2(a.CurrentBalance),
    currency: (a.CurrencyRef && a.CurrencyRef.value) || 'USD',
  }));
  cards.sort((x, y) =>
    (x.active === y.active) ? String(x.name).localeCompare(String(y.name)) : (x.active ? -1 : 1)
  );
  return cards;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  const diag  = req.query && (req.query.diag === '1'  || req.query.diag === 'true');

  if (diag) {
    const gate = gateInfo(req);
    let tdiag = null;
    if (gate.keyMatches) { try { tdiag = typeof tokenDiagnostics === 'function' ? tokenDiagnostics() : {}; } catch (_) { tdiag = {}; } }
    return res.status(200).json({
      diag: true,
      endpoint: 'credit-cards',
      gate,
      token: gate.keyMatches ? tdiag : 'redacted - pass the gate key to see token diagnostics',
      note: 'Returns every AccountType=Credit Card row on the chart of accounts, active and inactive.',
    });
  }

  if (!enforceGate(req, res)) return;

  const realmId = process.env.QBO_REALM_ID || '9341454566029927';

  try {
    const accessToken = await getAccessToken();
    const url = creditCardQueryUrl(realmId);
    const r = await getJson(url, accessToken);

    if (debug) {
      return res.status(200).json({ debug: true, qboStatus: r.status, qboUrl: url, rawResponse: r.body });
    }
    if (!r.ok) {
      return res.status(502).json({ error: 'Account query failed (' + r.status + ')', detail: r.body });
    }

    const cards = shapeCards(r.body);
    return res.status(200).json({
      source: "QuickBooks chart of accounts (live), AccountType = 'Credit Card'",
      pulledAt: new Date().toISOString(),
      count: cards.length,
      cards,
    });
  } catch (err) {
    const status = err.httpStatus || err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({ error: err.message || 'Unexpected error', detail: err.detail || null, code: err.code || null });
  }
};
