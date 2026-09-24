require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const auth = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3004;
const DOCS_HTML = path.join(__dirname, 'public', 'docs.html');

const apiIndex = () => ({
  name: 'CoinDCX Muse Connector',
  powered_by: 'CoinDCX',
  version: '1.3.0',
  region: 'India',
  docs: 'https://coindcx-muse-connector.vercel.app/docs',
  auth_model: 'POST /account/connect → X-COINDCX-CONNECTION token (or raw API key headers)',
  live_orders: String(process.env.ALLOW_LIVE_ORDERS).toLowerCase() === 'true',
  voice_flow: 'POST /orders/quote → confirm → POST /orders/confirm (waits for fill)',
  endpoints: {
    connect: 'POST /account/connect { api_key, api_secret }',
    disconnect: 'POST /account/disconnect',
    price: 'GET /markets/price?coin=BTC',
    movers: 'GET /markets/movers',
    summary: 'GET /markets/summary?coin=BTC&period=1w',
    spread: 'GET /markets/spread?coin=BTC',
    portfolio: 'GET /account/portfolio',
    holding: 'GET /account/holding?coin=BTC',
    pnl: 'GET /account/pnl',
    quote: 'POST /orders/quote',
    confirm: 'POST /orders/confirm { quote_id }',
    buy: 'POST /orders/buy',
    sell: 'POST /orders/sell',
    orderCount: 'GET /orders/count',
    statusMultiple: 'POST /orders/status-multiple { ids }',
    cancelByIds: 'POST /orders/cancel-by-ids { ids }',
    createMultiple: 'POST /orders/create-multiple { orders }',
    walletTransfer: 'POST /wallets/transfer { currency, amount, from, to }',
    subAccountTransfer: 'POST /wallets/sub-account-transfer',
    alerts: 'POST /alerts',
    privacy: 'GET /privacy',
    terms: 'GET /terms',
    health: 'GET /health',
  },
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '200', 10),
  message: { error: 'Too many requests, please slow down.', spoken_summary: 'Too many requests — please wait a moment.' },
}));

function wantsJson(req) {
  if (req.query.format === 'json') return true;
  const accept = String(req.headers.accept || '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

app.get('/', (req, res) => {
  if (wantsJson(req)) return res.json(apiIndex());
  res.sendFile(DOCS_HTML);
});
app.get('/docs', (_req, res) => res.sendFile(DOCS_HTML));
app.get('/api', (_req, res) => res.json(apiIndex()));

app.get('/privacy', (req, res) => res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Privacy Policy — CoinDCX Muse Connector</title></head>
<body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5">
  <h1>Privacy Policy — CoinDCX Muse Connector</h1>
  <p>This connector lets users connect their own CoinDCX account to Meta Muse to check balances and place trades via natural language.</p>
  <h2>Data we process</h2>
  <ul>
    <li><strong>CoinDCX API credentials</strong> — provided by you. We seal them into an encrypted connection token using the connector secret. Prefer sending <code>X-COINDCX-CONNECTION</code> rather than raw secrets on every call.</li>
    <li><strong>Trade requests</strong> — order parameters you (or Muse on your behalf) explicitly confirm.</li>
    <li><strong>Market data</strong> — public prices from CoinDCX.</li>
  </ul>
  <h2>What we do not do</h2>
  <ul>
    <li>We do not custody your crypto or INR.</li>
    <li>We do not sell your personal data.</li>
    <li>We do not share one user’s API keys with another user.</li>
  </ul>
  <h2>Third parties</h2>
  <p>Orders and balances are fetched from <a href="https://coindcx.com">CoinDCX</a>. See their privacy policy on their website.</p>
  <h2>Contact</h2>
  <p>Operator: Ashutosh Dubey — ashutosh.db.mail@gmail.com</p>
  <p>Last updated: 2026-09-24</p>
</body></html>`));

app.get('/terms', (req, res) => res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Terms of Service — CoinDCX Muse Connector</title></head>
<body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5">
  <h1>Terms of Service — CoinDCX Muse Connector</h1>
  <p>By using this connector with Meta Muse you agree that:</p>
  <ol>
    <li>Cryptocurrency trading involves risk of loss. You are solely responsible for all trades on your CoinDCX account.</li>
    <li>This connector does not custody funds. Orders execute on CoinDCX using credentials you provide.</li>
    <li>Muse will ask you to confirm before placing live orders when using the quote → confirm flow.</li>
    <li>You must comply with CoinDCX’s terms and applicable Indian laws (including crypto tax reporting).</li>
    <li>The software is provided “as is” without warranty.</li>
  </ol>
  <p>Contact: ashutosh.db.mail@gmail.com</p>
  <p>Last updated: 2026-09-24</p>
</body></html>`));

app.use('/health', require('./routes/health'));
app.use('/markets', auth, require('./routes/markets'));
app.use('/account', auth, require('./routes/account'));
app.use('/orders', auth, require('./routes/orders'));
app.use('/wallets', auth, require('./routes/wallets'));
app.use('/alerts', auth, require('./routes/alerts'));

app.use((req, res) => res.status(404).json({
  error: 'Not found',
  spoken_summary: 'That action is not available on this connector.',
}));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: 'Internal server error',
    spoken_summary: 'Something went wrong on the connector. Please try again.',
  });
});

module.exports = app;

if (require.main === module || process.env.IS_LOCAL) {
  app.listen(PORT, () => {
    console.log(`\n🇮🇳 CoinDCX Muse Connector v1.2 on http://localhost:${PORT}`);
    console.log(`🔐 Connect: POST /account/connect`);
    console.log(`💱 Quote → Confirm (signed, waits for fill)\n`);
  });
}
