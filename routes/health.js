const router = require('express').Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    connector: 'CoinDCX Muse Connector',
    time: new Date().toISOString(),
  });
});

module.exports = router;
