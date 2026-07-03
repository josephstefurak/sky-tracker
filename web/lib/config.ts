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

// Aircraft bounding box around the observer. Wider than the legacy backend's
// box so planes are acquired lower on the dome (~7 deg elevation at cruise
// instead of ~14). Area is ~2.8 square degrees, which stays in OpenSky's
// cheapest credit tier (1 credit per call, area < 25 deg^2).
export const PLANE_BBOX = {
  lamin: 41.2,
  lamax: 42.65,
  lomin: -88.6,
  lomax: -86.7,
};

// Visibility thresholds, in degrees above the horizon (match legacy backend).
export const SAT_MIN_ALT_DEG = 5.0;
export const PLANE_MIN_ALT_DEG = 2.0;

// Celestrak satellite groups to merge (deduped by NORAD id). "visual" is the
// curated bright-satellite set the legacy app used; "stations" guarantees the
// ISS and CSS (Tiangong) are always present and lets us tag them as stations.
export const CELESTRAK_GROUPS = ["visual", "stations"] as const;

// TLEs change slowly; refresh every 6 hours (matches legacy backend).
export const TLE_REVALIDATE_SECONDS = 6 * 60 * 60;

// Server-side OpenSky snapshot cache: many clients polling every ~10s share
// one upstream fetch. Slightly under the client poll interval.
export const OPENSKY_SNAPSHOT_TTL_MS = 9_500;
// Serve a stale snapshot for at most this long before degrading to "no planes".
export const OPENSKY_STALE_MAX_MS = 45_000;
// After a 429 (credits exhausted), pause upstream fetches this long.
export const OPENSKY_BACKOFF_MS = 5 * 60_000;

// adsbdb enrichment: at most this many uncached lookups awaited per /api/sky
// request (the cache warms over successive polls; adsbdb stays un-hammered).
export const ADSBDB_MAX_LOOKUPS_PER_REQUEST = 4;
export const ADSBDB_NEGATIVE_TTL_MS = 2 * 60 * 60_000;
export const ADSBDB_TIMEOUT_MS = 4_000;

// Client poll cadence; dead reckoning keeps motion smooth in between.
export const CLIENT_POLL_MS = 10_000;

// Identify ourselves politely to the free APIs we use.
export const USER_AGENT = "sky-tracker/2.0 (personal ceiling sky display)";
