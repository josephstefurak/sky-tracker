/**
 * Central configuration for sky-tracker. Shared by server and client code;
 * keep it free of imports so either side can use it.
 */

// Observer location (Chicago — fixed installation).
export const OBSERVER = {
  lat: 41.91734343314767,
  lon: -87.63808451349306,
  elevationM: 180.0,
};

// Aircraft search radius around the observer, in nautical miles (the ADS-B
// v2 point/radius endpoints take nm). 25 nm puts a cruising jet (~11 km) at
// ~13 deg elevation when acquired; the Phase-1 probe saw ~99 aircraft in
// this circle, plenty for the dome.
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
// Serve a stale snapshot for at most this long before degrading to "no planes".
export const PLANES_STALE_MAX_MS = 45_000;
// After a 429, pause upstream fetches at least this long (Retry-After wins
// if longer). Community aggregators rate-limit per-IP but recover quickly.
export const PLANES_BACKOFF_MS = 60_000;

// adsbdb enrichment: at most this many uncached lookups awaited per /api/sky
// request (the cache warms over successive polls; adsbdb stays un-hammered).
export const ADSBDB_MAX_LOOKUPS_PER_REQUEST = 4;
export const ADSBDB_NEGATIVE_TTL_MS = 2 * 60 * 60_000;
export const ADSBDB_TIMEOUT_MS = 4_000;

// Client poll cadence; dead reckoning keeps motion smooth in between.
export const CLIENT_POLL_MS = 10_000;

// Identify ourselves politely to the free APIs we use.
export const USER_AGENT = "sky-tracker/2.0 (personal ceiling sky display)";
