# sky-tracker web (v2)

Live overhead sky — satellites (Celestrak + SGP4) and aircraft (OpenSky,
routes via adsbdb) rendered as a ceiling-projected dome. One Next.js app:
API route + Three.js client, deployable to Vercel with zero extra services.

Observer is fixed at lat `41.91734343314767`, lon `-87.63808451349306`,
elevation 180 m (Chicago) — see `lib/config.ts`.

## Run locally

```bash
cd web
npm install
npm run dev          # http://localhost:3000
```

Works immediately with **no credentials**: satellites always render; planes
use OpenSky's anonymous API (400 credits/day per IP) and degrade gracefully
to satellites-only with an on-screen message when that runs out.

### OpenSky credentials (recommended: 4000 credits/day)

```bash
cp .env.example .env.local   # then fill in:
# OPENSKY_CLIENT_ID=...
# OPENSKY_CLIENT_SECRET=...
```

Create them free: <https://opensky-network.org> → register → account page →
create an **API client**. Details in `../DECISIONS.md` §1.

## Deploy to Vercel

```bash
npx vercel          # from web/ — or import the repo in the dashboard
```

If importing the repo in the Vercel dashboard, set **Root Directory** to
`web/`. Then add `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` under
Project → Settings → Environment Variables and redeploy. That's the entire
setup — no database, no workers, no websockets.

## Orientation (ceiling mirror)

The dome is drawn for a viewer lying **below** it: North at top, **East on
the left** (star-chart convention), and object motion agrees with the
labels. If you'd rather use your projector's own mirror/flip setting, set
`CEILING_MIRROR = false` in `lib/projection.ts` to get the legacy
looking-down orientation. Verify the math anytime:

```bash
npx tsx scripts/test-projection.ts
```

## Debugging

- `GET /api/sky` — the full JSON snapshot (objects + astro + per-source
  status with human-readable degradation messages).
- In the browser console: `skyTracker.stats()`, `skyTracker.tracked`, and
  `skyTracker.simulate([...])` to inject synthetic objects.
