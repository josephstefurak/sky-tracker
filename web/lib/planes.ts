/**
 * Aircraft positions from a community ADS-B aggregator (airplanes.live by
 * default) speaking the ADSBExchange v2 response shape.
 *
 * OpenSky was dropped 2026-07-03: both of its hostnames resolve to the same
 * IP and hard-block Vercel datacenter ranges at the TCP connect stage, so no
 * auth mode could ever work from a deploy (see DECISIONS.md §12). The v2
 * aggregators are unauthenticated plain GETs — no tokens, no credentials.
 *
 * The host is swappable via PLANES_API_BASE without code changes; adsb.fi is
 * the tested fallback (it names the aircraft array `aircraft` instead of `ac`
 * and uses a different path scheme — both handled here).
 *
 * Failures NEVER propagate: every path returns a PlaneResult whose status
 * explains what happened, and every log line carries the error class, message
 * and HTTP status.
 *
 * Module-level snapshot caches (TTL just under the client poll interval) mean
 * any number of viewers at the same place costs one upstream call per ~10s per
 * warm lambda — polite to a free community API. Since the observer is now
 * per-user, snapshots are KEYED by the viewer's grid cell and hold the RAW
 * upstream aircraft: az/alt/ground-distance are observer-relative, so every
 * reader projects the shared aircraft from its OWN position. On a 429 we back
 * off (honoring Retry-After) and serve a recent snapshot for up to
 * PLANES_STALE_MAX_MS before degrading to satellites-only.
 */

import {
  PLANE_MIN_ALT_DEG,
  PLANE_RADIUS_NM,
  PLANES_BACKOFF_MS,
  PLANES_CACHE_GRID_DEG,
  PLANES_CACHE_MAX_ENTRIES,
  PLANES_SNAPSHOT_TTL_MS,
  PLANES_STALE_MAX_MS,
  PLANES_UPSTREAM_MAX_PER_MIN,
  USER_AGENT,
} from "./config";
import { observerAzAlt } from "./geo";
import type { Observer } from "./observer";
import type { PlaneCategory, PlaneObject, SkyStatus } from "./types";

export type PlaneStatus = SkyStatus["planes"];
export interface PlaneResult {
  planes: PlaneObject[];
  status: PlaneStatus;
}

const DEFAULT_API_BASE = "https://api.airplanes.live";

const FT_TO_M = 0.3048;
const FTMIN_TO_MS = 0.3048 / 60; // ft/min -> m/s

/**
 * Point/radius query URL. airplanes.live and adsb.one use
 * /v2/point/{lat}/{lon}/{nm}; adsb.fi (base https://opendata.adsb.fi/api)
 * spells the same query /v2/lat/{lat}/lon/{lon}/dist/{nm}.
 *
 * The coordinates are interpolated into a path, so they must already be
 * validated finite numbers in range (observerFrom() guarantees it) —
 * `toFixed(5)` then yields nothing but digits, `-` and `.`, and no caller can
 * smuggle path segments or a different host into the query.
 */
