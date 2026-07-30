# DECISIONS

Design record for the v2 rebuild in `web/` (Next.js, single Vercel deployable).
`backend/` (FastAPI + WebSocket) and `frontend/` (Three.js via CDN) are left
untouched as the working v1 reference.

---

## 1. Stage 0 — What was actually wrong with OpenSky

**Symptom:** the deployed backend logged `OpenSky fetch failed:` with an empty
error.

**Diagnosis (evidence, 2026-07-03):**

- The empty message is a logging artifact: `data_fetcher.py` logs
  `"OpenSky fetch failed: %s" % exc`, and httpx's timeout-class exceptions
  (`ReadTimeout`, `ConnectTimeout`) stringify to an **empty string**. So the
  deployment was almost certainly timing out / being throttled, and the log
  line hid that. v2 always logs `${error.name}: ${error.message}` plus the
  HTTP status — an empty error line can no longer happen.
- Anonymous access is **not** dead: a test from a residential IP returned
  `HTTP 200` with header `x-rate-limit-remaining: 397` — anonymous callers now
  get a **400 request-credit/day budget per IP**. Cloud egress IPs (Cloud Run,
  Vercel) are shared and heavily throttled or blocked, which is why the
  deployed instance failed while local testing worked.
- OpenSky's 2025 API migration is real: Basic auth was retired in favor of
  **OAuth2 client credentials** (token endpoint
  `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`,
  verified live — returns 401 for bad credentials). Registered API clients get
  4000 credits/day.

**Handling in v2 (`web/lib/opensky.ts`):** three explicit modes, never a
hard failure, satellites always render:

1. **oauth2** — `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` set: token is
   fetched via client-credentials, cached until ~60 s before expiry, and used
   as a Bearer header. If the credentials are *rejected*, planes are disabled
   with a status message saying exactly that — we deliberately do **not**
   fall back to anonymous, because that would mask a config error.
2. **anonymous** — no credentials: we still try the anonymous API. This
   deviates from the build brief ("skip plane fetch if credentials absent")
   because testing proved anonymous access still works at 400 credits/day;
   planes-by-default is the better product, and the degradation path below
   covers the blocked-IP case. Set `OPENSKY_ANONYMOUS=0` to force a clean
   skip instead.
3. **disabled** — anonymous forbidden or credentials rejected: plane fetch is
   skipped entirely with one clear log line and a human-readable
   `status.planes.message` that the UI shows.

On 429 the server backs off (Retry-After or 5 min), serves a snapshot that is
at most 45 s stale, then degrades to an empty plane list with an explanatory
message. `x-rate-limit-remaining` is passed through to the client status.

The exact status messages (also shown in the on-dome footer):

- anonymous: `no OpenSky credentials — anonymous access (400 credits/day); set OPENSKY_CLIENT_ID/SECRET for 4000/day`
- rejected credentials: `OpenSky credentials rejected (HTTP <s>) — check OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET`
- anonymous forbidden: `plane feed disabled (no OpenSky credentials and OPENSKY_ANONYMOUS=0) — satellites only`
- rate-limited: `OpenSky rate limit exhausted — planes paused until HH:MM`
- blocked IP: `OpenSky anonymous access blocked (HTTP 401/403) — set OPENSKY_CLIENT_ID/SECRET`
- log line: `[sky] OpenSky fetch failed: <ErrorName>: <message> (status <n>)` — never empty again.

Whenever planes are unavailable *for any reason*, `status.planes.ok` is
false and `message` says why — the client needs exactly one rule to surface
degradation.

