# CoinDCX for Muse

Private source for the CoinDCX India Pure API connector used with Meta Muse.

**Live app / docs:** https://coindcx-muse-connector.vercel.app/docs  
**Health:** https://coindcx-muse-connector.vercel.app/health

Unofficial third-party connector — not affiliated with CoinDCX or Meta.

## Setup

```bash
npm install
cp .env.example .env   # set CONNECTOR_SECRET_KEY
npm run dev            # http://localhost:3004
```

## Deploy

Pushes to `main` deploy via Vercel (Git integration). Env vars live in the Vercel project — never commit secrets.

## Muse form

See `MUSE_SUBMISSION.md` for copy-paste submission fields.
