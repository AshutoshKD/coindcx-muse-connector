/**
 * Map CoinDCX / connector errors into Muse-friendly spoken text.
 */
function speakError(err, context = {}) {
  const raw = err?.response?.data || err?.data || err;
  const code = raw?.errorCode || raw?.code || err?.code;
  const message = String(raw?.message || raw?.error || err?.message || 'Something went wrong');
  const minNotional = context.min_notional ?? 100;
  const need = context.estimated_notional_inr;
  const have = context.inr_balance;

  if (code === 'CA1013' || /insufficient wallet balance/i.test(message)) {
    const extra = need && have != null
      ? ` You have about ₹${Number(have).toFixed(2)}, but this order needs about ₹${Number(need).toFixed(2)}.`
      : ` CoinDCX usually needs at least ₹${minNotional} for an order.`;
    return {
      error: raw,
      spoken_summary: `You don't have enough balance to place this order.${extra} Deposit INR in the CoinDCX app, then try again.`,
    };
  }

  if (code === 'OMS-VF-0004' || /quantity should be greater/i.test(message)) {
    return {
      error: raw,
      spoken_summary: `That quantity is too small for this market. ${message}`,
    };
  }

  if (code === 'OMS-VF-0006' || /precision/i.test(message)) {
    return {
      error: raw,
      spoken_summary: `That amount doesn't match this coin's allowed precision. Try a whole number of coins or a larger rupee amount.`,
    };
  }

  if (code === 'OMS-VF-0001' || /outside the permissible range/i.test(message)) {
    return {
      error: raw,
      spoken_summary: `The price is outside CoinDCX's allowed range for this market right now. Try a market order instead.`,
    };
  }

  if (/min_notional|below min/i.test(message)) {
    return {
      error: raw,
      spoken_summary: `Order is too small. CoinDCX needs about ₹${minNotional} minimum for this market.`,
    };
  }

  if (/quote expired|not found/i.test(message)) {
    return {
      error: raw,
      spoken_summary: `That quote expired. Ask me again and I'll get a fresh price.`,
    };
  }

  return {
    error: raw,
    spoken_summary: `I couldn't complete that. ${message}`,
  };
}

function sendSpokenError(res, status, err, context) {
  const payload = speakError(err, context);
  return res.status(status || err?.status || 400).json(payload);
}

module.exports = { speakError, sendSpokenError };