**Getting credentials:** register (free) at <https://opensky-network.org> →
log in → account page (<https://opensky-network.org/my-opensky>) → create an
**API client** → copy `client_id` / `client_secret` into `web/.env.local`
(copy `web/.env.example`) or, on Vercel, Project → Settings → Environment
Variables. Credit math at our poll rate: the server coalesces all viewers
into ≤1 upstream call per ~10 s (see §6), i.e. ~360 credits/hour of active
viewing — an evening of display fits the 4000/day registered budget easily;
24/7 operation does not, and will simply pause planes until the daily reset
rather than erroring.

## 2. Stage 2 — FastAPI + WebSocket → Next.js + client polling

- Vercel functions are stateless and short-lived: the v1 design (three
  asyncio background loops + long-lived WebSocket broadcast) cannot run
  there. v2 computes everything **per request** in a route handler
  (`GET /api/sky`) and the client polls every 10 s.
- Smoothness is unchanged because v1 already solved it client-side: the
  dead-reckoning layer (velocity from consecutive az/alt anchors,
  extrapolated every frame) was ported as-is; it was designed for 10 s
  OpenSky updates in the first place.
- Server work per request stays trivial: ~160 SGP4 propagations (a few ms),
  a cached OpenSky snapshot, cached route lookups, and closed-form sun/moon
  math.

## 3. Stage 2 — Skyfield (Python) → satellite.js (TypeScript)

Chosen so the whole app is **one** Vercel deployable with no Python runtime.
`satellite.js@7` implements the same SGP4 as Skyfield. Az/alt parity was
verified against the v1 Skyfield stack (same TLEs, same instant); agreement
is within the tolerance expected from satellite.js's TEME→topocentric
shortcut (fractions of a degree — invisible at dome scale). Sun/moon math
was likewise validated against a Skyfield DE421 ephemeris oracle. Parity
numbers: see §10.

## 4. Stage 1 — The ceiling mirror

The v1 dome mapped azimuth like a *map* (N top, E right) — correct when
looking **down**, mirrored when projected on a ceiling and viewed from
**below**. For a below-viewer with North kept at top, the compass chirality
flips: **East must sit on the LEFT, West on the RIGHT** (the planisphere /
star-chart convention).

- Implemented in one pure module, `web/lib/projection.ts`:
  `x = sx · r · sin(az)`, `y = r · cos(az)` with `sx = -1` when
  `CEILING_MIRROR = true` — a coordinate mirror, **not** a canvas/scene
  negative-scale flip, so text sprites stay unmirrored.
- Headings flip sign under a mirror: the chevron rotation is
  `+heading` (radians) when mirrored vs legacy `-heading`
  (`headingToRotationZ()`); an eastbound plane therefore both *points at* and
  *moves toward* the E label. Labels and motion agree because every azimuthal
  placement (objects, trails, cardinals, ring labels, sun, moon, moon-phase
  limb angle) flows through the same two functions.
- `CEILING_MIRROR` is a single exported constant — set it to `false` if you
  choose to use the projector's own hardware mirror instead.
- Verified by `web/scripts/test-projection.ts` (run `npx tsx` on it):
  cardinal positions, eastbound-motion direction, chevron/label agreement,
  and legacy-mode byte-compatibility.

## 5. TLE sourcing & caching

- Groups: Celestrak `visual` (the curated bright set v1 used, ~150 sats —
  a deliberately small, *meaningful* population for an ambient display)
  **plus `stations`** (guarantees ISS/CSS presence and lets us tag them as
  stations). Deduped by NORAD id.
- Fetched with Next's data cache (`revalidate: 21600` = 6 h, matching v1) so
  TLEs survive serverless cold starts on Vercel without any extra service;
  a module-level parse cache avoids re-parsing per request.
- Launch year is decoded from the TLE international designator (free
  metadata, no extra source), category from group membership + name
  heuristics (`R/B` rocket body, `DEB` debris).

## 6. OpenSky polling economics

- The server keeps a module-level snapshot cache with a 9.5 s TTL: any
  number of concurrent viewers costs ≤1 upstream credit per ~10 s.
- Bounding box widened from v1's ±~45 km to ~±80 km/±0.72° lat so aircraft
  are acquired near the horizon (~7° elevation at cruise) instead of popping
  in mid-dome — the area (~2.8 deg²) stays inside OpenSky's cheapest
  1-credit-per-call tier.
- `extended=1` is requested to get the free ADS-B **aircraft category**
  field (light/small/large/heavy/rotorcraft), used for marker encoding.
- The observer→plane elevation math is ported verbatim from v1
  (`position_engine.py`: great-circle bearing + haversine + atan2) for
  behavioral parity. One deliberate improvement: flight altitude falls back
  geometric → barometric (v1 required geometric), retaining a few more
  aircraft.
- Satellite TLE freshness is reported as **TLE-epoch age**, not fetch age —
  the only honest metric on a stateless serverless host.

## 7. adsbdb enrichment (routes + aircraft), server-side

- Moved server-side into the API route. Serverless has no fire-and-forget
  background tasks, so each `/api/sky` request performs **at most 4** small,
  time-boxed (4 s) uncached lookups inline, highest-elevation aircraft
  first; the cache warms over successive polls. adsbdb is never hammered.
- Two free endpoints: `/v0/callsign/{cs}` (route: origin/destination IATA +
  municipality + **airline name**) and `/v0/aircraft/{icao24}` (type,
  manufacturer, registered owner, **photo thumbnail**) — the second is new
  in v2 and feeds the spotlight card.
- In-memory cache: positive entries permanent (a route doesn't change
  mid-flight), negative entries 2 h, transient errors uncached (retry next
  poll) — v1's proven policy. **Cold-start cache loss is accepted**: the
  cost is a handful of duplicate lookups on the first polls after a cold
  start, which adsbdb tolerates and the 4-per-request bound caps.

## 8. New free data/compute sources (Stage 3)

| Addition | Source | Rationale |
| --- | --- | --- |
| Sun & moon positions, twilight state | closed-form astronomy (Meeus/NOAA solar, Schlyter lunar) — no API | the dome tints with real twilight and shows the sun/moon where they actually are |
| Satellite sunlit / "visible now" flag | cylindrical Earth-shadow test on SGP4 state — no API | encodes the *actual* naked-eye visibility physics (sunlit sat + dark sky); visible passes glow, eclipsed sats ghost |
| Moon phase rendering | illuminated fraction + waxing side from sun–moon elongation | phase-correct moon, bright limb oriented toward the sun on the dome |
| Aircraft category | OpenSky `extended=1` (free) | helicopters get a distinct marker; heavies render larger |
| Aircraft type / operator / photo | adsbdb `/v0/aircraft` (free) | spotlight card: "what exactly is that?" is the whole point of the display |
| Airline + city names | adsbdb `/v0/callsign` (already fetched in v1, now fully used) | "UAL304 · United Airlines · EWR Newark → PBI West Palm Beach" |
| Launch year / category per satellite | TLE designator + Celestrak group | one glance tells you if that dot is a 1998 station or a 60s rocket body |

## 9. Client visual language (preserved + added)

Preserved from v1: black dome, horizon + dashed 30°/60° altitude rings,
cardinal letters, glowing additive dots (sat blue-white 8 px, ISS gold
12 px), amber heading-rotated plane chevrons, fade-to-black trails, label
de-confliction by priority (ISS > plane > sat), "ORD → LAX" route lines,
altitude-based sizing and opacity, 30 s missing → 2 s fade-out lifecycle,
dead reckoning between updates.

Added (each kept dim/ambient; legibility from across a room first):

- Twilight dome tint + warm horizon glow at the sun's azimuth around
  sunrise/sunset.
- Sun marker (daytime) and phase-correct moon marker.
- Visible-pass emphasis: sunlit satellites in a dark sky pulse gently;
  shadowed satellites ghost to 55% opacity.
- Helicopter (ring) and weight-class (scale) plane markers; ↑/↓ climb and
  descent arrows on callsign labels.
- Spotlight card (bottom-right) rotating every 12 s across the most
  interesting object: airline/type/route/photo for planes; category, launch
  year, range, and visibility state for satellites.
- Status footer (bottom-left): counts, twilight state, clock, a
  data-staleness dot (green/amber/red), and the plane-feed degradation
  message when OpenSky is limited — the display explains itself.

## 10. Verification record (2026-07-03)

- **Satellite az/alt parity** (satellite.js vs Skyfield, identical TLEs +
  instants; 8 sats above the horizon, day and night cases):
  |Δaz|·cos(alt) ≤ 0.0045°, |Δalt| ≤ 0.0051°, range Δ ≤ 0.5 km
  (tolerance was 0.3° — passed with ~60× margin). Sunlit flag agreed with
  Skyfield's `is_sunlit(de421)` for **8/8** satellites.
- **Sun/moon parity** vs Skyfield DE421 at 4 instants across 18 h:
  sun ≤ 0.007°, moon ≤ 0.013°, illuminated-fraction Δ ≤ 0.0008
  (0.875 waning gibbous — matched).
- **Ceiling-mirror test suite**: `npx tsx web/scripts/test-projection.ts` —
  cardinal placement (N top / E left / W right when mirrored), eastbound
  motion toward −x, chevron-heading agreement, and legacy-mode
  compatibility all assert green.
- **End-to-end** (anonymous mode, midday): 168 TLEs (visual ∪ stations),
  3 satellites above 5°, 41–42 planes in the bbox, live enrichment on the
  first response (e.g. `SKW4703 · SkyWest Airlines · Embraer EMB-175 LR ·
  CHA Chattanooga → ORD Chicago`), astro correct for Chicago noon
  (sun az 158.8°, alt 69.9°, "day"). Credential-rejected and
  anonymous-disabled modes produce the §1 messages with satellites
  unaffected.

## 11. Known tradeoffs

- **Cold starts** lose the OpenSky snapshot, token, and adsbdb caches
  (rebuilt within 1–2 polls; TLEs survive via the Next data cache).
- **OpenSky credits are finite**: 24/7 anonymous operation will exhaust
  400/day in ~an hour of continuous viewing; registered credentials give a
  full evening comfortably. When exhausted, planes pause with an on-screen
  message; satellites are unaffected.
- satellite.js look angles use TEME directly (no full frame conversion):
  sub-degree error, invisible at dome scale.
- Schlyter lunar series is accurate to ~1° — fine for a 24 px moon marker.
- Aircraft elevation uses v1's flat-earth atan2 model (≤ ~0.5° error inside
  the widened bbox) — kept for parity.

