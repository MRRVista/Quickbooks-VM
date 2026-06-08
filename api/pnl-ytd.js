// ─────────────────────────────────────────────────────────────────────────────
//  /api/pnl-ytd — LIVE YTD Profit & Loss, from QuickBooks.
//
//  Mirrors api/w2-ytd.js conventions exactly: shared _qbo-token.js for OAuth,
//  same CORS allowlist, same ACCESS_TOKEN / ?key= auth, same realm default.
//
//  Pulls the standard ProfitAndLoss report summarized BY MONTH, then reads the
//  authoritative section Summary rows (QBO's own computed totals) for Income,
//  Expenses, and Net Income — and lists each immediate sub-section as a line
//  item. Reading the Summary rows (rather than summing leaf rows) guarantees
//  the totals match QuickBooks exactly, including amounts posted directly to a
//  parent account header. Shape consumed by the app's _pnlNormalize():
//      { months:['Jan',...], income:[{name,monthly[],ytd}],
//        expenses:[{name,monthly[],ytd}],
//        totals:{ incomeMonthly[], expenseMonthly[], incomeYtd, expenseYtd,
//                 netMonthly[], netYtd } }
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

function r2(v) { return Math.round(v * 100) / 100; }

// Month columns: skip the leading account column and the trailing TOTAL column.
function buildMonthColumns(report) {
  const cols = (report.Columns && report.Columns.Column) || [];
  const months = [];
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

// A ColData array → per-month number array aligned to monthCols.
function rowToMonthly(colData, monthCols) {
  return monthCols.map(mc => {
    const cell = colData && colData[mc.colIndex];
    const v = cell && cell.value !== '' && cell.value != null ? parseFloat(cell.value) : 0;
    return isNaN(v) ? 0 : v;
  });
}

// Line items for a top-level section: each immediate child Section contributes
// its (QBO-computed) Summary row; each immediate child Data row contributes
// itself. This reproduces the section total exactly with no double counting and
// captures parent-header postings (which QBO already folds into the summary).
function sectionLines(section, monthCols) {
  const out = [];
  const kids = (section.Rows && section.Rows.Row) || [];
  for (const row of (Array.isArray(kids) ? kids : [kids])) {
    if (row.Summary && row.Summary.ColData) {
      const sum = row.Summary.ColData;
      const name = (sum[0] && sum[0].value || '').replace(/^Total\s+/i, '').trim();
      const monthly = rowToMonthly(sum, monthCols);
      const ytd = monthly.reduce((s, v) => s + v, 0);
      if (!name) continue;
      out.push({ name, monthly: monthly.map(r2), ytd: r2(ytd) });
    } else if (row.ColData) {
      const name = (row.ColData[0] && row.ColData[0].value || '').trim();
      if (!name) continue;
      const monthly = rowToMonthly(row.ColData, monthCols);
      const ytd = monthly.reduce((s, v) => s + v, 0);
      if (ytd === 0 && monthly.every(v => v === 0)) continue;
      out.push({ name, monthly: monthly.map(r2), ytd: r2(ytd) });
    }
  }
  return out;
}

function flattenPnl(report) {
  const monthCols = buildMonthColumns(report);
  const months = monthCols.map(m => m.title);
  const topRows = (report.Rows && report.Rows.Row) || [];

  let incomeSec = null, expenseSec = null, netSummary = null;
  for (const sec of (Array.isArray(topRows) ? topRows : [topRows])) {
    const g = String(sec.group || '').toLowerCase();
    if (g === 'income') incomeSec = sec;
    else if (g === 'expenses') expenseSec = sec;
    else if (g === 'netincome') netSummary = sec.Summary && sec.Summary.ColData;
  }

  const income   = incomeSec  ? sectionLines(incomeSec, monthCols)  : [];
  const expenses = expenseSec ? sectionLines(expenseSec, monthCols) : [];

  const readSummary = (sec) => {
    const sum = sec && sec.Summary && sec.Summary.ColData;
    if (!sum) return null;
    const monthly = rowToMonthly(sum, monthCols);
    return { monthly: monthly.map(r2), ytd: r2(monthly.reduce((s, v) => s + v, 0)) };
  };
  const incT = readSummary(incomeSec);
  const expT = readSummary(expenseSec);

  const incomeMonthly  = incT ? incT.monthly : months.map((_, i) => r2(income.reduce((s, r) => s + r.monthly[i], 0)));
  const expenseMonthly = expT ? expT.monthly : months.map((_, i) => r2(expenses.reduce((s, r) => s + r.monthly[i], 0)));
  const incomeYtd  = incT ? incT.ytd : r2(income.reduce((s, r) => s + r.ytd, 0));
  const expenseYtd = expT ? expT.ytd : r2(expenses.reduce((s, r) => s + r.ytd, 0));

  let netMonthly, netYtd;
  if (netSummary) {
    const nm = rowToMonthly(netSummary, monthCols);
    netMonthly = nm.map(r2);
    netYtd = r2(nm.reduce((s, v) => s + v, 0));
  } else {
    netMonthly = months.map((_, i) => r2(incomeMonthly[i] - expenseMonthly[i]));
    netYtd = r2(incomeYtd - expenseYtd);
  }

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
