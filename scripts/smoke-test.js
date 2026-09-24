/**
 * Live smoke test against CoinDCX with credentials from .env
 * Safe order test: places a far-below-market LIMIT buy, then cancels it.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { publicGet, signedPost } = require('../utils/coindcxClient');

const creds = {
  apiKey: process.env.COINDCX_API_KEY,
  apiSecret: process.env.COINDCX_API_SECRET,
};

function section(title) {
  console.log(`\n${'═'.repeat(60)}\n ${title}\n${'═'.repeat(60)}`);
}

async function main() {
  if (!creds.apiKey || !creds.apiSecret) {
    console.error('Missing COINDCX_API_KEY / COINDCX_API_SECRET in .env');
    process.exit(1);
  }

  const results = [];

  // 1) Public ticker
  section('1. Public ticker BTCINR / USDTINR');
  {
    const { data, status } = await publicGet('/exchange/ticker');
    console.log('HTTP', status, 'tickers:', Array.isArray(data) ? data.length : typeof data);
    const btc = Array.isArray(data) ? data.find((t) => t.market === 'BTCINR') : null;
    const usdt = Array.isArray(data) ? data.find((t) => t.market === 'USDTINR') : null;
    console.log('BTCINR:', btc);
    console.log('USDTINR:', usdt);
    results.push({ name: 'ticker', ok: status === 200 && !!btc });
  }

  // 2) Markets list
  section('2. Markets list');
  {
    const { data, status } = await publicGet('/exchange/v1/markets');
    console.log('HTTP', status, 'count:', Array.isArray(data) ? data.length : data);
    results.push({ name: 'markets', ok: status === 200 && Array.isArray(data) });
  }

  // 3) Market details for BTCINR
  section('3. Market details BTCINR');
  let btcDetails = null;
  {
    const { data, status } = await publicGet('/exchange/v1/markets_details');
    btcDetails = Array.isArray(data)
      ? data.find((m) => m.coindcx_name === 'BTCINR' || m.symbol === 'BTCINR')
      : null;
    console.log('HTTP', status);
    console.log(btcDetails ? {
      coindcx_name: btcDetails.coindcx_name,
      pair: btcDetails.pair,
      min_quantity: btcDetails.min_quantity,
      max_quantity: btcDetails.max_quantity,
      base_currency_precision: btcDetails.base_currency_precision,
      target_currency_precision: btcDetails.target_currency_precision,
      min_notional: btcDetails.min_notional,
    } : 'BTCINR details not found');
    results.push({ name: 'markets_details', ok: status === 200 && !!btcDetails });
  }

  // 4) User info (signed)
  section('4. User info (signed auth)');
  {
    const { data, status } = await signedPost('/exchange/v1/users/info', {}, creds);
    console.log('HTTP', status);
    console.log(JSON.stringify(data, null, 2).slice(0, 1500));
    results.push({ name: 'user_info', ok: status === 200 || status === 201 });
  }

  // 5) Balances
  section('5. Balances (non-zero)');
  let inrFree = 0;
  {
    const { data, status } = await signedPost('/exchange/v1/users/balances', {}, creds);
    console.log('HTTP', status);
    if (Array.isArray(data)) {
      const nz = data.filter((b) => parseFloat(b.balance) > 0 || parseFloat(b.locked_balance || 0) > 0);
      console.log(JSON.stringify(nz, null, 2));
      const inr = data.find((b) => b.currency === 'INR' || b.currency_short_name === 'INR');
      inrFree = inr ? parseFloat(inr.balance) : 0;
      console.log('INR free balance:', inrFree);
    } else {
      console.log(data);
    }
    results.push({ name: 'balances', ok: status === 200 || status === 201 });
  }

  // 6) Active orders
  section('6. Active orders');
  {
    const { data, status } = await signedPost('/exchange/v1/orders/active_orders', {}, creds);
    console.log('HTTP', status);
    console.log(JSON.stringify(data, null, 2).slice(0, 1000));
    results.push({ name: 'active_orders', ok: status < 400 });
  }

  // 7) Safe limit order test (far below market, then cancel)
  section('7. Safe limit-order roundtrip (place far below market → cancel)');
  {
    const { data: tickers } = await publicGet('/exchange/ticker');
    const btc = Array.isArray(tickers) ? tickers.find((t) => t.market === 'BTCINR') : null;
    if (!btc) {
      console.log('Skip: BTCINR ticker missing');
      results.push({ name: 'order_roundtrip', ok: false, reason: 'no ticker' });
    } else {
      const last = parseFloat(btc.last_price);
      // Buy at ~1% of market — will not fill; tiny qty near min
      const price = Math.max(1000, Math.floor(last * 0.01));
      const minQty = btcDetails ? parseFloat(btcDetails.min_quantity) : 0.0001;
      const qty = Math.max(minQty, 0.0001);
      const notional = price * qty;
      console.log({ last, price, qty, notional_inr: notional, inrFree });

      if (inrFree < notional) {
        console.log('Skip place: insufficient INR for even far-limit notional lock (need ~', notional, ')');
        results.push({ name: 'order_roundtrip', ok: true, skipped: true, reason: 'insufficient INR' });
      } else {
        const clientId = `muse-test-${Date.now()}`;
        const create = await signedPost('/exchange/v1/orders/create', {
          side: 'buy',
          order_type: 'limit_order',
          market: 'BTCINR',
          price_per_unit: price,
          total_quantity: qty,
          client_order_id: clientId,
        }, creds);
        console.log('CREATE HTTP', create.status);
        console.log(JSON.stringify(create.data, null, 2));

        const orderId = create.data?.orders?.[0]?.id || create.data?.id;
        results.push({ name: 'order_create', ok: create.status < 400 && !!orderId });

        if (orderId) {
          const st = await signedPost('/exchange/v1/orders/status', { id: orderId }, creds);
          console.log('STATUS HTTP', st.status, JSON.stringify(st.data).slice(0, 500));

          const cancel = await signedPost('/exchange/v1/orders/cancel', { id: orderId }, creds);
          console.log('CANCEL HTTP', cancel.status, JSON.stringify(cancel.data).slice(0, 500));
          results.push({ name: 'order_cancel', ok: cancel.status < 400 });
        }
      }
    }
  }

  section('SUMMARY');
  console.table(results);
  const failed = results.filter((r) => r.ok === false);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