## 12. OpenSky → airplanes.live (2026-07-03)

Everything in §1/§6 about OpenSky auth modes and credit economics is now
**historical**: OpenSky was dropped entirely the same day.

**Why:** OpenSky hard-blocks Vercel's datacenter IP ranges per-IP at the TCP
connect stage. The `/api/debug/opensky` probe showed both
`auth.opensky-network.org` and `opensky-network.org` resolve to the **same
address** and both time out before any HTTP exchange
(`UND_ERR_CONNECT_TIMEOUT`). No OAuth credential, retry policy, or anonymous
fallback can route around a network-level block — the entire mode machinery
in `lib/opensky.ts` was solving the wrong problem.

**Replacement:** community ADS-B aggregators that all speak the ADSBExchange
v2 response shape, so one parser serves any of them. Reachability probes
from a Vercel US deploy (iad1):

| Host | Result |
| --- | --- |
| airplanes.live | HTTP 200, **99 aircraft** in a 25 nm circle — chosen default |
| adsb.fi | HTTP 200, 43 aircraft, but 429s on rapid repeat — documented fallback |
| adsb.one | HTTP 403, Cloudflare-blocked for datacenter/non-browser clients |

**Swap mechanism:** `PLANES_API_BASE` env var (default
`https://api.airplanes.live`); `lib/planes.ts` (renamed from
`lib/opensky.ts`) builds the point/radius URL from `OBSERVER` (since §13: the
per-request observer) +
`PLANE_RADIUS_NM` (25). adsb.fi's divergent path scheme
(`/v2/lat/../lon/../dist/..` vs `/v2/point/../../..`) and array key
(`aircraft` vs `ac`) are auto-detected, so
`PLANES_API_BASE=https://opendata.adsb.fi/api` works with no code change.

