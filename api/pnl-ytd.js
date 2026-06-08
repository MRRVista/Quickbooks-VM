// ─────────────────────────────────────────────────────────────────────────────
//  /api/pnl-ytd — LIVE YTD Profit & Loss, from QuickBooks.
//
//  Mirrors api/w2-ytd.js conventions exactly: shared _qbo-token.js for OAuth,
//  same CORS allowlist, same ACCESS_TOKEN / ?key= auth, same realm default.
//
//  Pulls the standard ProfitAndLoss report summarized BY MONTH, then walks the
//  Income and Expense sections, flattening leaf account rows into:
//      { months:['Jan',...], income:[{name,monthly[],ytd}],
//        expenses:[{name,monthly[],ytd}],
//        totals:{ incomeMonthly[], expenseMonthly[], incomeYtd, expenseYtd,
//                 netMonthly[], netYtd } }
//  which is the shape the VistaBalancer P&L tab's _pnlNormalize() consumes.
//
//  Auth: header ACCESS_TOKEN:<secret>  OR  ?key=<secret>  vs VB_ACCESS_TOKEN
//  Diagnostics (valid key/header): ?debug=1 returns the raw QBO P&L body.
//  CORS: locked to vistabalancer.app (+ localhost).
// ─────────────────────────────────────────────────────────────────────────────

const { getAccessToken } = require('./_qbo-token.js');

const QBO_BASE = 'https://quickbooks.api.intuit.com';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

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

// From the report header, list the month columns (skip the leading account
// column and the trailing TOTAL column). Returns short labels ['Jan',...].
function buildMonthColumns(report) {
  const cols = (report.Columns && report.Columns.Column) || [];
  const months = [];   // { title, colIndex }
  cols.forEach((c, idx) => {
    const colType = c.ColType || '';
    const title = c.ColTitle || '';
    const isTotal = title.toLowerCase() === 'total'
      || (c.MetaData || []).some(m => m.Name === 'ColKey' && String(m.Value).toLowerCase() === 'total');
    if (colType === 'Money' && !isTotal) {
      const m3 = title.slice(0, 3);
      months.push({ title: MONTHS.includes(m3) ? m3 : title, colIndex: idx });
    }
  });
  return months;
}

// Walk a section's rows, flattening leaf Data rows into bucket entries with a
// per-month array aligned to monthCols.
function collectSection(rows, monthCols, bucket) {
  if (!rows || !rows.Row) return;
  for (const row of rows.Row) {
    if (row.Rows && row.Rows.Row) { collectSection(row.Rows, monthCols, bucket); continue; }
    const cd = row.ColData;
    if (!cd || !cd.length) continue;
    const name = (cd[0] && cd[0].value || '').trim();
    if (!name) continue;
    const monthly = monthCols.map(mc => {
      const cell = cd[mc.colIndex];
      const v = cell && cell.value ? parseFloat(cell.value) : 0;
      return isNaN(v) ? 0 : v;
    });
    const ytd = monthly.reduce((s, v) => s + v, 0);
    if (ytd === 0 && monthly.every(v => v === 0)) continue;
    bucket.push({ name, monthly: monthly.map(v => Math.round(v * 100) / 100), ytd: Math.round(ytd * 100) / 100 });
  }
}

// Identify the top-level Income and Expense sections and collect their leaves.
function flattenPnl(report) {
  const monthCols = buildMonthColumns(report);
  const months = monthCols.map(m => m.title);
  const income = [], expenses = [];

  const topRows = (report.Rows && report.Rows.Row) || [];
  for (const sec of (Array.isArray(topRows) ? topRows : [topRows])) {
    const group = String(sec.group || '').toLowerCase();
    const header = String((sec.Header && sec.Header.ColData && sec.Header.ColData[0] && sec.Header.ColData[0].value) || '').toLowerCase();
    const isIncome  = group === 'income' || header.includes('income') || header.includes('revenue');
    const isExpense = group === 'expenses' || group === 'cogs'
      || header.includes('expense') || header.includes('cost of goods');
    if (isIncome && sec.Rows)  collectSection(sec.Rows, monthCols, income);
    else if (isExpense && sec.Rows) collectSection(sec.Rows, monthCols, expenses);
  }

  const sumCol = (rows, i) => Math.round(rows.reduce((s, r) => s + (r.monthly[i] || 0), 0) * 100) / 100;
  const incomeMonthly  = months.map((_, i) => sumCol(income, i));
  const expenseMonthly = months.map((_, i) => sumCol(expenses, i));
  const incomeYtd  = Math.round(income.reduce((s, r) => s + r.ytd, 0) * 100) / 100;
  const expenseYtd = Math.round(expenses.reduce((s, r) => s + r.ytd, 0) * 100) / 100;
  const netMonthly = months.map((_, i) => Math.round((incomeMonthly[i] - expenseMonthly[i]) * 100) / 100);
  const netYtd = Math.round((incomeYtd - expenseYtd) * 100) / 100;

  return { months, income, expenses,
    totals: { incomeMonthly, expenseMonthly, incomeYtd, expenseYtd, netMonthly, netYtd } };
}

async function computePnl(accessToken, realmId) {
  const yr = new Date().getFullYear();
  const start = yr + '-01-01';
  const today = new Date().toISOString().slice(0, 10);
  const url = `${QBO_BASE}/v3/company/${realmId}/reports/ProfitAndLoss` +
              `?start_date=${start}&end_date=${today}&summarize_column_by=Month&accounting_method=Accrual&minorversion=70`;
  const r = await getJson(url, accessToken);
  if (!r.ok) { const e = new Error('P&L report failed (' + r.status + ')'); e.detail = r.body; e.httpStatus = r.status; throw e; }

  const shaped = flattenPnl(r.body);
  return {
    source: 'QuickBooks ProfitAndLoss (live)',
    periodStart: start,
    periodEnd: today,
    pulledAt: new Date().toISOString(),
    ...shaped,
  };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const expected = process.env.VB_ACCESS_TOKEN;
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  if (expected) {
    const got = req.headers['access_token'] || req.headers['x-access-token'] || (req.query && req.query.key);
    if (got !== expected) return res.status(401).json({ error: 'Unauthorized' });
  }

  const realmId = process.env.QBO_REALM_ID || '9341454566029927';

  try {
    const accessToken = await getAccessToken();

    if (debug) {
      const yr = new Date().getFullYear();
      const url = `${QBO_BASE}/v3/company/${realmId}/reports/ProfitAndLoss` +
                  `?start_date=${yr}-01-01&end_date=${new Date().toISOString().slice(0,10)}&summarize_column_by=Month&accounting_method=Accrual&minorversion=70`;
      const r = await getJson(url, accessToken);
      return res.status(200).json({ debug: true, qboStatus: r.status, qboUrl: url, rawResponse: r.body });
    }

    const result = await computePnl(accessToken, realmId);
    if (!result.income.length && !result.expenses.length) {
      return res.status(502).json({ error: 'No income/expense rows found in P&L report' });
    }
    return res.status(200).json(result);

  } catch (err) {
    const status = err.httpStatus || err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({ error: err.message || 'Unexpected error', detail: err.detail || null, code: err.code || null });
  }
};
