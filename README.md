# vistamark-quickbooks (repo: Quickbooks-VM)

Read-only proxy that serves **live YTD W-2 gross payroll** from QuickBooks to
**VistaBalancer** (`vistabalancer.app`). Same architecture as
`vistamark-wealthbox`: a tiny Vercel serverless function holds the API secrets
server-side and exposes a CORS-enabled endpoint the browser app can `fetch()`.

This exists because the browser **cannot** call QuickBooks/Intuit directly —
Intuit requires server-side OAuth and sends no CORS headers for our domain.
This proxy is the bridge.

---

## Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/w2-ytd` | GET | YTD W-2 gross by individual + firm total. Requires `ACCESS_TOKEN` header. |
| `/api/health` | GET | Reports which env vars are set and whether a token can be minted. No secrets leaked. |

### `/api/w2-ytd` response shape
```json
{
  "asOfPayDate": "2026-06-01",
  "payPeriod": { "begin": "2026-06-01", "end": "2026-06-15" },
  "paySchedule": "Twice a month",
  "source": "QuickBooks Payroll (live)",
  "pulledAt": "2026-06-07T18:00:00.000Z",
  "employees": [
    { "name": "Matthew Rice", "ytdGross": 144195.00 },
    { "name": "Sean McEvilly", "ytdGross": 111007.00 },
    { "name": "Ryan Walter", "ytdGross": 62500.00 },
    { "name": "William Seyfarth", "ytdGross": 21897.00 }
  ],
  "firmTotal": 339599.00
}
```
Intentionally identical to VistaBalancer's baked `_VB_W2_PAID_SEED` so the tab
consumes it with zero transform.

---

## One-time setup

### 1. Connect to Vercel
- Vercel dashboard → **Add New → Project** → import `MRRVista/Quickbooks-VM`.
- Framework preset: **Other**. No build command needed (plain serverless funcs).

### 2. Set Environment Variables (Vercel → Project → Settings → Environment Variables)

From **Randall's QuickBooks app** on the Intuit Developer dashboard
(developer.intuit.com → My Apps → the app → **Keys & OAuth → Production**):

| Var | Where to get it |
|---|---|
| `QBO_CLIENT_ID` | Production **Client ID** |
| `QBO_CLIENT_SECRET` | Production **Client Secret** |
| `QBO_REFRESH_TOKEN` | A production **refresh token** for realm `9341454566029927` (OAuth Playground or your stored token) |
| `QBO_REALM_ID` | `9341454566029927` |
| `VB_ACCESS_TOKEN` | Any long random string — VistaBalancer sends it in the `ACCESS_TOKEN` header. Set it here AND in the VistaBalancer fetch. |

Set all five for **Production**. Redeploy after saving.

### 3. Verify
- Visit `https://quickbooks-vm.vercel.app/api/health` — should report all env vars `true` and `tokenMint: "ok"`.
- Then `curl -H "ACCESS_TOKEN: <your VB_ACCESS_TOKEN>" https://quickbooks-vm.vercel.app/api/w2-ytd` should return the YTD JSON.

### 4. VistaBalancer wiring
The W-2 Paid (YTD) tab fetches this on load (read-only). The fetch URL and the
`ACCESS_TOKEN` value are set in `VistaBalancer.html`.

---

## Token rotation
If `/api/health` shows `tokenMint: "failed"` with an auth error, re-mint a
refresh token (OAuth Playground, production, payroll scope) and update
`QBO_REFRESH_TOKEN` in Vercel.

## Security
- QuickBooks OAuth secrets never reach the browser — only this server reads them.
- `/api/w2-ytd` is gated by the `ACCESS_TOKEN` shared secret and CORS-locked to `vistabalancer.app`.
- Read-only: this proxy never writes to QuickBooks.
