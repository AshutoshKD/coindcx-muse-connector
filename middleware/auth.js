// Muse connector auth — verifies requests come from Muse (or local testing)
module.exports = (req, res, next) => {
  const key = req.headers['x-connector-key'];
  const expected = process.env.CONNECTOR_SECRET_KEY;

  if (!expected) {
    console.warn('⚠️  CONNECTOR_SECRET_KEY not set — skipping Muse auth in dev');
    return next();
  }

  if (!key || key !== expected) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid x-connector-key header',
    });
  }

  next();
};
