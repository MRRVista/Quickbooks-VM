// ─────────────────────────────────────────────────────────────────────────────
//  /api/w2-ytd — READ-ONLY YTD W-2 gross by individual, live from QuickBooks.
//
//  Returns the same shape as VistaBalancer's baked _VB_W2_PAID_SEED:
//    { asOfPayDate, payPeriod, paySchedule, source, pulledAt, employees[], firmTotal }
//
//  Auth:
//    - Browser fetch sends header  ACCESS_TOKEN: <shared secret>
//    - OR (for phone/browser-bar testing) a  ?key=<shared secret>  query param
//    - Compared against process.env.VB_ACCESS_TOKEN
//    - QuickBooks OAuth secrets never leave the server
//
//  Diagnostics:
//    - ?debug=1  (with valid key/header) returns the RAW Intuit response so we
//      can see exactly what payroll endpoint shape comes back.
//
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
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://vistabalancer.app');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ACCESS_TOKEN');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Shared-secret gate: header OR ?key= query param (the latter for browser-bar testing).
  const expected = process.env.VB_ACCESS_TOKEN;
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  if (expected) {
    const got = req.headers['access_token'] || req.headers['x-access-token'] ||
                (req.query && req.query.key);
    if (got !== expected) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const realmId = process.env.QBO_REALM_ID || '9341454566029927';

  try {
    const accessToken = await getAccessToken();

    const url = `${QBO_BASE}/v3/company/${realmId}/payslips?minorversion=70`;

    const qboResp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Accept': 'application/json',
      },
    });

    const text = await qboResp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }

    // Debug mode: surface the raw Intuit response + status so we can see the shape.
    if (debug) {
      return res.status(200).json({
        debug: true,
        qboStatus: qboResp.status,
        qboUrl: url,
        rawResponse: data,
      });
    }

    if (!qboResp.ok) {
      return res.status(qboResp.status === 401 ? 401 : 502).json({
        error: 'QuickBooks payslips fetch failed (' + qboResp.status + ')',
        detail: data.Fault || data.fault || data.raw || data,
      });
    }

    const slips =
      data.Payslip || data.payslips || data.items ||
      (data.QueryResponse && data.QueryResponse.Payslip) || [];

    const byEmp = new Map();
    let latestPayDate = null;
    let latestPeriod = null;
    let paySchedule = null;

    for (const s of slips) {
      const name =
        (s.employee && (s.employee.name || s.employee.display_name)) ||
        s.employee_name || s.name || 'Unknown';

      const payDate = s.pay_date || (s.period && s.period.pay_date) || null;

      const ytdGross =
        (s.gross_pay && (s.gross_pay.year_to_date_amount ?? s.gross_pay.ytd_amount)) ??
        s.ytd_gross ?? null;

      if (ytdGross == null) continue;

      const prev = byEmp.get(name);
      if (!prev || (payDate && prev.payDate && payDate > prev.payDate) || (payDate && !prev.payDate)) {
        byEmp.set(name, { name, ytdGross: Number(ytdGross), payDate });
      }

      if (payDate && (!latestPayDate || payDate > latestPayDate)) {
        latestPayDate = payDate;
        latestPeriod = s.period
          ? { begin: s.period.begin_date || s.period.start_date, end: s.period.end_date }
          : null;
        paySchedule = s.pay_schedule || s.schedule || paySchedule;
      }
    }

    const employees = Array.from(byEmp.values())
      .map(e => ({ name: e.name, ytdGross: e.ytdGross }))
      .sort((a, b) => b.ytdGross - a.ytdGross);

    const firmTotal = employees.reduce((sum, e) => sum + (e.ytdGross || 0), 0);

    return res.status(200).json({
      asOfPayDate: latestPayDate,
      payPeriod: latestPeriod,
      paySchedule: paySchedule || 'Twice a month',
      source: 'QuickBooks Payroll (live)',
      pulledAt: new Date().toISOString(),
      employees,
      firmTotal,
    });

  } catch (err) {
    const status = err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({
      error: err.message || 'Unexpected error',
      code: err.code || null,
    });
  }
};
