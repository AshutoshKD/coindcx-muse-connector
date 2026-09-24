const router = require('express').Router();
const { resolveCredentials, signedPost } = require('../utils/coindcxClient');
const { normalizeCoin, buildHoldings } = require('../utils/marketHelpers');
const { createConnectionToken, readConnectionToken } = require('../utils/tokens');
const { sendSpokenError } = require('../utils/spokenErrors');

function requireCreds(req, res) {
  const creds = resolveCredentials(req);
  if (!creds) {
    res.status(401).json({
      error: 'CoinDCX account not connected',
      spoken_summary: 'Connect your CoinDCX account first with your API key.',
      message: 'Use POST /account/connect, or pass X-COINDCX-CONNECTION / API key headers.',
    });
    return null;
  }
  return creds;
}

/**
 * POST /account/connect
 * Body: { api_key, api_secret, label? }
 * Returns encrypted connection_token for Muse to store and send as X-COINDCX-CONNECTION.
 * No server-side DB required (serverless-safe).
 */
router.post('/connect', async (req, res) => {
  const api_key = req.body.api_key || req.body.apiKey;
  const api_secret = req.body.api_secret || req.body.apiSecret;
  const label = req.body.label;

  if (!api_key || !api_secret) {
    return res.status(400).json({
      error: 'Required: api_key, api_secret',
      spoken_summary: 'I need your CoinDCX API key and secret to connect. Create them in CoinDCX → Profile → API Dashboard.',
    });
  }

  // Verify keys work before sealing
  try {
    const probe = await signedPost(
      '/exchange/v1/users/info',
      {},
      { apiKey: api_key, apiSecret: api_secret },
    );
    if (probe.status >= 400) {
      return res.status(401).json({
        error: probe.data,
        spoken_summary: 'Those CoinDCX API keys did not work. Double-check the key and secret, and that IP binding is off unless your server IP is allowlisted.',
      });
    }

    const connection_token = createConnectionToken({
      apiKey: api_key,
      apiSecret: api_secret,
      label,
    });

    const opened = readConnectionToken(connection_token);

    res.json({
      success: true,
      connection_token,
      expires_at: opened ? new Date(opened.expires_at).toISOString() : null,
      user: {
        // minimal non-sensitive confirm
        coindcx_id: probe.data?.coindcx_id,
        first_name: probe.data?.first_name,
      },
      how_to_use: 'Send header X-COINDCX-CONNECTION: <connection_token> on later requests. Do not store raw api_secret in Muse chat logs.',
      spoken_summary: `Connected${probe.data?.first_name ? `, ${probe.data.first_name}` : ''}. Your CoinDCX account is ready for Muse.`,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

/** POST /account/disconnect — client simply drops the token; acknowledge for Muse UX */
router.post('/disconnect', (req, res) => {
  res.json({
    success: true,
    spoken_summary: 'Disconnected. Delete the saved connection token on your side. For full revoke, delete the API key in CoinDCX.',
  });
});

router.get('/balances', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  try {
    const { data, status } = await signedPost('/exchange/v1/users/balances', {}, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});

    const nonZero = Array.isArray(data)
      ? data.filter((b) => parseFloat(b.balance) > 0 || parseFloat(b.locked_balance || 0) > 0)
      : data;

    res.json({
      auth_source: creds.source,
      balances: nonZero,
      all_count: Array.isArray(data) ? data.length : undefined,
      spoken_summary: Array.isArray(nonZero)
        ? `You have balances in ${nonZero.length} asset${nonZero.length === 1 ? '' : 's'}.`
        : 'Balances loaded.',
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.get('/portfolio', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  try {
    const { holdings, totalValueInr, totalPnl24h } = await buildHoldings(creds);
    res.json({
      auth_source: creds.source,
      currency: 'INR',
      total_value_inr: totalValueInr,
      estimated_pnl_24h_inr: totalPnl24h,
      holdings_count: holdings.length,
      holdings,
      as_of: new Date().toISOString(),
      spoken_summary: `Your portfolio is about ₹${totalValueInr.toFixed(2)} across ${holdings.length} holdings.`,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.get('/holding', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  const coin = normalizeCoin(req.query.coin);
  if (!coin) {
    return res.status(400).json({
      error: 'Required query: coin',
      spoken_summary: 'Which coin should I check?',
    });
  }

  try {
    const { holdings } = await buildHoldings(creds);
    const hit = holdings.find((h) => String(h.currency).toUpperCase() === coin);
    if (!hit) {
      return res.json({
        coin,
        owned: false,
        spoken_summary: `You don't currently hold any ${coin}.`,
        holding: null,
      });
    }
    res.json({
      coin,
      owned: true,
      holding: hit,
      spoken_summary: `You have ${hit.total} ${coin} worth about ₹${(hit.value_inr || 0).toFixed(2)}.`,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.get('/pnl', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  try {
    const { holdings, totalValueInr, totalPnl24h } = await buildHoldings(creds);
    const past = totalValueInr - totalPnl24h;
    const pct = past > 0 ? (totalPnl24h / past) * 100 : 0;
    const direction = totalPnl24h >= 0 ? 'up' : 'down';

    res.json({
      auth_source: creds.source,
      period: '24h_estimated',
      note: 'Estimated from each holding’s 24h price change — not realized trade P&L.',
      total_value_inr: totalValueInr,
      pnl_inr: totalPnl24h,
      pnl_percent: Number.isFinite(pct) ? pct : 0,
      direction,
      spoken_summary: totalValueInr === 0
        ? 'Your portfolio is empty.'
        : `Your portfolio is about ₹${totalValueInr.toFixed(2)}, roughly ${direction} ₹${Math.abs(totalPnl24h).toFixed(2)} over 24 hours.`,
      by_asset: holdings
        .filter((h) => h.pnl_24h_inr != null)
        .map((h) => ({
          currency: h.currency,
          value_inr: h.value_inr,
          change_24_hour: h.change_24_hour,
          pnl_24h_inr: h.pnl_24h_inr,
        })),
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.get('/info', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  try {
    const { data, status } = await signedPost('/exchange/v1/users/info', {}, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    res.json({
      auth_source: creds.source,
      info: data,
      spoken_summary: `Connected as ${data?.first_name || 'CoinDCX user'}.`,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

module.exports = router;
