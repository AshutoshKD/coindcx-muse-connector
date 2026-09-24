# Muse connector submission pack — CoinDCX

Fill these on [muse.ai/platform](https://muse.ai/platform) → Submit a connector.

## Overview (copy-paste)

| Field | Exact value |
|---|---|
| **Connector name** | `CoinDCX for Muse` |
| **Company or developer** | `Ashutosh Dubey` |
| **Product website** | `https://coindcx-muse-connector.vercel.app` |
| **Example prompts** | Paste the block under “Example prompts” below |
| **Connector icon** | Upload `assets/connector-icon.png` (512×512) — original orange crypto-C mark (not the official CoinDCX logo). SVG twin: `assets/connector-icon.svg` |
| **Payments** | **My connector does not accept payments** |
| **Your name** | `Ashutosh Dubey` |
| **Work email** | `ashutosh.db.mail@gmail.com` (prefer a Workspace/domain email if Meta rejects personal Gmail) |
| **Support email or URL** | `ashutosh.db.mail@gmail.com` |
| **Your privacy policy** | `https://coindcx-muse-connector.vercel.app/privacy` |
| **Your terms of service** | `https://coindcx-muse-connector.vercel.app/terms` |
| **Anything else? (optional)** | Paste the “Anything else?” block below |

## Example prompts

```
Analyze my CoinDCX portfolio
Where can I improve my portfolio?
Am I too concentrated in one coin?
Which of my holdings are dust / not worth keeping?
What's my CoinDCX portfolio worth?
What's Bitcoin's price in rupees?
Show the top 10 best performing coins today
How did BTC do this week?
Is ETH liquid right now?
Buy 200 rupees of USDT on CoinDCX
Sell all my DOGE
Do I have any open orders?
Am I up or down today?
Alert me if BTC goes above 90 lakh
Move 10 USDT to my futures wallet
```

## Anything else?

```
CoinDCX India spot trading connector for Muse.

Base URL: https://coindcx-muse-connector.vercel.app
Health: GET /health
Auth: Users connect their own CoinDCX API key via POST /account/connect (returns encrypted connection_token). Per-user credentials — never shared.
Trading safety: quote → confirm flow; fees spoken before confirm; waits for fill.
Markets: INR pairs preferred; portfolio, movers, candle summaries, spread, alerts, wallet transfer.
Does not accept card payments. Users trade on their own CoinDCX balance.
Unofficial third-party connector — not affiliated with or endorsed by CoinDCX.
Contact: ashutosh.db.mail@gmail.com
```

## Auth model for Muse

1. User creates API key in CoinDCX → Profile → API Dashboard (do **not** bind IP unless you allowlist server IPs).
2. Muse calls `POST /account/connect` with `{ api_key, api_secret }` + header `x-connector-key`.
3. Connector returns `connection_token` (encrypted). Muse stores it.
4. Later calls send `X-COINDCX-CONNECTION: <token>` + `x-connector-key`.

## Trade safety

- `POST /orders/quote` → spoken fee + total → user confirms → `POST /orders/confirm`
- Confirm waits for fill (up to ~12s) before answering

## Required env on Vercel

```
CONNECTOR_SECRET_KEY=<long random hex>
ALLOW_LIVE_ORDERS=true
COINDCX_TAKER_FEE_PERCENT=0.59
```

## Health check

`GET /health` → `{ status: "ok" }`

## Technical specs (form step 2 — copy-paste)

| Field | Exact value |
|---|---|
| **Connection type** | **Pure API** |
| **API URL** | `https://coindcx-muse-connector.vercel.app` |
| **OpenAPI specification (optional)** | Leave blank (no OpenAPI file hosted) |
| **API or MCP documentation** | `https://coindcx-muse-connector.vercel.app/docs` |
| **Authentication methods** | Check **API keys** only (not OAuth with PKCE) |

### Access requirements (paste entire block)

```
REGION & ACCOUNT
- Upstream exchange: CoinDCX (India). Requires a KYC-verified CoinDCX account that can create API keys.
- Connector is unofficial / third-party — not affiliated with or endorsed by CoinDCX.
- Base URL (production): https://coindcx-muse-connector.vercel.app
- Health check: GET /health → { "status": "ok" }
- Product / endpoint index: GET / (JSON lists all voice-ready routes)
- Privacy: https://coindcx-muse-connector.vercel.app/privacy
- Terms: https://coindcx-muse-connector.vercel.app/terms

HOW REVIEWERS GET CREDENTIALS
1. Create a CoinDCX account and complete KYC (CoinDCX app/web — India).
2. CoinDCX → Profile → API Dashboard → Create API key + secret.
   - Enable trading / balance permissions needed for portfolio + spot orders.
   - Do NOT bind IP to a single client IP unless you also allowlist the connector host IPs; IP binding commonly causes “unauthorized” failures.
3. Connector gate (server): every Muse call must include header x-connector-key (shared connector secret configured on the Vercel deployment). Ask operator Ashutosh Dubey (ashutosh.db.mail@gmail.com) for a review key.
4. Per-user connect: POST /account/connect with JSON { "api_key": "...", "api_secret": "..." } + x-connector-key.
   - Response includes connection_token (encrypted). Muse should store this token.
5. Later calls: send X-COINDCX-CONNECTION: <connection_token> + x-connector-key.
   - Alternate (debug only): X-COINDCX-API-KEY + X-COINDCX-API-SECRET instead of the connection token.
6. Disconnect UX: POST /account/disconnect (client drops token). Full revoke = delete the API key in CoinDCX.

AUTH MODEL SUMMARY
- Method: API keys (not OAuth / PKCE — CoinDCX has no OAuth for trading APIs).
- Two layers: (A) connector key for Muse↔connector, (B) each user’s own CoinDCX API key sealed into a connection_token.
- Keys are never shared across users. Connector does not custody INR or crypto.

CAPABILITIES (VOICE-ORIENTED)
- Markets: GET /markets/price, /movers, /summary, /spread
- Account: GET /account/portfolio, /holding, /pnl, /balances
- Trading safety: POST /orders/quote → user confirms → POST /orders/confirm (waits for fill, speaks fees)
- Also: buy/sell, order count/status/cancel, multi-create, wallet transfer, alerts
- Live orders require ALLOW_LIVE_ORDERS=true on the deployment (currently enabled for production demos).

RATE / USAGE
- Connector rate limit: ~200 requests / 15 minutes per IP (express-rate-limit).
- Upstream CoinDCX also enforces its own API rate limits; burst trading may be throttled by CoinDCX.
- Amounts are INR-native (amount_inr), not USD.

PAYMENTS
- Connector does not accept card/payment processing. Users trade with their existing CoinDCX wallet balance only.

SUPPORT FOR REVIEWERS
- Email: ashutosh.db.mail@gmail.com
- Ask for: x-connector-key for Meta review, plus a short smoke-test checklist (health → connect → portfolio → quote).
```