**Format/unit differences vs OpenSky** (handled in `parseAircraft`):

- Named-field objects instead of positional state arrays.
- Imperial units: `alt_baro`/`alt_geom` in **feet** (×0.3048 → m before the
  unchanged az/alt math), `baro_rate`/`geom_rate` in **ft/min** (×0.00508 →
  m/s), `gs` already in **knots** (no conversion — OpenSky needed ×1.94384).
- On-ground is the sentinel `alt_baro: "ground"`, not a boolean field.
- Category is an emitter letter code (`A1`..`A7` map to the same
  light/small/large/heavy/rotorcraft buckets the OpenSky numerals did;
  B/C/D → "other").
- No credit system, no rate-limit headers: `creditsRemaining` dropped from
  `SkyStatus`; the ~10 s server-side snapshot cache is the etiquette cap,
  429 still backs off (≥60 s, honoring `Retry-After`) and degrades to a
  stale snapshot, then satellites-only. Plane failures still never break
  satellites.

**Region:** the fra1 pin on `/api/sky` (an OpenSky-era experiment) is
removed — these aggregators and adsbdb are US-friendly, so the function now
runs in Vercel's default US region, which is also where the probes ran.

**Enrichment note:** airplanes.live already returns `t` (type code),
`desc` (type name), `r` (registration), and `ownOp` (operator) inline —
enough to replace the adsbdb `/v0/aircraft` lookup (though not the photo
thumbnail or the `/v0/callsign` route data). adsbdb enrichment is kept
unchanged for now; if adsbdb becomes a problem, the aircraft-info half can
be sourced from the feed for free.

## 13. Per-user observer location (2026-07-29)

The observer stopped being an installation constant. A second person wants to
run the same app against their own sky, so `OBSERVER` — a module-level constant
in `lib/config.ts` that the SGP4 look angles, the plane az/alt conversion and
the ADS-B point query all reached for directly — is gone, replaced by an
`Observer` value threaded explicitly through every observer-dependent
computation (`lib/observer.ts`).

**This could not be a client-only change.** `/api/sky` computes satellite look
angles, aircraft az/alt and the sun/moon server-side, and the airplanes.live
query is a point/radius query around the viewer. The client therefore resolves
its location and sends it up with every poll.

### Resolution order (client, `lib/location.ts`)

1. `?lat=&lon=` URL params (plus optional `&elev=`, meters MSL).
2. The location stored on this device by an earlier visit.
3. `navigator.geolocation` (8 s timeout, low accuracy, 10 min cached position).
4. `DEFAULT_OBSERVER` — the original Chicago coordinates.

Every step funnels through the same validation, so an invalid value falls
through to the next source instead of reaching the API or the renderer.

Decisions inside that order:

- **URL params are persisted too**, and are labeled "custom" rather than
  distinguished from typed coordinates. A kiosk browser that reloads without
  the query string keeps showing the sky it was set up with, which is the
  behavior a fixed installation wants. The escape hatch is in the UI: the
  panel's "Reset to default" button *clears* the stored location, so it shows
  Chicago now and a later load resolves from scratch — including trying
  geolocation again. It is a factory reset, not a "pin Chicago" button, which is
  why it is not labeled with the city.
- **A stored `default` is never written.** Falling back to Chicago is not a
  choice the user made; persisting it would permanently stop a device from ever
  trying geolocation again (e.g. after the user grants permission later).
- **Geolocation failure is silent** — one `console.info`, no UI. Denied is a
  normal outcome for an ambient display, not a fault. The footer says
  "Chicago (default)" and that is the whole error report. The panel *does* show
  "location unavailable — unchanged" when the user explicitly presses
  "Use my location", because there a silent no-op would be the confusing thing.
- **Never rejects.** `requestGeolocation()` resolves to null on denial, timeout,
  insecure context, absent API, or a WebView that invokes neither callback (an
  extra guard timer covers that last case). Known limit of that guard: the W3C
  spec excludes permission-prompt time from the `timeout` option, so the guard —
  not the browser — is the effective deadline for *answering the prompt*. Someone
  who takes longer than ~10 s to click Allow lands on the fallback and has to
  press "Use my location" once. Fixed deliberately in that direction: the
  alternative is a blank dome for as long as an unanswered prompt sits there,
  and the first poll is intentionally held until the location is known so no
  viewer ever watches the wrong city paint and get wiped.

### Server boundary (`app/api/sky/route.ts`)

`GET /api/sky?lat=&lon=&elev=`. Query params over a POST body: the observer is
a *read* parameter, it keeps the endpoint a plain GET that is trivial to try by
hand, and it stays cacheable-by-URL if that is ever wanted.

Coordinates go out at **4 decimal places** (~11 m). Not for the geometry — a
dome 46 km across cannot show 11 m — but because a query string is recorded by
whatever access log sits in front of the app, which is the one place this code
cannot control. The handler deliberately refuses to log the values and
`lib/planes.ts` omits even the grid cell from its log line, so shipping 6
decimals (~0.1 m) in the URL would have undone that care one layer up. Rounding
is the cheap half of the problem; a POST body would be the other half, at the
cost of the plain-GET property above — not worth it at this scale, but that is
the trade being made.