export function planesUrl(observer: Observer): string {
  const base = (process.env.PLANES_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
  const lat = observer.lat.toFixed(5);
  const lon = observer.lon.toFixed(5);
  if (new URL(base).hostname.endsWith("adsb.fi")) {
    return `${base}/v2/lat/${lat}/lon/${lon}/dist/${PLANE_RADIUS_NM}`;
  }
  return `${base}/v2/point/${lat}/${lon}/${PLANE_RADIUS_NM}`;
}

// ---------------------------------------------------------------------------
// Module state (persists per warm serverless instance)
// ---------------------------------------------------------------------------

/** Raw upstream aircraft for one grid cell — never observer-projected. */
interface Snapshot {
  aircraft: AdsbAircraft[];
  fetchedAt: number;
}

const snapshots = new Map<string, Snapshot>();

/**
 * One in-flight upstream fetch per cell. It resolves to the RAW outcome rather
 * than a finished PlaneResult, so two viewers who share a fetch each still
 * project the aircraft from their own coordinates.
 */
type FetchOutcome =
  | { kind: "aircraft"; aircraft: AdsbAircraft[] }
  | { kind: "failure"; message: string };

const inflight = new Map<string, Promise<FetchOutcome>>();

// Backoff is deliberately GLOBAL, not per cell: a 429 is the upstream host
// rate-limiting our egress IP, which has nothing to do with which patch of sky
// was requested.
let backoffUntil = 0;
let backoffReason = "";

// Sliding one-minute window of upstream fetch times. /api/sky is public and
// takes coordinates from the caller, so a client that varies its coordinates
// would otherwise miss the per-cell cache on every poll and turn us into an
// amplifier against a free community API. Fetches beyond the budget degrade to
// the stale-or-empty path exactly like a rate-limit would.
const upstreamFetches: number[] = [];

/** Snapshot key: the observer's cell on the PLANES_CACHE_GRID_DEG grid, as
 *  integer indices so the key carries no float-rounding artifacts. */
function snapshotKey(observer: Observer): string {
  const cell = (deg: number) => Math.round(deg / PLANES_CACHE_GRID_DEG);
  return `${cell(observer.lat)}:${cell(observer.lon)}`;
}

/** Store a snapshot, evicting the oldest entries past the cap. */
function storeSnapshot(key: string, aircraft: AdsbAircraft[]): void {
  snapshots.set(key, { aircraft, fetchedAt: Date.now() });
  while (snapshots.size > PLANES_CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, snap] of snapshots) {
      if (snap.fetchedAt < oldestAt) {
        oldestAt = snap.fetchedAt;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break;
    snapshots.delete(oldestKey);
  }
}

/** True when the one-minute upstream budget is spent (and prunes the window). */
function upstreamBudgetSpent(): boolean {
  const cutoff = Date.now() - 60_000;
  while (upstreamFetches.length > 0 && upstreamFetches[0] < cutoff) {
    upstreamFetches.shift();
  }
  return upstreamFetches.length >= PLANES_UPSTREAM_MAX_PER_MIN;
}

/**
 * ADS-B emitter category letters (A1..A7) map onto the same buckets the old
 * OpenSky numeric categories (2..8) did; B/C/D codes (gliders, UAVs, ground
 * vehicles...) become "other", A0/absent become null (unknown).
 */
const CATEGORY_MAP: Record<string, PlaneCategory> = {
  A1: "light",
  A2: "small",
  A3: "large",
  A4: "large", // high-vortex large (B757)
  A5: "heavy",
  A6: "heavy", // high performance
  A7: "rotorcraft",
};

function categoryFor(raw: unknown): PlaneCategory | null {
  if (typeof raw !== "string" || raw === "" || raw === "A0") return null;
  return CATEGORY_MAP[raw] ?? "other";
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * One aircraft in the ADSBExchange v2 shape: named fields, imperial units
 * (altitudes in feet, ground speed in knots, vertical rates in ft/min —
 * OpenSky was meters and m/s). `alt_baro` is the string "ground" while on
 * the ground. Field names verified against airplanes.live's field docs and
 * live responses from airplanes.live + adsb.fi.
 */
export interface AdsbAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  geom_rate?: number;
  category?: string;
}

/**
 * Project raw upstream aircraft into observer-relative PlaneObjects. Called
 * once per request (not once per upstream fetch) because everything azimuthal
 * here belongs to one specific viewer: `az`, `alt` and `groundDistKm` come
 * from the observer, while identity, altitude, speed, heading, vertical rate
 * and category are properties of the aircraft alone.
 *
 * Exported for offline tests against a saved v2 point-query sample.
 */
export function parseAircraft(
  list: AdsbAircraft[] | null | undefined,
  observer: Observer
): PlaneObject[] {
  const out: PlaneObject[] = [];
  for (const a of list ?? []) {
    const icao24 = String(a.hex ?? "").trim().toLowerCase();
    const callsign = String(a.flight ?? "").trim();
    const onGround = a.alt_baro === "ground";
    const baroAltFt = typeof a.alt_baro === "number" ? a.alt_baro : null;
    const geoAltFt = typeof a.alt_geom === "number" ? a.alt_geom : null;
    const rateFtMin = a.baro_rate ?? a.geom_rate ?? null;

    if (onGround || a.lat == null || a.lon == null || !icao24) continue;
    const altFt = geoAltFt ?? baroAltFt;
    if (altFt == null) continue;
    const altitudeM = altFt * FT_TO_M;

    const { az, alt, groundM } = observerAzAlt(observer, a.lat, a.lon, altitudeM);
    if (alt <= PLANE_MIN_ALT_DEG) continue;

    out.push({
      type: "plane",
      id: `plane:${icao24}`,
      icao24,
      callsign,
      az: r2(az),
      alt: r2(alt),
      altitudeM: Math.round(altitudeM),
      speedKt: a.gs == null ? null : Math.round(a.gs), // already knots
      heading: a.track == null ? null : r1(a.track),
      verticalRateMs: rateFtMin == null ? null : r1(rateFtMin * FTMIN_TO_MS),
      groundDistKm: r1(groundM / 1000),
      category: categoryFor(a.category),
    });
  }
  return out;
}

/**
 * Flatten an error and its cause chain. Undici's fetch reports every network
 * failure as `TypeError: fetch failed` and buries the real reason (DNS,
 * connect timeout, TLS, ECONNRESET...) in `.cause`, so logging only
 * name/message tells you nothing.
 */
export function describeError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (cur instanceof AggregateError) {
      const inner = cur.errors
        .map((x) => (x instanceof Error ? `${(x as NodeJS.ErrnoException).code ?? x.name}: ${x.message}` : String(x)))
        .join("; ");
      parts.push(`AggregateError(${inner})`);
      cur = cur.cause;
    } else if (cur instanceof Error) {
      const code = (cur as NodeJS.ErrnoException).code;
      parts.push(`${cur.name}${code ? `[${code}]` : ""}: ${cur.message}`);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" <- ");
}

