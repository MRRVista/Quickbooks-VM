// ─────────────────────────────────────────────────────────────────────────────
//  /api/w2-ytd — LIVE YTD W-2 gross by individual, from QuickBooks.
//
//  HOW IT WORKS (the path we proved works under com.intuit.quickbooks.accounting):
//    The payslips REST endpoint is unsupported on the Accounting API, and the
//    PayrollSummaryByEmployee report is permission-gated. BUT the standard
//    ProfitAndLoss report, summarized by Employees, returns per-employee Wages
//    expense — and Vistamark's books carry wages across TWO "Wages" accounts
//    (137 "Payroll and Employee Expenses > Wages" + 282 "Payroll Expenses >
//    Wages"). Summing every account literally named "Wages" per employee column
//    reproduces gross W-2 YTD exactly:
//        Rice 129433.50 + 14761.50 = 144195.00   (matches W-2)
//        McEvilly 99759.50 + 11247.50 = 111007.00
//        Walter   56250.00 +  6250.00 =  62500.00
//        Seyfarth 19525.50 +  2371.50 =  21897.00
//        firm                          = 339599.00
//
//    So: pull P&L summarized by Employees, find every row whose account label is
//    exactly "Wages", and sum that row's per-employee column amounts.
//
//  Auth: header ACCESS_TOKEN:<secret>  OR  ?key=<secret>  vs VB_ACCESS_TOKEN
//  Diagnostics (valid key/header): ?debug=1 (raw P&L), ?path=NAME, ?probe=1
//  CORS: locked to vistabalancer.app (+ localhost).
// ─────────────────────────────────────────────────────────────────────────────

const { getAccessToken } = require('./_qbo-token.js');

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

// Build the employee-column map from the P&L report header.
// Columns look like: [account, <empId cols...>, "Not Specified", "TOTAL"]
function buildEmployeeColumns(report) {
  const cols = (report.Columns && report.Columns.Column) || [];
  const employees = [];   // { name, colIndex }
  cols.forEach((c, idx) => {
    const key = (c.MetaData || []).find(m => m.Name === 'ColKey');
    const colKey = key ? key.Value : '';
    // Employee columns have a numeric ColKey (the QBO employee Id).
    // Skip 'account', 'not_specified', 'total'.
    if (/^\d+$/.test(colKey) && c.ColType === 'Money') {
      employees.push({ name: c.ColTitle, colIndex: idx, ytdGross: 0 });
    }
  });
  return employees;
}

// Recursively walk report rows; whenever we hit a Data row whose account label
// (ColData[0].value) is exactly "Wages", add each employee column's amount.
function sumWages(rows, employees) {
  if (!rows || !rows.Row) return;
  for (const row of rows.Row) {
    if (row.ColData) {
      const label = (row.ColData[0] && row.ColData[0].value || '').trim().toLowerCase();
      if (label === 'wages') {
        for (const emp of employees) {
          const cell = row.ColData[emp.colIndex];
          const v = cell && cell.value ? parseFloat(cell.value) : 0;
          if (!isNaN(v)) emp.ytdGross += v;
        }
      }
    }
    if (row.Rows) sumWages(row.Rows, employees);   // recurse into sections
  }
}

async function computeW2(accessToken, realmId) {
  const yr = new Date().getFullYear();
  const start = yr + '-01-01';
  const today = new Date().toISOString().slice(0, 10);
  const url = `${QBO_BASE}/v3/company/${realmId}/reports/ProfitAndLoss` +
              `?start_date=${start}&end_date=${today}&summarize_column_by=Employees&minorversion=70`;
  const r = await getJson(url, accessToken);
  if (!r.ok) { const e = new Error('P&L report failed (' + r.status + ')'); e.detail = r.body; e.httpStatus = r.status; throw e; }

  const report = r.body;
  const employees = buildEmployeeColumns(report);
  sumWages(report.Rows, employees);

  const out = employees
    .filter(e => e.ytdGross > 0)
    .map(e => ({ name: e.name, ytdGross: Math.round(e.ytdGross * 100) / 100 }))
    .sort((a, b) => b.ytdGross - a.ytdGross);
  const firmTotal = Math.round(out.reduce((s, e) => s + e.ytdGross, 0) * 100) / 100;

  return {
    asOfPayDate: today,
    payPeriod: { begin: start, end: today },
    paySchedule: 'YTD through report date',
    source: 'QuickBooks P&L by Employee (Wages, live)',
    pulledAt: new Date().toISOString(),
    employees: out,
    firmTotal,
  };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const expected = process.env.VB_ACCESS_TOKEN;
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  const onePath = req.query && req.query.path;
  if (expected) {
    const got = req.headers['access_token'] || req.headers['x-access-token'] || (req.query && req.query.key);
    if (got !== expected) return res.status(401).json({ error: 'Unauthorized' });
  }

  const realmId = process.env.QBO_REALM_ID || '9341454566029927';

  try {
    const accessToken = await getAccessToken();

    // Diagnostic: raw P&L-by-employee body
    if (debug) {
      const yr = new Date().getFullYear();
      const url = `${QBO_BASE}/v3/company/${realmId}/reports/ProfitAndLoss` +
                  `?start_date=${yr}-01-01&end_date=${new Date().toISOString().slice(0,10)}&summarize_column_by=Employees&minorversion=70`;
      const r = await getJson(url, accessToken);
      return res.status(200).json({ debug: true, qboStatus: r.status, qboUrl: url, rawResponse: r.body });
    }

    // PRIMARY: compute live W-2 YTD from P&L Wages rows
    const result = await computeW2(accessToken, realmId);
    if (!result.employees.length) {
      return res.status(502).json({ error: 'No Wages rows found in P&L-by-employee report' });
    }
    return res.status(200).json(result);

  } catch (err) {
    const status = err.httpStatus || err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({ error: err.message || 'Unexpected error', detail: err.detail || null, code: err.code || null });
  }
};
