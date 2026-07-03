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
`lib/opensky.ts`) builds the point/radius URL from `OBSERVER` +
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