/**
 * How long a pause has left, e.g. "42s" / "3 min". A wait, not a wall-clock
 * time: this string is shown on the viewer's dome and the server has no idea
 * which timezone that viewer is in (it used to be formatted in America/Chicago
 * for everyone).
 */
function waitLabel(untilMs: number): string {
  const seconds = Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
  return seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;
}

/** A successful read: project this cell's aircraft for THIS observer. */
function live(observer: Observer, aircraft: AdsbAircraft[]): PlaneResult {
  const planes = parseAircraft(aircraft, observer);
  return {
    planes,
    status: { ok: true, count: planes.length, mode: "live", message: null },
  };
}

function staleOrEmpty(
  observer: Observer,
  key: string,
  message: string
): PlaneResult {
  const snapshot = snapshots.get(key);
  if (snapshot && Date.now() - snapshot.fetchedAt < PLANES_STALE_MAX_MS) {
    const planes = parseAircraft(snapshot.aircraft, observer);
    return {
      planes,
      status: {
        ok: false,
        count: planes.length,
        mode: "live",
        message: `${message} — showing planes from ${Math.round((Date.now() - snapshot.fetchedAt) / 1000)}s ago`,
      },
    };
  }
  return {
    planes: [],
    status: { ok: false, count: 0, mode: "live", message },
  };
}

export async function getPlanes(observer: Observer): Promise<PlaneResult> {
  const key = snapshotKey(observer);

  // Fresh snapshot for this cell: serve it (co-located viewers share one
  // upstream call), projected from this observer's own position.
  const snapshot = snapshots.get(key);
  if (snapshot && Date.now() - snapshot.fetchedAt < PLANES_SNAPSHOT_TTL_MS) {
    return live(observer, snapshot.aircraft);
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchAircraft(observer, key).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
  }
  const outcome = await pending;
  return outcome.kind === "aircraft"
    ? live(observer, outcome.aircraft)
    : staleOrEmpty(observer, key, outcome.message);
}

async function fetchAircraft(
  observer: Observer,
  key: string
): Promise<FetchOutcome> {
  if (Date.now() < backoffUntil) {
    return {
      kind: "failure",
      message: `${backoffReason} — retrying in ${waitLabel(backoffUntil)}`,
    };
  }
  if (upstreamBudgetSpent()) {
    console.warn(
      `[sky] plane fetch skipped: upstream budget of ${PLANES_UPSTREAM_MAX_PER_MIN}/min spent`
    );
    return {
      kind: "failure",
      message: "plane feed busy — too many distinct locations this minute",
    };
  }

  const url = planesUrl(observer);
  const host = new URL(url).hostname;
  let status: number | null = null;
  try {
    upstreamFetches.push(Date.now());
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    status = res.status;

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const waitMs = Math.max(
        Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
        PLANES_BACKOFF_MS
      );
      backoffUntil = Date.now() + waitMs;
      backoffReason = `${host} rate limit hit — planes paused`;
      console.warn(
        `[sky] plane fetch failed: HTTP 429 from ${host}, backing off until ${new Date(backoffUntil).toISOString()}`
      );
      return {
        kind: "failure",
        message: `${backoffReason} — retrying in ${waitLabel(backoffUntil)}`,
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // airplanes.live/adsb.one name the array `ac`; adsb.fi names it `aircraft`.
    const body = (await res.json()) as { ac?: AdsbAircraft[]; aircraft?: AdsbAircraft[] };
    const aircraft = body.ac ?? body.aircraft ?? [];
    storeSnapshot(key, aircraft);
    // Deliberately no coordinates and no cell key: server logs are not a place
    // to keep anyone's location, and a grid cell is still a ~1 km bucket. The
    // cache size is the useful non-identifying signal; per-viewer counts (after
    // the PLANE_MIN_ALT_DEG horizon cut) travel in status.count instead.
    console.log(
      `[sky] planes: ${aircraft.length} aircraft within ${PLANE_RADIUS_NM} nm (${host}, ${snapshots.size} cell${snapshots.size === 1 ? "" : "s"} cached)`
    );
    return { kind: "aircraft", aircraft };
  } catch (e) {
    const detail = describeError(e);
    console.warn(`[sky] plane fetch failed: ${detail} (${host}, status ${status ?? "n/a"})`);
    return { kind: "failure", message: `plane feed unreachable (${detail})` };
  }
}
