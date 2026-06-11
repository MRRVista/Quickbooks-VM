// ─────────────────────────────────────────────────────────────────────────────
//  /api/coa-setup — one-shot chart-of-accounts setup for the partner expense
//  breakout + software vendor sub-accounts. DRY-RUN BY DEFAULT.
//
//  WHAT IT CREATES (only what doesn't already exist — idempotent by
//  FullyQualifiedName, case-insensitive):
//    Parents (Expense):
//      • Software & Technology        (override name: ?softwareParent=Software)
//      • Client Expenses / Prospect Expenses / COI Expenses
//    Children:
//      • one sub-account per software vendor under the software parent
//        (default list below; override: ?vendors=A,B,C)
//      • "<Category> - <INI>" under each partner category for each initial
//        (default MR,SM,RW,WS; override: ?initials=MR,SM,RW,WS,DB)
//
//  SAFETY:
//    • GET only, behind the shared fail-closed gate (_gate.js).
//    • Default is DRY-RUN: returns the full plan, writes NOTHING.
//      Add &apply=1 to actually create the accounts.
//    • Never edits or deletes existing accounts. Created accounts can be
//      made inactive in the QBO UI if you change your mind.
//    • Creating accounts does NOT reclassify historical transactions —
//      recategorize those in QBO (Batch reclassify / Accountant tools).
//
//  SUBTYPES (change in QBO UI anytime; deliberately conservative here —
//  confirm meals/entertainment tax treatment with your accountant):
//    software children  → DuesSubscriptions
//    partner categories → OtherBusinessExpenses
// ─────────────────────────────────────────────────────────────────────────────

const { getAccessToken } = require('./_qbo-token.js');
const { enforceGate } = require('./_gate.js');

const QBO_BASE = 'https://quickbooks.api.intuit.com';

const DEFAULT_SOFTWARE_PARENT = 'Software & Technology';
const DEFAULT_VENDORS = [
  'Advyzon', 'Wealthbox', 'YCharts', 'Microsoft 365', 'Anthropic (Claude)',
  'Intuit QuickBooks', 'Vercel', 'Microsoft Azure', 'Cloudflare', 'GitHub',
  'Fireflies.ai', 'Zoom', 'Adobe',
];
const PARTNER_CATEGORIES = ['Client Expenses', 'Prospect Expenses', 'COI Expenses'];
const DEFAULT_INITIALS = ['MR', 'SM', 'RW', 'WS'];
const SOFTWARE_SUBTYPE = 'DuesSubscriptions';
const CATEGORY_SUBTYPE = 'OtherBusinessExpenses';

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

async function qboGet(url, accessToken) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch (_) { body = { raw: t }; }
  return { status: r.status, ok: r.ok, body };
}

async function qboPost(url, accessToken, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch (_) { body = { raw: t }; }
  return { status: r.status, ok: r.ok, body };
}

