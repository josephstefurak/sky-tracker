/**
 * The observer — who is looking up, and from where.
 *
 * This used to be a single hardcoded constant (`OBSERVER` in lib/config.ts,
 * fixed to the Chicago installation) that the satellite propagation, the
 * plane az/alt conversion and the ADS-B point query all reached for directly.
 * The location is now resolved per user, so it is passed explicitly into every
 * observer-dependent computation instead of being read from module scope.
 *
 * Deliberately pure and import-free: the API route (server) and the browser
 * location resolver (client) validate coordinates with the SAME code, so a
 * value the client would accept is never rejected by the server, and neither
 * side can send or store garbage.
 */

export interface Observer {
  /** Degrees north, [-90, 90]. */
  lat: number;
  /** Degrees east, [-180, 180]. */
  lon: number;
  /** Meters above mean sea level. */
  elevationM: number;
}

/**
 * Fallback observer: the original fixed installation (Chicago), used whenever
 * nothing better is known — geolocation denied/unavailable/timed out, invalid
 * input, or a server request that arrives with no coordinates.
 *
 * Its elevation is a measured value for that site; other locations get
 * ELEVATION_UNKNOWN_M (see below) rather than an invented number.
 */
export const DEFAULT_OBSERVER: Observer = {
  lat: 41.91734343314767,
  lon: -87.63808451349306,
  elevationM: 180.0,
};

/** The fallback location's IANA timezone — declared here so the one place that
 *  says "the fallback is Chicago" also says what its clock reads. */
export const DEFAULT_OBSERVER_ZONE = "America/Chicago";

/**
 * Elevation assumed when it is genuinely unknown (manual coordinates, or
 * geolocation that reports no usable altitude). Sea level is the honest
 * placeholder rather than an invented number: observer elevation only enters
 * the geometry as `planeAltitude - observerElevation`, which is worth ~0.2 deg
 * for a jet at 11 km and 46 km range — but several degrees for low traffic
 * close by (measured: a 1600 m error moved the worst-affected aircraft 9.7 deg).
 * Correct it per install with the `elev` URL parameter if the site is high
 * (e.g. Denver: `&elev=1600`).
 */
export const ELEVATION_UNKNOWN_M = 0;

/** Sanity bounds: Dead Sea shore to above the summit of Everest. */
const MIN_ELEVATION_M = -500;
const MAX_ELEVATION_M = 9000;

export function isValidLat(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
}

export function isValidLon(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;
}

export function isValidElevation(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= MIN_ELEVATION_M &&
    v <= MAX_ELEVATION_M
  );
}

/**
 * Strict numeric parse for external input (URL params, form fields, stored
 * JSON). Unlike parseFloat this refuses trailing garbage ("40.7abc"), and
 * unlike Number() it refuses the empty/whitespace string that Number() maps to
 * 0 — a blank latitude must not silently become the equator.
 */
export function parseCoord(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build an Observer from unvalidated lat/lon (+ optional elevation) of any
 * origin. Returns null — never a partly-valid observer — if either coordinate
 * is missing, unparseable or out of range, so callers fall back cleanly.
 * An out-of-range or unparseable elevation is ignored rather than fatal.
 */
export function observerFrom(
  latRaw: unknown,
  lonRaw: unknown,
  elevRaw?: unknown
): Observer | null {
  const lat = parseCoord(latRaw);
  const lon = parseCoord(lonRaw);
  if (!isValidLat(lat) || !isValidLon(lon)) return null;
  const elev = parseCoord(elevRaw);
  return {
    lat,
    lon,
    elevationM: isValidElevation(elev) ? elev : ELEVATION_UNKNOWN_M,
  };
}

/** True when two observers are the same spot (~1 m) at the same elevation. */
export function sameObserver(a: Observer, b: Observer): boolean {
  return (
    Math.abs(a.lat - b.lat) < 1e-5 &&
    Math.abs(a.lon - b.lon) < 1e-5 &&
    Math.abs(a.elevationM - b.elevationM) < 1
  );
}

/** Compact human-readable coordinates, e.g. "40.7128, -74.0060". */
export function formatCoords(o: Observer): string {
  return `${o.lat.toFixed(4)}, ${o.lon.toFixed(4)}`;
}
