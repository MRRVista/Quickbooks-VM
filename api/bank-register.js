// ─────────────────────────────────────────────────────────────────────────────
//  /api/bank-register — transaction-level bank register rows from QuickBooks.
//
//  v1 (2026-08-08, Matt: "Sync to 1/1/26. Reconcile with Chase/plaid data.")
//  VistaBooks rebuilds its ledger from the direct Chase Plaid feed, but the
//  Plaid Items only reach back to 2026-05-07; QuickBooks holds the bank
//  history from the VistaBooks opening date (2025-12-31) up to that edge.
//  The Claude/QBO MCP surface is reports-only (category totals), so this
//  endpoint is the row-level door: it walks the QBO GeneralLedger report for
//  a date range, filters to one bank/credit-card account, and emits register
//  rows as JSON or as CSV shaped for vistarandall's qbo_import
//  (Date,Description,Amount,Category — parseQboCsv's recognized headers).
//
//  Sign (validated 2026-08-08 against the Plaid overlap window): QBO's GL
//  presents the checking accounts in bank convention — deposit(+)/payment(−),
//  so qbo_import sign:"bank" flips them to the Plaid convention. The credit
//  card comes through in statement convention — charge(+)/payment(−) — which
//  IS the Plaid convention already, so the card imports with sign:"plaid".
//  This endpoint never re-signs anything; the caller picks per account.
//
//  v1.1: cell() strips CR/LF/tab from every field so a multiline QBO memo
//  can never break the one-row-per-line CSV contract (space runs are left
//  alone to keep qbo: dedupe hashes stable for rows already imported).
//
//  GET params:
//    account=<substring>   required unless list=1 — case-insensitive match
//                          against GL account section names.
//    from=YYYY-MM-DD       required.
//    to=YYYY-MM-DD         required.
//    format=json|csv       default json.
//    list=1                list account section names in range (no rows).
//    debug=1               raw QBO GL body (valid key required).
//    diag=1                gate/token health, same contract as pnl-ytd.
//
//  Auth: header ACCESS_TOKEN:<secret>  OR  ?key=<secret>  vs VB_ACCESS_TOKEN
//  CORS: same allowlist as pnl-ytd.
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

// ColTitle (lowercased) → column index, so we never depend on column order.
function colIndexMap(report) {
  const cols = (report.Columns && report.Columns.Column) || [];
  const map = {};
  cols.forEach((c, idx) => {
    const t = String(c.ColTitle || '').toLowerCase().trim();
    if (t && !(t in map)) map[t] = idx;
  });
  return map;
}

// Newlines and tabs inside a field would break the one-row-per-line CSV
// contract downstream; space runs are deliberately preserved so identical
// rows keep producing identical qbo: dedupe hashes across re-imports.
function cell(colData, idx) {
  if (idx == null || !colData || !colData[idx]) return '';
  const v = colData[idx].value;
  return v == null ? '' : String(v).replace(/[\r\n\t]+/g, ' ').trim();
}

// Collect every descendant Data row of a matched account section.
function collectRows(section, cols, out, accountName) {
  const rows = (section.Rows && section.Rows.Row) || [];
  for (const row of (Array.isArray(rows) ? rows : [rows])) {
    if (row.Rows && row.Rows.Row) { collectRows(row, cols, out, accountName); continue; }
    const cd = row.ColData;
    if (!cd) continue;
    const date = cell(cd, cols['date']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skips Beginning Balance etc.
    const amount = parseFloat(cell(cd, cols['amount']));
    if (!isFinite(amount)) continue;
    const name = cell(cd, cols['name']);
    const memo = cell(cd, cols['memo/description']) || cell(cd, cols['memo']);
    const txnType = cell(cd, cols['transaction type']);
    const split = cell(cd, cols['split']);
    const description = [name, memo].filter(Boolean).join(' — ') || txnType || 'QBO entry';
    out.push({ account: accountName, date, txnType, name, memo, split, amount, description });
  }
}

// Walk GL sections; a section whose header matches `filter` contributes all
// of its descendant rows, everything else is searched deeper. With an empty
// filter this only accumulates section names (list mode).
function collect(section, filter, cols, out, names) {
  const rows = (section.Rows && section.Rows.Row) || [];
  for (const row of (Array.isArray(rows) ? rows : [rows])) {
    if (!(row.Rows && row.Rows.Row)) continue;
    const header = row.Header && row.Header.ColData && row.Header.ColData[0]
      ? String(row.Header.ColData[0].value || '').trim() : '';
    if (header) names.add(header);
    if (header && filter && header.toLowerCase().includes(filter)) {
      collectRows(row, cols, out, header);
    } else {
      collect(row, filter, cols, out, names);
    }
  }
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  const lines = ['Date,Description,Amount,Category'];
  for (const r of rows) {
    lines.push([r.date, csvEscape(r.description), r.amount, csvEscape(r.split || '')].join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const q = req.query || {};
  const diag = q.diag === '1' || q.diag === 'true';
  if (diag) {
    const gate = gateInfo(req);
    let tdiag = null;
    if (gate.keyMatches) { try { tdiag = typeof tokenDiagnostics === 'function' ? tokenDiagnostics() : {}; } catch (_) { tdiag = {}; } }
    return res.status(200).json({
      diag: true,
      gate,
      token: gate.keyMatches ? tdiag : 'redacted — pass the gate key to see token diagnostics',
    });
  }

  if (!enforceGate(req, res)) return;

  const from = String(q.from || '');
  const to = String(q.to || '');
  const listOnly = q.list === '1' || q.list === 'true';
  const filter = String(q.account || '').trim().toLowerCase();
  const format = String(q.format || 'json').toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD' });
  }
  if (!listOnly && !filter) {
    return res.status(400).json({ error: 'account is required (or pass list=1)' });
  }

  const realmId = process.env.QBO_REALM_ID || '9341454566029927';

  try {
    const accessToken = await getAccessToken();
    const url = QBO_BASE + '/v3/company/' + realmId + '/reports/GeneralLedger' +
      '?start_date=' + from + '&end_date=' + to +
      '&accounting_method=Accrual&minorversion=70';
    const r = await getJson(url, accessToken);
    if (q.debug === '1') {
      return res.status(200).json({ debug: true, qboStatus: r.status, qboUrl: url, rawResponse: r.body });
    }
    if (!r.ok) {
      const e = new Error('GeneralLedger report failed (' + r.status + ')');
      e.detail = r.body; e.httpStatus = r.status; throw e;
    }

    const cols = colIndexMap(r.body);
    const out = [];
    const names = new Set();
    collect(r.body, listOnly ? '' : filter, cols, out, names);

    if (listOnly) {
      return res.status(200).json({
        from, to, accounts: Array.from(names).sort(), pulledAt: new Date().toISOString(),
      });
    }

    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.status(200).send(toCsv(out));
    }
    return res.status(200).json({
      source: 'QuickBooks GeneralLedger (live)',
      from, to, account: filter,
      accountsMatched: Array.from(new Set(out.map((x) => x.account))),
      count: out.length,
      rows: out,
      pulledAt: new Date().toISOString(),
    });
  } catch (err) {
    const status = err.httpStatus || err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({ error: err.message || 'Unexpected error', detail: err.detail || null, code: err.code || null });
  }
};
