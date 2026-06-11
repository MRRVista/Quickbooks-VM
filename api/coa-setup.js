// ─────────────────────────────────────────────────────────────────────────────
//  /api/coa-setup — chart-of-accounts setup. DRY-RUN BY DEFAULT.
//
//  v2: matches the firm's EXISTING account naming (per the live P&L) instead
//  of inventing a parallel initials-based tree:
//    • Client/Prospect Entertainment → "Ent - <Advisor>"
//    • Client/Prospect Meals         → "Meals - <Advisor>"
//    • Client/Prospect Travel        → "Travel - <Advisor>"
//    • COI Meals                     → "COI Meals - <Advisor>"   (?coiParents= to extend,
//        e.g. &coiParents=COI Meals,COI Travel,COI Entertainment)
//    • Software & Technology         → one sub per vendor (?vendors= to override)
//  Advisors default: Matthew Rice, Sean McEvilly, Ryan Walter, William Seyfarth
//  (?advisors=A,B,C to override — e.g. add Dave Beazley).
//
//  Idempotent by FullyQualifiedName (case-insensitive): existing accounts are
//  skipped, never edited, never deleted. Per the current P&L, the gaps this
//  will fill are: Ent - Matthew Rice, Ent - Ryan Walter, Travel - Ryan Walter,
//  the four COI Meals subs, and the software tree.
//
//  SAFETY: GET only, behind the shared fail-closed gate (_gate.js). Default is
//  DRY-RUN (full plan, zero writes); add &apply=1 to create. Creating accounts
//  does NOT reclassify history — batch-reclassify in QBO to move old expenses.
//
//  SUBTYPES on new accounts (existing accounts untouched; confirm deductibility
//  treatment with your accountant — one-click change in the QBO UI):
//    Ent → Entertainment · Meals/COI Meals → TravelMeals · Travel → Travel ·
//    software → DuesSubscriptions · other parents → OtherBusinessExpenses
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
const DEFAULT_ADVISORS = ['Matthew Rice', 'Sean McEvilly', 'Ryan Walter', 'William Seyfarth'];

// Client/Prospect categories — sub naming mirrors the existing books:
// "<prefix> - <Advisor Full Name>" under each parent.
const CLIENT_PROSPECT = [
  { parent: 'Client/Prospect Entertainment', prefix: 'Ent',    subType: 'Entertainment' },
  { parent: 'Client/Prospect Meals',         prefix: 'Meals',  subType: 'TravelMeals' },
  { parent: 'Client/Prospect Travel',        prefix: 'Travel', subType: 'Travel' },
];
const DEFAULT_COI_PARENTS = ['COI Meals'];   // subs: "<parent> - <Advisor>"

const SOFTWARE_SUBTYPE = 'DuesSubscriptions';
const GENERIC_SUBTYPE  = 'OtherBusinessExpenses';

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

// Comma-separated override param with sane caps; ':' stripped (QBO reserves it
// for hierarchy paths).
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
  const vendors    = parseListParam(q.vendors,    DEFAULT_VENDORS, 30);
  const advisors   = parseListParam(q.advisors,   DEFAULT_ADVISORS, 10);
  const coiParents = parseListParam(q.coiParents, DEFAULT_COI_PARENTS, 5);

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

    // 2) Desired tree — mirrors the books' existing naming.
    //    parents: [{ name, subType }], children: [{ parent, name, subType }]
    const desiredParents = [{ name: softwareParent, subType: GENERIC_SUBTYPE }];
    const desiredChildren = [];
    for (const v of vendors) desiredChildren.push({ parent: softwareParent, name: v, subType: SOFTWARE_SUBTYPE });
    for (const cat of CLIENT_PROSPECT) {
      desiredParents.push({ name: cat.parent, subType: cat.subType });
      for (const adv of advisors) desiredChildren.push({ parent: cat.parent, name: cat.prefix + ' - ' + adv, subType: cat.subType });
    }
    for (const cp of coiParents) {
      desiredParents.push({ name: cp, subType: /meal/i.test(cp) ? 'TravelMeals' : /travel/i.test(cp) ? 'Travel' : /ent/i.test(cp) ? 'Entertainment' : GENERIC_SUBTYPE });
      for (const adv of advisors) desiredChildren.push({ parent: cp, name: cp + ' - ' + adv, subType: /meal/i.test(cp) ? 'TravelMeals' : /travel/i.test(cp) ? 'Travel' : /ent/i.test(cp) ? 'Entertainment' : GENERIC_SUBTYPE });
    }

    const plan = { parentsExisting: [], parentsToCreate: [], childrenExisting: [], childrenToCreate: [] };
    const parentIds = new Map();

    for (const p of desiredParents) {
      const hit = byFqn.get(p.name.toLowerCase());
      if (hit) { plan.parentsExisting.push({ name: p.name, id: hit.Id, active: hit.Active }); parentIds.set(p.name, hit.Id); }
      else plan.parentsToCreate.push(p);
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
        softwareParent, vendors, advisors, coiParents,
        ...plan,
        note: 'Nothing was written. Re-run with &apply=1 to create the accounts in parentsToCreate/childrenToCreate. ' +
              'Existing accounts are never modified. Creating accounts does not reclassify historical transactions.',
      });
    }

    // 3) APPLY — parents first, then children (ParentRef ids).
    const created = { parents: [], children: [] };
    const errors = [];
    const createUrl = `${QBO_BASE}/v3/company/${realmId}/account?minorversion=70`;

    for (const p of plan.parentsToCreate) {
      const r = await qboPost(createUrl, accessToken, { Name: p.name, AccountType: 'Expense', AccountSubType: p.subType });
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
      note: 'New accounts appear immediately in the QBO chart of accounts and on the P&L once expenses are coded to them. ' +
            'Batch-reclassify historical transactions in QBO to populate history.',
    });

  } catch (err) {
    const status = err.status || (err.code === 'CONFIG' ? 500 : err.code === 'AUTH' ? 401 : 502);
    return res.status(status).json({ error: err.message || 'Unexpected error', code: err.code || null });
  }
};