Validation is the *same code* the browser runs before sending
(`observerFrom()`), so a value the client accepts is never rejected by the
server. Anything missing, unparseable or out of range falls back to
`DEFAULT_OBSERVER`: this endpoint never 500s on bad input, and a garbage
coordinate never reaches the upstream ADS-B query. `parseCoord()` is
deliberately stricter than both `parseFloat` (which would accept `"40.7abc"`)
and `Number` (which maps `""` to 0 — a blank latitude must not silently become
the equator). The response echoes the observer it actually used, so the client
can tell when its coordinates were dropped.

### Plane snapshot cache: keyed, bounded, and raw

The old cache was one module-level snapshot of finished `PlaneObject`s. Both
properties had to change:

- **It now caches the RAW upstream aircraft.** `az`, `alt` and `groundDistKm`
  are observer-relative, and — the irreducible one — the `PLANE_MIN_ALT_DEG`
  horizon cut decides *membership* from the elevation angle, so a parsed
  snapshot has already thrown away aircraft that are above another viewer's
  horizon. Each request projects the shared aircraft from its own position.
- **Keyed by grid cell**, with the in-flight promise resolving to the raw
  outcome rather than a finished `PlaneResult` — otherwise two viewers who
  share one fetch would still share the initiator's azimuths.
- **Bounded** at `PLANES_CACHE_MAX_ENTRIES = 16`, stalest evicted first. The cap
  is deliberately far above the number of real viewers: eviction targets the
  oldest `fetchedAt`, so a cap a normal day could reach would start evicting a
  live viewer's sky.
- Backoff after a 429 stays **global**: that is the host rate-limiting our
  egress IP, which has nothing to do with which patch of sky was asked for.

**Grid size: 0.01°, not the 0.5° the brief suggested.** The fetch is centred on
whichever viewer triggers it, so a lone viewer in a cell always gets an exactly
centred query; only a *second* viewer sharing the cell sees an offset query.
With the radius fixed at 25 nm (46.30 km) the worst-case offset governs how
much of that second viewer's own horizon disc was actually queried:

| grid | cell size at 41.9°N | worst-case offset | guaranteed radius | disc covered |
| --- | --- | --- | --- | --- |
| 0.5° | 55.6 × 41.4 km | 69.4 km | **0 km** — viewer can fall outside the query | ~53% |
| 0.1° | 11.1 × 8.3 km | 13.9 km | 32.4 km | ~90% |
| **0.01°** | 1.11 × 0.83 km | 1.39 km | **44.9 km** | **~99%** |

0.5° is not usable: the guaranteed radius collapses, and restoring it would
need a ~44 nm radius (3× the aircraft in every response) — and the radius is
fixed at 25 nm by requirement. 0.01° costs nothing, because the cache's real
job here is collapsing *repeated polls from one device* (whose coordinates are
byte-identical once resolved) and devices in the same building; sharing across
a whole neighborhood was never going to happen with two users.

**Rate-limit amplification.** `/api/sky` is public and takes coordinates from
the caller, so a client varying its coordinates would miss the cache on every
poll and turn this server into an amplifier against a free community API.
`PLANES_UPSTREAM_MAX_PER_MIN` caps upstream fetches per rolling minute across
all observers on the instance; beyond it, requests degrade down the existing
stale-or-empty path with "plane feed busy — too many distinct locations this
minute" and satellites are unaffected.

**Sizing that ceiling is where the first draft got it wrong**, and the mistake is
worth recording because the arithmetic is counter-intuitive.
`PLANES_SNAPSHOT_TTL_MS` (9.5 s) sits just *under* `CLIENT_POLL_MS` (10 s) by
design — the original intent was that every poll gets a fresh answer — so every
poll is a deliberate cache miss and **each distinct observer cell costs a steady
~6 upstream fetches per minute**. The ceiling was first set to 12/min with a
comment claiming it "comfortably covers a handful of viewers". It does not: 12
admits exactly *two* locations, i.e. it throttles the two-person Chicago + New
York case this whole change exists for, at ~7.5% of polls. Worse, the failure
compounds: a throttled viewer cannot refresh their cell, the cell's `fetchedAt`
goes stale, and it becomes the next eviction target — so an unlucky viewer loses
both their fetch and their cache entry. Measured at the real cadence: 3 locations
→ 35% of polls degraded, 4 → 50%.

45/min is the corrected value: 7 simultaneous locations (42 fetches/min) fit
inside it with headroom, it stays under one request per second, and a
coordinate-cycling caller is still capped far below the ~6/s it could otherwise
drive. The lesson generalises — a rate limit whose budget is smaller than the
legitimate steady-state demand is not a safety feature, it is an outage.

**Sized for a handful of users, and here is exactly where that shows.** Every
throttle here is module state — `snapshots`, the per-cell in-flight map,
`backoffUntil` and the fetch window all live per warm serverless instance. So on
Vercel the ceiling is per-instance, not per-deployment: N concurrent instances
permit N × 45 fetches/min, a cold start loses every cache, and the 429 backoff
one instance learns is not shared with the others. At two users on one warm
instance this is all academic; it is precisely what stops being academic if the
app is shared.

