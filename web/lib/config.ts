/**
 * Central configuration for sky-tracker. Shared by server and client code;
 * keep it free of imports so either side can use it.
 */

// The observer location is NOT configured here: it is resolved per user (URL
// params → localStorage → browser geolocation → Chicago fallback) and passed
// explicitly into the observer-dependent code. See lib/observer.ts for the
// Observer type, the DEFAULT_OBSERVER fallback and input validation, and
// lib/location.ts for the browser-side resolution order.

// Aircraft search radius around the observer, in nautical miles (the ADS-B
// v2 point/radius endpoints take nm). 25 nm puts a cruising jet (~11 km) at
// ~13 deg elevation when acquired. The same radius is used for every viewer;
// how many aircraft that yields is a property of where they are, not of this
// constant (the Phase-1 probe counted ~99 over Chicago, but a quiet stretch of
// countryside will show a handful and the dome is fine either way).
export const PLANE_RADIUS_NM = 25;

// Visibility thresholds, in degrees above the horizon (match legacy backend).
export const SAT_MIN_ALT_DEG = 5.0;
export const PLANE_MIN_ALT_DEG = 2.0;

// Celestrak satellite groups to merge (deduped by NORAD id). "visual" is the
// curated bright-satellite set the legacy app used; "stations" guarantees the
// ISS and CSS (Tiangong) are always present and lets us tag them as stations.
export const CELESTRAK_GROUPS = ["visual", "stations"] as const;

// TLEs change slowly; refresh every 6 hours (matches legacy backend).
export const TLE_REVALIDATE_SECONDS = 6 * 60 * 60;

// Server-side plane snapshot cache: many clients polling every ~10s share
// one upstream fetch — also our rate-limit etiquette toward the free
// community ADS-B API. Slightly under the client poll interval.
export const PLANES_SNAPSHOT_TTL_MS = 9_500;
// Snapshots are keyed by the observer's coordinates rounded to this grid, so
// viewers at (nearly) the same spot share one upstream call while distant
// viewers never see each other's sky. The fetch is centred on whichever
// viewer triggered it, so the only viewer in a cell always gets an exactly
// centred 25 nm query; a second viewer sharing the cell can sit up to ~1.4 km
// off that centre, which still covers ~99% of their own horizon disc. Coarser
// cells share more widely but cost the sharer real aircraft: at 0.5 deg the
// guaranteed radius collapses from 46 km to 11.5 km. See DECISIONS.md §13.
export const PLANES_CACHE_GRID_DEG = 0.01;
// Hard cap on cached snapshots (oldest evicted first). This app serves a
// handful of viewers; the cap exists so an unexpected spread of coordinates
// can never grow the map without bound. Sized well above the number of real
// viewers on purpose: eviction targets the STALEST cell, so a cap that a
// normal day could reach would start evicting a live viewer's sky.
export const PLANES_CACHE_MAX_ENTRIES = 16;
// Serve a stale snapshot for at most this long before degrading to "no planes".
export const PLANES_STALE_MAX_MS = 45_000;
// After a 429, pause upstream fetches at least this long (Retry-After wins
// if longer). Community aggregators rate-limit per-IP but recover quickly.
export const PLANES_BACKOFF_MS = 60_000;
// Ceiling on upstream ADS-B fetches per rolling minute, across all observers on
// this instance. /api/sky is public and takes coordinates from the caller, so
// without this a client varying its coordinates would miss the per-cell cache
// every poll and turn this server into an amplifier against a free community
// API.
//
// Sizing arithmetic matters here, and the obvious guess is wrong: because
// PLANES_SNAPSHOT_TTL_MS (9.5 s) sits just UNDER CLIENT_POLL_MS (10 s) by
// design, every poll is a deliberate cache miss, so each distinct observer cell
// costs a steady ~6 upstream fetches per minute. A ceiling of 12 would
// therefore admit exactly two locations — it would throttle the two-person case
// this app was opened up for, and the throttled viewer's cell would then go
// stale and become the eviction target. 45/min covers ~7 simultaneous
// locations, stays under one request per second, and still caps a
// coordinate-cycling caller far below what it could otherwise drive.
export const PLANES_UPSTREAM_MAX_PER_MIN = 45;

// adsbdb enrichment: at most this many uncached lookups awaited per /api/sky
// request (the cache warms over successive polls; adsbdb stays un-hammered).
export const ADSBDB_MAX_LOOKUPS_PER_REQUEST = 4;
export const ADSBDB_NEGATIVE_TTL_MS = 2 * 60 * 60_000;
export const ADSBDB_TIMEOUT_MS = 4_000;

// Client poll cadence; dead reckoning keeps motion smooth in between.
export const CLIENT_POLL_MS = 10_000;

// Identify ourselves politely to the free APIs we use.
export const USER_AGENT = "sky-tracker/2.0 (personal ceiling sky display)";
