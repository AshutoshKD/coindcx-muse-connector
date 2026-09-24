const router = require('express').Router();
const { resolveCredentials, signedPost } = require('../utils/coindcxClient');
const { liveOrdersAllowed } = require('../utils/marketHelpers');
const { sendSpokenError } = require('../utils/spokenErrors');

function requireCreds(req, res) {
  const creds = resolveCredentials(req);
  if (!creds) {
    res.status(401).json({
      error: 'CoinDCX account not connected',
      spoken_summary: 'Connect your CoinDCX account first.',
    });
    return null;
  }
  return creds;
}

/**
 * POST /wallets/transfer
 * Move funds between spot ↔ futures wallets on the same account.
 * Body: { currency, amount, from?: "spot"|"futures", to?: "spot"|"futures" }
 *   or  { currency_short_name, amount, source_wallet_type, destination_wallet_type }
 * Voice: "Move 10 USDT to my futures wallet"
 */
router.post('/transfer', async (req, res) => {
  if (!liveOrdersAllowed()) {
    return res.status(403).json({
      error: 'Live transfers disabled',
      spoken_summary: 'Live wallet moves are turned off on this connector.',
    });
  }
  const creds = requireCreds(req, res);
  if (!creds) return;

  const currency = String(
    req.body.currency || req.body.currency_short_name || '',
  ).toUpperCase();
  const amount = Number(req.body.amount);
  const from = String(
    req.body.from || req.body.source_wallet_type || 'spot',
  ).toLowerCase();
  const to = String(
    req.body.to || req.body.destination_wallet_type || 'futures',
  ).toLowerCase();

  if (!currency || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'Required: currency, amount (>0). Optional: from/to (spot|futures)',
      spoken_summary: 'Tell me the currency and amount to move, and spot or futures.',
    });
  }
  if (!['spot', 'futures'].includes(from) || !['spot', 'futures'].includes(to)) {
    return res.status(400).json({
      error: 'from/to must be spot or futures',
      spoken_summary: 'I can only move between spot and futures wallets.',
    });
  }
  if (from === to) {
    return res.status(400).json({
      error: 'from and to must differ',
      spoken_summary: 'Source and destination wallets must be different.',
    });
  }

  try {
    const { data, status } = await signedPost('/exchange/v1/wallets/transfer', {
      source_wallet_type: from,
      destination_wallet_type: to,
      currency_short_name: currency,
      amount,
    }, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    res.json({
      success: true,
      result: data,
      spoken_summary: `Moved ${amount} ${currency} from ${from} to ${to}.`,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

/**
 * POST /wallets/sub-account-transfer
 * Body: { from_account_id, to_account_id, currency, amount }
 * Voice: "Transfer 5 USDT to my sub-account"
 */
router.post('/sub-account-transfer', async (req, res) => {
  if (!liveOrdersAllowed()) {
    return res.status(403).json({
      error: 'Live transfers disabled',
      spoken_summary: 'Live wallet moves are turned off on this connector.',
    });
  }
  const creds = requireCreds(req, res);
  if (!creds) return;

  const from_account_id = req.body.from_account_id;
  const to_account_id = req.body.to_account_id;
  const currency = String(req.body.currency || req.body.currency_short_name || '').toUpperCase();
  const amount = Number(req.body.amount);

  if (!from_account_id || !to_account_id || !currency || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'Required: from_account_id, to_account_id, currency, amount',
      spoken_summary: 'I need both account ids, the currency, and the amount.',
    });
  }

  try {
    const { data, status } = await signedPost('/exchange/v1/wallets/sub_account_transfer', {
      from_account_id,
      to_account_id,
      currency_short_name: currency,
      amount,
    }, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    res.json({
      success: true,
      result: data,
      spoken_summary: `Transferred ${amount} ${currency} between sub-accounts.`,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

module.exports = router;