Known limits of the same shape, all accepted deliberately at this scale rather
than overlooked:

- **No per-caller fairness.** The ceiling and the cache are global, so an
  unauthenticated caller cycling coordinates can spend the minute's budget and
  push other viewers' cells toward eviction. Bounded (they cannot exceed the
  ceiling either) but not fair. Fixing it properly means per-IP accounting,
  which means shared state, which is the same rewrite as below.
- **adsbdb exposure.** `enrichPlanes` awaits up to 4 uncached lookups per
  request, and before this change its key space was bounded by geography — only
  airframes passing one fixed point could ever appear. It is now worldwide, so
  the two caches are explicitly capped (`ENRICH_CACHE_MAX_ENTRIES`) instead of
  relying on that accident. The per-request lookup bound plus the plane ceiling
  keeps the worst case at a few lookups per second; there is no separate adsbdb
  rate limit.
- **Cache-hit timing is an oracle.** Because snapshots are keyed by cell and
  shared, a caller can distinguish "someone else recently fetched this cell"
  from "nobody has" by latency or by the stale-snapshot message — a ~1 km
  location probe. Irrelevant for two people who know each other; it would not be
  for a public deployment.

The fix, if it is ever shared widely, is either a real shared cache with
eviction (Redis/KV keyed by cell, TTL ~10 s) plus per-IP limits, or moving the
plane fetch client-side so each browser talks to the aggregator with its own IP
and rate budget — and at that point airplanes.live should be asked first, or a
paid feed used. Do not simply raise the ceiling.

### De-hardcoding Chicago

Swept the whole repo. Changed:

