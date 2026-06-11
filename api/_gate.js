// ─────────────────────────────────────────────────────────────────────────────
//  _gate.js — shared access gate for all QuickBooks-VM endpoints.
//  (June 2026 hardening pass)
//
//  Changes vs the old inline gate in each endpoint:
//    1. FAIL-CLOSED: if VB_ACCESS_TOKEN is unset, endpoints refuse to serve
//       (503) instead of silently going public. The old `if (expected) {...}`
//       pattern meant a missing/renamed env var disabled auth entirely.
//    2. TIMING-SAFE comparison via crypto.timingSafeEqual.
//    3. ?diag=1 no longer reports expectedLength (it told unauthenticated
//       callers the exact secret length). Token diagnostics (KV var names,
//       client-id fingerprint, realm) only return once the caller passes the
//       gate; pre-auth diag returns gate booleans only.
//
//  NOTE on ?key=: query-string auth is still accepted for backward
//  compatibility (manual probes), but the header (ACCESS_TOKEN or
//  x-access-token) is preferred — query strings land in request logs.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

function safeEqual(a, b) {
  const A = Buffer.from(String(a == null ? '' : a), 'utf8');
  const B = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (A.length !== B.length || A.length === 0) return false;
  return crypto.timingSafeEqual(A, B);
}

function gateKey(req) {
  return req.headers['access_token'] || req.headers['x-access-token'] || (req.query && req.query.key) || '';
}

// Sends the failure response itself; returns true iff the request may proceed.
function enforceGate(req, res) {
  const expected = process.env.VB_ACCESS_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'VB_ACCESS_TOKEN is not configured — refusing to serve (fail-closed).', code: 'GATE_CONFIG' });
    return false;
  }
  if (!safeEqual(gateKey(req), expected)) {
    res.status(401).json({ error: 'Unauthorized', gate: true });
    return false;
  }
  return true;
}

// No-secret gate status for ?diag=1 (safe to return pre-auth).
function gateInfo(req) {
  const expected = process.env.VB_ACCESS_TOKEN;
  const got = gateKey(req);
  return {
    vbAccessTokenConfigured: !!expected,
    keyProvided: !!got,
    keyMatches: !!expected && safeEqual(got, expected),
    keyLengthSeen: got ? String(got).length : 0,
  };
}

module.exports = { safeEqual, gateKey, enforceGate, gateInfo };
