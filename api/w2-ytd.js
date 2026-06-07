// ─────────────────────────────────────────────────────────────────────────────
//  /api/w2-ytd — READ-ONLY YTD W-2 gross by individual, from QuickBooks.
//
//  Auth: header ACCESS_TOKEN:<secret>  OR  ?key=<secret>  vs VB_ACCESS_TOKEN
//  Diagnostics (valid key/header required):
//    ?debug=1   → raw payslips response
//    ?probe=1   → full bodies for the data-returning candidate paths
//    ?path=NAME → return ONE path's full raw body (employee | pnlEmp | pnlDetail)
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

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const expected = process.env.VB_ACCESS_TOKEN;
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  const probe = req.query && (req.query.probe === '1' || req.query.probe === 'true');
  const onePath = req.query && req.query.path;
  if (expected) {
    const got = req.headers['access_token'] || req.headers['x-access-token'] || (req.query && req.query.key);
    if (got !== expected) return res.status(401).json({ error: 'Unauthorized' });
  }

  const realmId = process.env.QBO_REALM_ID || '9341454566029927';
  const base = `${QBO_BASE}/v3/company/${realmId}`;
  const yr = new Date().getFullYear();
  const start = yr + '-01-01';
  const today = new Date().toISOString().slice(0, 10);
  const q = (s) => encodeURIComponent(s);

  const PATHS = {
    employee:  `${base}/query?query=${q('select * from Employee')}&minorversion=70`,
    pnlEmp:    `${base}/reports/ProfitAndLoss?start_date=${start}&end_date=${today}&summarize_column_by=Employees&minorversion=70`,
    pnlDetail: `${base}/reports/ProfitAndLossDetail?start_date=${start}&end_date=${today}&minorversion=70`,
  };

  try {
    const accessToken = await getAccessToken();

    // Single full-body path inspection
    if (onePath && PATHS[onePath]) {
      const r = await getJson(PATHS[onePath], accessToken);
      return res.status(200).json({ path: onePath, url: PATHS[onePath], status: r.status, body: r.body });
    }

    // Probe the three data-returning candidates, FULL bodies (no truncation)
    if (probe) {
      const out = {};
      for (const k of Object.keys(PATHS)) {
        const r = await getJson(PATHS[k], accessToken);
        out[k] = { status: r.status, ok: r.ok, body: r.body };
      }
      return res.status(200).json({ probe: true, realmId, results: out });
    }

    // debug = raw payslips
    const url = `${base}/payslips?minorversion=70`;
    const pr = await getJson(url, accessToken);
    if (debug) return res.status(200).json({ debug: true, qboStatus: pr.status, qboUrl: url, rawResponse: pr.body });
    if (!pr.ok) return res.status(pr.status === 401 ? 401 : 502).json({ error: 'payslips failed (' + pr.status + ')', detail: pr.body });

    // (primary path unchanged; payslips is unsupported so this is effectively dead)
    return res.status(502).json({ error: 'payslips unsupported on this API surface' });

  } catch (err) {
    const status = err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({ error: err.message || 'Unexpected error', code: err.code || null });
  }
};
