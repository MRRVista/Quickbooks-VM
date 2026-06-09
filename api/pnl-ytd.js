// ─────────────────────────────────────────────────────────────────────────────
//  /api/pnl-ytd — LIVE YTD Profit & Loss, from QuickBooks.
//
//  Mirrors api/w2-ytd.js conventions exactly: shared _qbo-token.js for OAuth,
//  same CORS allowlist, same ACCESS_TOKEN / ?key= auth, same realm default.
//
//  Pulls the standard ProfitAndLoss report summarized BY MONTH, then reads the
//  authoritative section Summary rows (QBO's own computed totals) for Income,
//  Expenses, and Net Income. Income is EXPANDED to leaf accounts (each revenue
//  group emits a bold subtotal row followed by its indented child accounts);
//  expenses stay grouped at the top sub-section level. Reading Summary rows
//  (rather than summing leaves) guarantees totals match QuickBooks exactly,
//  including amounts posted directly to a parent account header. Shape consumed
//  by the app's _pnlNormalize():
//      { months:['Jan',...],
//        income:[{name,monthly[],ytd,depth,isGroup}],
//        expenses:[{name,monthly[],ytd}],
//        totals:{ incomeMonthly[], expenseMonthly[], incomeYtd, expenseYtd,
//                 netMonthly[], netYtd } }
//  depth/isGroup are optional render hints; the app indents children by depth
//  and bolds isGroup subtotal rows. Totals always come from QBO Summary rows,
//  so the group + leaf rows are display-only and never double-counted.
//
//  Auth: header ACCESS_TOKEN:<secret>  OR  ?key=<secret>  vs VB_ACCESS_TOKEN
//  Diagnostics:
//    ?diag=1   NO-SECRET health check. Runs BEFORE the gate. Reports whether
//              your key matched the gate, KV status, and a client-id fingerprint
//              (first4…last4 only). Use this to tell a gate-401 from an
//              Intuit-401 without exposing anything.
//    ?debug=1  (requires valid key/header) returns the raw QBO P&L body.
//  CORS: locked to vistabalancer.app (+ localhost).
// ─────────────────────────────────────────────────────────────────────────────

const { getAccessToken, tokenDiagnostics } = require('./_qbo-token.js');

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

// Line items for a top-level section.
//   expand=false → one summary line per immediate child sub-section/account
//                  (used for Expenses — keeps the table compact).
//   expand=true  → for each child sub-section, emit a bold group subtotal row
//                  (from its QBO Summary) then recurse into its children,
//                  indented via depth. Direct child Data rows emit as-is.
//                  (used for Income — drills revenue down to the named payors.)
// Totals are always taken from the section Summary elsewhere, so these rows are
// display-only and the group+leaf mix never affects the headline numbers.
function sectionLines(section, monthCols, expand, depth, out) {
  out = out || [];
  depth = depth || 0;
  const kids = (section.Rows && section.Rows.Row) || [];
  for (const row of (Array.isArray(kids) ? kids : [kids])) {
    const isGroupNode = row.Rows && row.Rows.Row;
    if (isGroupNode) {
      const sum = row.Summary && row.Summary.ColData;
      const name = (sum && sum[0] && sum[0].value || '').replace(/^Total\s+/i, '').trim();
      const monthly = sum ? rowToMonthly(sum, monthCols) : [];
      const ytd = monthly.reduce((s, v) => s + v, 0);
      if (!expand) {
        if (name) out.push({ name, monthly: monthly.map(r2), ytd: r2(ytd) });
      } else {
        if (name) out.push({ name, monthly: monthly.map(r2), ytd: r2(ytd), depth, isGroup: true });
        sectionLines(row, monthCols, expand, depth + 1, out);
      }
    } else if (row.ColData) {
      const name = (row.ColData[0] && row.ColData[0].value || '').trim();
      if (!name) continue;
      const monthly = rowToMonthly(row.ColData, monthCols);
      const ytd = monthly.reduce((s, v) => s + v, 0);
      if (ytd === 0 && monthly.every(v => v === 0)) continue;
      const item = { name, monthly: monthly.map(r2), ytd: r2(ytd) };
      if (expand) item.depth = depth;
      out.push(item);
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

  // Income drilled to leaf accounts (group subtotal + indented children).
  const income   = incomeSec  ? sectionLines(incomeSec, monthCols, true)   : [];
  // Expenses kept grouped at the top sub-section level.
  const expenses = expenseSec ? sectionLines(expenseSec, monthCols, false) : [];

  const readSummary = (sec) => {
    const sum = sec && sec.Summary && sec.Summary.ColData;
    if (!sum) return null;
    const monthly = rowToMonthly(sum, monthCols);
    return { monthly: monthly.map(r2), ytd: r2(monthly.reduce((s, v) => s + v, 0)) };
  };
  const incT = readSummary(incomeSec);
  const expT = readSummary(expenseSec);

  // Totals come from QBO Summary rows. For income (now a mix of group + leaf
  // rows) we must NOT sum the display rows — use the section Summary directly.
  const incomeMonthly  = incT ? incT.monthly : months.map((_, i) => r2(income.filter(r => !r.isGroup).reduce((s, r) => s + r.monthly[i], 0)));
  const expenseMonthly = expT ? expT.monthly : months.map((_, i) => r2(expenses.reduce((s, r) => s + r.monthly[i], 0)));
  const incomeYtd  = incT ? incT.ytd : r2(income.filter(r => !r.isGroup).reduce((s, r) => s + r.ytd, 0));
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
  const got = req.headers['access_token'] || req.headers['x-access-token'] || (req.query && req.query.key);
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  const diag  = req.query && (req.query.diag === '1'  || req.query.diag === 'true');

  // ── ?diag=1 — NO-SECRET health check. Runs BEFORE the gate so it always
  //    answers, telling you exactly which wall you're hitting. Returns no
  //    secret values — only booleans, lengths, and a fingerprint. ──────────
  if (diag) {
    let tdiag = {};
    try { tdiag = typeof tokenDiagnostics === 'function' ? tokenDiagnostics() : {}; } catch (_) {}
    return res.status(200).json({
      diag: true,
      gate: {
        vbAccessTokenConfigured: !!expected,
        keyProvided: !!got,
        keyMatches: !!expected && got === expected,   // true ONLY when your key is correct
        keyLengthSeen: got ? String(got).length : 0,
        expectedLength: expected ? String(expected).length : 0,
      },
      token: tdiag,    // kvEnabled, kvKey, hasEnvSeed, hasClientId, hasClientSecret, clientIdFingerprint, realmId
      note: 'keyMatches=false → your ?key= does not equal VB_ACCESS_TOKEN. ' +
            'kvEnabled=false → connect a Vercel KV/Upstash store for self-healing. ' +
            'clientIdFingerprint must match the app you minted the refresh token from.',
    });
  }

  if (expected) {
    if (got !== expected) return res.status(401).json({ error: 'Unauthorized', gate: true });
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