| What | Was | Now |
| --- | --- | --- |
| `lib/geo.ts` `observerAzAlt` | read `OBSERVER` | takes an `Observer` (note it uses `elevationM`, not just lat/lon) |
| `lib/satellites.ts` | `observerGd` built once at import | derived per call; the satrec cache stays shared (an SGP4 record belongs to the TLE, not the viewer) |
| `lib/planes.ts` `planesUrl` | `OBSERVER` coords | the requesting observer |
| `lib/planes.ts` `chicagoTime()` | backoff times formatted in `America/Chicago` for everyone | **deleted.** User-facing messages now say "retrying in 45s" — a wait needs no timezone; the server has no idea which zone the reader is in. Log lines use ISO UTC. |
| `app/api/sky/route.ts` | `computeAstro`/`sunPosition` on `OBSERVER` | on the request observer, so twilight, sun/moon and satellite `visibleNow` (which depends on the *observer's* sun altitude) all follow the viewer |
| `hud.ts` footer clock | the **device's** timezone | the observer's zone (below) |
| `hud.ts` footer | no location provenance | notes the source: "your location" / "Chicago (default)" / "custom" |

Deliberately left alone:

- **`backend/` and `frontend/`** — frozen v1 reference, still hardwired to
  Chicago. Untouched by design.
- **`lib/astro.ts`** — read end to end: no coordinates and no hemisphere
  assumption. `equatorialToHorizontal` is the general spherical transform,
  latitude enters symmetrically, and `twilightState` is pure sun-altitude
  thresholds (polar summer simply never leaves `day`/`civil`). The moon's
  bright-limb rotation follows the projected sun position, so it flips
  correctly for a southern observer with no latitude constant anywhere.
  Verified live: Sydney returns `sun alt 36.9°, "day"` while Chicago is in
  civil twilight.
- **`lib/projection.ts` and `scripts/test-projection.ts`** — pure az/alt→screen
  mapping, no latitude term. "North at top" is a display convention, correct in
  either hemisphere.
- **`fmtInt`'s `toLocaleString("en-US")`** and `<html lang="en">` — a *locale*
  for digit grouping and the language of the UI copy, neither of which is a
  function of where the observer stands.
- **The `ORD → LGA` / `"Chicago"` strings** in the `simulate()` debug snippet
  and the `types.ts` field docs — example route text, unrelated to the observer.
- **`PLANE_RADIUS_NM = 25`** — a radius around whoever is watching. Its comment
  cited a Chicago-measured aircraft count as justification; that count is now
  labeled as a Chicago probe rather than a general expectation.

**Correction to the brief's premise:** the status-footer clock was *not*
hardcoded to `America/Chicago`. `hud.ts` called
`toLocaleTimeString([], {...})` with no `timeZone`, i.e. the device's own zone —
correct while the viewer stood where the observer did, wrong the moment a URL
param points the dome at another city. Only `planes.ts:chicagoTime()` was a
literal `America/Chicago`. Both are fixed; the outcome is what was asked for.

### Which clock (`lib/timezone.ts`)

1. Location came from geolocation → `Intl.DateTimeFormat().resolvedOptions()
   .timeZone`. The device is *at* those coordinates, so its own zone is the
   answer, free and instant.
2. Location is the Chicago fallback → `DEFAULT_OBSERVER_ZONE`, declared next to
   `DEFAULT_OBSERVER` so one place says both "the fallback is Chicago" and
   "here is its clock".
3. Custom coordinates → `tz-lookup`, an offline coordinate→IANA lookup.
4. Nothing worked → `null`, and the clock renders in **UTC with a visible "UTC"
   label**. Never a silently wrong local time.

Rendering: a zone matching the device's own shows a bare time ("19:42"); any
other zone gets its short name ("21:42 EDT") so a remote sky's clock cannot be
misread as your own. The two zone ids are compared *after* canonicalization
through `Intl`, because many IANA ids are links (`Asia/Kolkata` →
`Asia/Calcutta`) and a raw string compare reports differences that do not
exist.

**Why `tz-lookup` (6.1.25) is an acceptable dependency:** CC0-1.0 (verbatim
public-domain dedication in its `LICENSE`, no attribution obligation), zero
runtime dependencies, no Node built-ins, one pure-JS function over a packed
string table. It is `await import()`ed only on the custom-coordinates path, so
it lands in its own ~28 KB gzip chunk and the initial load is unchanged
(verified: the zone table appears in exactly one lazy chunk and never in the
initial payload). Types are a 4-line local `types/tz-lookup.d.ts` rather than
`@types/tz-lookup` — the real package is `module.exports = fn`, so `export =`
is the accurate shape and `(await import("tz-lookup")).default` is the
function.

Its caveats, accepted:

- The embedded boundary data is from January 2019 and the package is
  unmaintained, so a few zone *names* are archaic (`Europe/Kiev` rather than
  `Europe/Kyiv`, `America/Godthab` rather than `America/Nuuk`). Those renames
  are offset-identical, so displayed times are right.
- Post-2019 boundary splits are missing. The one verified wrong answer is
  Ciudad Juárez (returns `America/Ojinaga`, an hour off). Acceptable for an
  ambient clock; if hour-exact correctness anywhere on Earth ever matters, this
  package cannot provide it.
- Its data derives from OpenStreetMap via timezone-boundary-builder, which is
  ODbL — hence the credit in the `lib/timezone.ts` header, since CC0 on the
  wrapper does not extinguish the upstream database terms.
- A device whose own clock is set to the wrong zone while using geolocation
  will show that wrong zone (step 1 trusts the device). Rare and self-inflicted,
  and it matches the wall clock in the room; not worth a plausibility heuristic
  that would only fire on continent-scale mismatches.
- Step 1 keys off the *source*, and `geolocation` is a **persisted** source, so a
  laptop that geolocated in New York and is reopened in Denver shows the stored
  New York sky with Denver's clock. Note that the coordinates are equally stale
  in that situation — the whole location is, by the deliberate "a reload never
  re-prompts" design — and the fix is the same one press either way:
  "Use my location". Deriving the zone from the stored coordinates instead would
  make the clock disagree with the room while still showing the wrong sky, which
  is not obviously better.

### Elevation

`DEFAULT_OBSERVER` keeps its measured 180 m. Every other location assumes
**sea level** (`ELEVATION_UNKNOWN_M = 0`) rather than inventing a number, with
two exceptions: geolocation's own `altitude` is used when the device claims it
is accurate to ~100 m (it is a WGS84 ellipsoidal height and is usually absent
or wildly uncertain), and `&elev=` overrides it explicitly.

How much this matters depends on the traffic, and the honest answer is "usually
not much, sometimes a lot". Elevation enters only as
`planeAltitude − observerElevation`, so a 200 m error moves a jet at 11 km and
46 km range by ~0.2° — invisible. But measured against Denver with a deliberate
1600 m error, the worst-affected aircraft in the same response shifted **9.7°**
of elevation angle: close, low traffic is where an observer's own height is a
real term. Hence sea level is a *labeled* default and `&elev=` exists; the panel
still asks for lat/lon only rather than pretending to know the third number,
because a wrong elevation someone typed confidently is worse than a documented
assumption.

### Runtime changes when the location moves

`az`/`alt` are topocentric, so on a location change every tracked object
belongs to the old sky. `SkyEngine.resetTracked()` disposes the tracked set,
zeroes `lastTs`, nulls `astro` and hides the sun/moon meshes (`updateAstroLayers`
early-returns while `astro` is null, so nothing else would move them off the old
city's positions), and invalidates the twilight/moon paint keys. The renderer,
camera, dome furniture and RAF loop all survive — the engine is never recreated,
which would drop the WebGL context and flash the projector black.

The subtle one: without this, a satellite that happens to be up at *both*
locations gets its new position read as a velocity sample across the
discontinuity, and dead reckoning then sweeps it around the dome at the clamped
6 °/s until the next poll. Related, the in-flight poll is aborted **and**
invalidated by a generation counter on a location change: an already-resolved
response whose `.then` is queued as a microtask would otherwise repopulate the
dome with the old sky milliseconds after the reset. `ingest()` also now drops
any object with a non-finite `az`/`alt` — defense in depth for values that
originate in a URL parameter, since one NaN would poison a record's trail
buffer permanently.

Not touched by a location change: the whole-scene CSS rotation, the map-rotation
offset and `CEILING_MIRROR`. In particular `resetTracked()` deliberately does
not reset the compass — silently re-aiming a fixed ceiling install to North-up
would be a bad surprise.

Three smaller races in the same area, each fixed:

- **A late geolocation fix must not overwrite a newer choice.** "Use my location"
  can sit behind a permission prompt for ten seconds, during which the user may
  type coordinates or press reset. The request is stamped and a superseded
  result is discarded — otherwise the late fix silently replaced *and persisted
  over* what they picked.
- **Returning to a visible tab forces the poll.** A request issued before the tab
  was hidden may still be outstanding (a frozen tab does not even run its own
  timeout), and the unforced refresh-on-return was being dropped by the
  one-poll-in-flight guard, leaving the dome stale for another full interval.
- **The coordinate fields use `inputMode="text"`, not `"decimal"`.** iOS renders
  the decimal pad with no minus key, which would have made every longitude in
  the Americas — including both intended users' — literally untypeable.

### Verified (2026-07-29)

`tsc --noEmit` clean; `next build` green (no ESLint config exists in this
project, so `next build` reports "Skipping linting"); both self-tests pass
(`scripts/test-projection.ts` — the ceiling-mirror/rotation regression net —
and the new `scripts/test-planes-cache.ts`, 14 assertions, offline).

Against a production build, `/api/sky`:

| request | result |
| --- | --- |
| `?lat=40.7128&lon=-74.0060&elev=10` | HTTP 200, observer echoed, 5 sats / 20 planes, sun alt −12.2° "astronomical" |
| no params | HTTP 200, Chicago default, 6 sats / 12 planes, sun alt −3.0° "civil" |
| `?lat=999&lon=abc` · `?lat=&lon=` · `?lat=40.7` (lon missing) · `?lat=40.7128%2F..%2F..%2Fevil` | HTTP 200 every time, default observer, no upstream request with the bad value |
| `?lat=-33.8688&lon=151.2093` (Sydney) | HTTP 200, sun alt +36.9° "day" — southern hemisphere correct |
| `?lat=90&lon=0` | HTTP 200, 10 sats, 0 planes |

NYC vs Chicago in the same minute: **plane sets completely disjoint**
(Jaccard 0.000, 20 vs 12 aircraft); satellite sets overlap 0.571 as they should
(the TLE set is global) but the shared objects sit in visibly different places —
`ATLAS CENTAUR 2` at az 244.1°/alt 12.0° from NYC vs az 212.0°/alt 24.4° from
Chicago. The dome genuinely changes; it is not a shifted copy.

In a headless browser (34 assertions, Chromium, `timezoneId` and geolocation
overridden per case):

- geolocation allowed → observer is the device's position, footer reads
  "your location", clock matches real New York wall time
- `?lat=40.7128&lon=-74.0060` from a Chicago-timezone device → URL wins,
  footer "custom", clock "09:26 PM EDT" (not the device's Chicago time)
- geolocation denied → Chicago default, footer "Chicago (default)", sky still
  renders, no error text on screen and no page errors
- `?lat=999&lon=abc` → params ignored, geolocation used instead, no crash
- reload with a stored NYC location while the device is now in Denver → the
  stored location is restored, no geolocation round-trip
- typing Sydney's coordinates into the panel → tracked set empties immediately
  (`lastTs` 0), repopulates 3 s later with a Sydney sky, plane sets disjoint
  from the NYC ones, page never reloaded, clock switches to GMT+10
- custom Tokyo/London/mid-ocean coordinates → clocks "10:27 AM GMT+9",
  "02:27 AM GMT+1", "11:27 PM GMT−2" (nautical zone), all labeled
- both rotation controls still work alongside the new one, and both persist

Cache and rate limiting, walking 60 distinct cells offline: upstream fetches
capped at exactly 45, the first refusal at request #46, the snapshot map held at
16 entries, and refusals beginning only past the 7-location (42 fetch) budget —
so the intended viewer count is never throttled. Against a live server with 16
distinct cities every request still returned HTTP 200, and the cells past the
ceiling degraded to "plane feed busy — too many distinct locations this minute"
with satellites unaffected (that run was made at the original 12/min setting,
which is how the mis-sizing above was caught).

Elevation, against Denver with a deliberate 1600 m error: `elev` echoed back,
an out-of-range value ignored rather than fatal, 17 aircraft shared from one
upstream fetch and projected twice, azimuths bit-identical (elevation must not
rotate anything), sun/moon identical (elevation is not in the astro model), and
a worst-case 9.7° elevation-angle shift on the closest low aircraft.

### Follow-ups (not done here)

- `web/.env.local` still holds the `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET`
  for the data source removed in §12. Gitignored, but worth revoking and
  deleting. Not read or printed here.
- `npm audit` reports pre-existing high-severity advisories in `next`,
  `postcss` and `sharp` (unrelated to this change; `tz-lookup` adds none). An
  upgrade is its own task.
- **Pre-existing bug, found while reviewing this change and deliberately not
  fixed here** (it predates the per-user observer and is unrelated to it):
  `SkyEngine.resume()` shifts every tracked record's timestamps forward by the
  pause duration, on the assumption that nothing was ingested while paused. But
  `ingest()` is gated only on `disposed`, never on `running`, so a poll response
  that lands just after `pause()` gets live timestamps and is then pushed into
  the future — after a long hidden period those records never fade or expire.
  The fix is a one-line guard (ignore `ingest` while paused, or stamp against the
  pause origin); it belongs in its own commit.