// Parse a comma-separated override param with sane caps; ':' stripped because
// QBO reserves it for account hierarchy.
function parseListParam(raw, fallback, maxItems) {
  if (!raw) return fallback.slice();
  const items = String(raw).split(',')
    .map(s => s.trim().replace(/:/g, '').slice(0, 80))
    .filter(Boolean);
  return items.length ? items.slice(0, maxItems || 30) : fallback.slice();
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!enforceGate(req, res)) return;

  const realmId = process.env.QBO_REALM_ID || '9341454566029927';
  const q = req.query || {};
  const apply = q.apply === '1' || q.apply === 'true';

  const softwareParent = (q.softwareParent ? String(q.softwareParent).replace(/:/g, '').slice(0, 80) : DEFAULT_SOFTWARE_PARENT) || DEFAULT_SOFTWARE_PARENT;
  const vendors  = parseListParam(q.vendors,  DEFAULT_VENDORS, 30);
  const initials = parseListParam(q.initials, DEFAULT_INITIALS, 10).map(s => s.toUpperCase());

  try {
    const accessToken = await getAccessToken();

    // 1) Pull every Expense account (FQN map for idempotency).
    const query = encodeURIComponent("select Id, Name, FullyQualifiedName, Active, SubAccount from Account where AccountType = 'Expense' maxresults 1000");
    const existing = await qboGet(`${QBO_BASE}/v3/company/${realmId}/query?query=${query}&minorversion=70`, accessToken);
    if (!existing.ok) {
      return res.status(existing.status).json({ error: 'Account query failed', detail: existing.body });
    }
    const rows = (existing.body.QueryResponse && existing.body.QueryResponse.Account) || [];
    const byFqn = new Map();
    for (const a of rows) byFqn.set(String(a.FullyQualifiedName || a.Name || '').toLowerCase(), a);

    // 2) Build the desired tree.
    const desiredParents = [softwareParent, ...PARTNER_CATEGORIES];
    const desiredChildren = [];   // { parent, name, subType }
    for (const v of vendors) desiredChildren.push({ parent: softwareParent, name: v, subType: SOFTWARE_SUBTYPE });
    for (const cat of PARTNER_CATEGORIES) {
      for (const ini of initials) desiredChildren.push({ parent: cat, name: cat + ' - ' + ini, subType: CATEGORY_SUBTYPE });
    }

    const plan = { parentsExisting: [], parentsToCreate: [], childrenExisting: [], childrenToCreate: [] };
    const parentIds = new Map();   // parent name -> Id (existing or created)

    for (const p of desiredParents) {
      const hit = byFqn.get(p.toLowerCase());
      if (hit) { plan.parentsExisting.push({ name: p, id: hit.Id, active: hit.Active }); parentIds.set(p, hit.Id); }
      else plan.parentsToCreate.push({ name: p });
    }
    for (const c of desiredChildren) {
      const fqn = (c.parent + ':' + c.name).toLowerCase();
      const hit = byFqn.get(fqn);
      if (hit) plan.childrenExisting.push({ name: c.parent + ':' + c.name, id: hit.Id, active: hit.Active });
      else plan.childrenToCreate.push(c);
    }

    if (!apply) {
      return res.status(200).json({
        dryRun: true,
        realmId,
        softwareParent, vendors, initials,
        ...plan,
        note: 'Nothing was written. Re-run with &apply=1 to create the accounts listed in parentsToCreate/childrenToCreate. ' +
              'Creating accounts does not reclassify historical transactions.',
      });
    }

    // 3) APPLY — parents first, then children (need ParentRef ids).
    const created = { parents: [], children: [] };
    const errors = [];
    const createUrl = `${QBO_BASE}/v3/company/${realmId}/account?minorversion=70`;

    for (const p of plan.parentsToCreate) {
      const r = await qboPost(createUrl, accessToken, { Name: p.name, AccountType: 'Expense', AccountSubType: CATEGORY_SUBTYPE });
      const acct = r.ok && r.body && r.body.Account;
      if (acct) { created.parents.push({ name: p.name, id: acct.Id }); parentIds.set(p.name, acct.Id); }
      else errors.push({ name: p.name, status: r.status, detail: r.body && (r.body.Fault || r.body) });
    }

    for (const c of plan.childrenToCreate) {
      const pid = parentIds.get(c.parent);
      if (!pid) { errors.push({ name: c.parent + ':' + c.name, detail: 'parent missing/failed — child skipped' }); continue; }
      const r = await qboPost(createUrl, accessToken, {
        Name: c.name, AccountType: 'Expense', AccountSubType: c.subType,
        SubAccount: true, ParentRef: { value: String(pid) },
      });
      const acct = r.ok && r.body && r.body.Account;
      if (acct) created.children.push({ name: c.parent + ':' + c.name, id: acct.Id });
      else errors.push({ name: c.parent + ':' + c.name, status: r.status, detail: r.body && (r.body.Fault || r.body) });
    }

    return res.status(errors.length && !created.parents.length && !created.children.length ? 502 : 200).json({
      dryRun: false,
      created,
      skippedExisting: { parents: plan.parentsExisting, children: plan.childrenExisting },
      errors,
      note: 'Created accounts appear immediately in QBO chart of accounts and on the P&L once expenses are coded to them. ' +
            'Recategorize historical transactions in QBO to populate history.',
    });

  } catch (err) {
    const status = err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({ error: err.message || 'Unexpected error', code: err.code || null });
  }
};
