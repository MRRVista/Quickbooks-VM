// -----------------------------------------------------------------------------
//  /api/cash-position - LIVE bank cash balance, from QuickBooks.
//
//  v2 (Jul 8 2026): COMPOSITE MODE. The physical operating account (...9619)
//  exists as TWO ledgers in QBO - "Vistamark Investments Checking (9619)"
//  (Id 11, CashOnHand) and "Vistamark IL (9619)" (Id 281, Checking) - with
//  activity split across them. A single-ledger CurrentBalance therefore
//  overstates cash by the other ledger's balance (triangulated Jul 8 2026:
//  Id 11 alone = 225,126.73; both summed = 134,255.86; actual Chase balance
//  = 131,729.70 -> the sum lands within ~2.5K = genuinely uncleared items,
//  which the app-side Bank Adjustment field exists to absorb).
//
//  Behavior: match ALL active Bank-type accounts whose Name contains the
//  configured string (default now '9619' - the account-number mask present
//  in both ledger names), SUM their CurrentBalance, and return the composite.
//  After the ledgers are merged in QBO the sum degenerates to the single
//  register - no further code change needed.
//
//  Response shape (superset of v1; the app reads currentBalance + account.name):
//      { source, pulledAt,
//        account:{ id, name, accountType, accountSubType },   // primary ledger
//        currentBalance,                                       // SUM of matches
//        componentCount, components:[{ id, name, accountSubType, balance }],
//        currency }
//
//  Mirrors api/pnl-ytd.js conventions: shared _qbo-token.js for OAuth, same
//  CORS allowlist, same ACCESS_TOKEN / ?key= gate via _gate.js (fail-closed +
//  timing-safe), same realm default, same ?diag=1 and ?debug=1 semantics.
//
//  Auth: header ACCESS_TOKEN:<secret>  OR  ?key=<secret>  vs VB_ACCESS_TOKEN
//  CORS: locked to vistabalancer.app (+ localhost).
// -----------------------------------------------------------------------------

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

// Pull all Bank accounts (small list); name-contains match happens in JS so we
// avoid QBQL quote-escaping and tolerate naming drift.
function bankAccountsQueryUrl(realmId) {
  const q = encodeURIComponent("select Id, Name, AccountType, AccountSubType, CurrentBalance, Active from Account where AccountType = 'Bank'");
  return `${QBO_BASE}/v3/company/${realmId}/query?query=${q}&minorversion=70`;
}

// v2: return EVERY active bank ledger whose name contains the configured
// string, sorted by balance desc (largest = primary for display/back-compat).
function pickAccounts(queryBody, wantName) {
  const rows = (queryBody && queryBody.QueryResponse && queryBody.QueryResponse.Account) || [];
  const want = String(wantName || '').toLowerCase().trim();
  const matches = rows.filter(a =>
    (a.Active === undefined || a.Active === true) &&
    String(a.Name || '').toLowerCase().includes(want)
  );
  matches.sort((a, b) => (+b.CurrentBalance || 0) - (+a.CurrentBalance || 0));
  return matches;
}

async function computeCash(accessToken, realmId, wantName) {
  const url = bankAccountsQueryUrl(realmId);
  const r = await getJson(url, accessToken);
  if (!r.ok) { const e = new Error('Account query failed (' + r.status + ')'); e.detail = r.body; e.httpStatus = r.status; throw e; }
  const matches = pickAccounts(r.body, wantName);
  if (!matches.length) { const e = new Error('No matching bank account for "' + wantName + '"'); e.httpStatus = 404; throw e; }

  const sum = r2(matches.reduce((s, a) => s + (+a.CurrentBalance || 0), 0));
  const primary = matches[0];
  const multi = matches.length > 1;

  return {
    source: multi
      ? 'QuickBooks Account.CurrentBalance (live, composite of ' + matches.length + ' ledgers)'
      : 'QuickBooks Account.CurrentBalance (live)',
    pulledAt: new Date().toISOString(),
    account: {
      id: primary.Id,
      name: multi ? (primary.Name + ' + ' + (matches.length - 1) + ' linked ledger(s), net') : primary.Name,
      accountType: primary.AccountType,
      accountSubType: primary.AccountSubType || null,
    },
    currentBalance: sum,
    componentCount: matches.length,
    components: matches.map(a => ({
      id: a.Id,
      name: a.Name,
      accountSubType: a.AccountSubType || null,
      balance: r2(a.CurrentBalance),
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

  // v2 default: match on the account-number mask so BOTH split 9619 ledgers
  // resolve. Override with env QBO_CASH_ACCOUNT_NAME.
  const wantName = process.env.QBO_CASH_ACCOUNT_NAME || '9619';

  if (diag) {
    const gate = gateInfo(req);
    let tdiag = null;
    if (gate.keyMatches) { try { tdiag = typeof tokenDiagnostics === 'function' ? tokenDiagnostics() : {}; } catch (_) { tdiag = {}; } }
    return res.status(200).json({
      diag: true,
      endpoint: 'cash-position',
      gate,
      token: gate.keyMatches ? tdiag : 'redacted - pass the gate key to see token diagnostics',
      cashAccountName: wantName,
      mode: 'composite-sum (v2): all active Bank ledgers whose Name contains the match string are summed',
      note: 'keyMatches=false -> your key does not equal VB_ACCESS_TOKEN. ' +
            'Override the match string with env QBO_CASH_ACCOUNT_NAME.',
    });
  }

  if (!enforceGate(req, res)) return;

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