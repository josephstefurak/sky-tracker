# sky-tracker web (v2)

Live overhead sky — satellites (Celestrak + SGP4) and aircraft
(airplanes.live ADS-B, routes via adsbdb) rendered as a ceiling-projected
dome. One Next.js app: API route + Three.js client, deployable to Vercel
with zero extra services.

## Where it looks up from

The observer is per device, resolved once on load:

1. **URL params** `?lat=&lon=` (plus optional `&elev=`, meters above sea level).
   These win over everything and are the manual override for testing.
2. **This device's stored location** from an earlier visit.
3. **`navigator.geolocation`** — the default path for a new user. Needs a secure
   context: production is HTTPS, and `localhost` counts for development.
4. **Chicago** (lat `41.91734343314767`, lon `-87.63808451349306`, elevation
   180 m) when geolocation is denied, unavailable or times out. Quietly — the
   footer just says which source is in use.

The resolved location is persisted in `localStorage`, so it is a one-time setup
per device and a reload never re-prompts. The **◎ LOC** control in the corner
cluster shows the current source and coordinates, accepts typed coordinates and
can re-ask the browser — all without a page reload. Displayed times follow the
resolved location, not the device in the room.

Elevation is assumed to be sea level for a hand-entered location; pass `&elev=`
if the site is high (e.g. `&elev=1600` for Denver). It only matters below a
degree — see `../DECISIONS.md` §13.

Aircraft are always queried within a fixed 25 nm radius of the observer.
Relevant code: `lib/observer.ts` (validation + the fallback), `lib/location.ts`
(resolution order and persistence), `lib/timezone.ts` (which clock).

## Run locally

```bash
cd web
npm install
npm run dev          # http://localhost:3000
```

Works immediately with **no credentials**: satellites always render; planes
come from airplanes.live's free community API and degrade gracefully to
satellites-only with an on-screen message if it's ever unreachable or
rate-limited. Optionally set `PLANES_API_BASE` to swap the ADS-B host
(see `.env.example` and `../DECISIONS.md` §12).

## Deploy to Vercel

```bash
npx vercel          # from web/ — or import the repo in the dashboard
```

If importing the repo in the Vercel dashboard, set **Root Directory** to
`web/`. No environment variables are required. That's the entire setup —
no database, no workers, no websockets.

## Orientation (ceiling mirror)

The dome is drawn for a viewer lying **below** it: North at top, **East on
the left** (star-chart convention), and object motion agrees with the
labels. If you'd rather use your projector's own mirror/flip setting, set
`CEILING_MIRROR = false` in `lib/projection.ts` to get the legacy
looking-down orientation. Verify the math anytime:

```bash
npx tsx scripts/test-projection.ts
```

The per-observer plane cache has its own offline self-test (no network calls —
it stubs `fetch`, so it is safe to run repeatedly):

```bash
npx tsx scripts/test-planes-cache.ts
```

## Debugging

- `GET /api/sky?lat=40.7128&lon=-74.0060` — the full JSON snapshot (objects +
  astro + the observer it was computed for + per-source status with
  human-readable degradation messages). Missing or invalid coordinates fall
  back to the default observer rather than erroring.
- In the browser console: `skyTracker.stats()`, `skyTracker.tracked`,
  `skyTracker.simulate([...])` to inject synthetic objects,
  `skyTracker.location()` for the observer in use, and
  `skyTracker.setLocation(lat, lon)` to move it with no reload.
