// /api/health — quick config + connectivity probe. Does NOT leak secrets;
// only reports whether each required env var is present and whether a token
// can be minted. Useful right after deploy to confirm the env vars took.
const { getAccessToken } = require('./_qbo-token.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const present = {
    QBO_CLIENT_ID: !!process.env.QBO_CLIENT_ID,
    QBO_CLIENT_SECRET: !!process.env.QBO_CLIENT_SECRET,
    QBO_REFRESH_TOKEN: !!process.env.QBO_REFRESH_TOKEN,
    QBO_REALM_ID: process.env.QBO_REALM_ID || '(default 9341454566029927)',
    VB_ACCESS_TOKEN: !!process.env.VB_ACCESS_TOKEN,
  };

  let tokenOk = false, tokenErr = null;
  try { await getAccessToken(); tokenOk = true; }
  catch (e) { tokenErr = e.message; }

  return res.status(tokenOk ? 200 : 503).json({
    service: 'vistamark-quickbooks',
    env: present,
    tokenMint: tokenOk ? 'ok' : 'failed',
    tokenError: tokenErr,
    time: new Date().toISOString(),
  });
};
