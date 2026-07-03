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
 * A module-level snapshot cache (TTL just under the client poll interval)
 * means any number of viewers costs one upstream call per ~10s per warm
 * lambda — polite to a free community API. On a 429 we back off (honoring
 * Retry-After) and serve a recent snapshot for up to PLANES_STALE_MAX_MS
 * before degrading to satellites-only.
 */

import {
  OBSERVER,
  PLANE_MIN_ALT_DEG,
  PLANE_RADIUS_NM,
  PLANES_BACKOFF_MS,
  PLANES_SNAPSHOT_TTL_MS,
  PLANES_STALE_MAX_MS,
  USER_AGENT,
} from "./config";
import { observerAzAlt } from "./geo";
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
 */
export function planesUrl(): string {
  const base = (process.env.PLANES_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
  const lat = OBSERVER.lat.toFixed(5);
  const lon = OBSERVER.lon.toFixed(5);
  if (new URL(base).hostname.endsWith("adsb.fi")) {
    return `${base}/v2/lat/${lat}/lon/${lon}/dist/${PLANE_RADIUS_NM}`;
  }
  return `${base}/v2/point/${lat}/${lon}/${PLANE_RADIUS_NM}`;
}

// Module state (persists per warm serverless instance).
let snapshot: {
  planes: PlaneObject[];
  fetchedAt: number;
} | null = null;
let backoffUntil = 0;
let backoffReason = "";
let inflight: Promise<PlaneResult> | null = null;

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

/** Exported for offline tests against a saved v2 point-query sample. */
export function parseAircraft(list: AdsbAircraft[] | null | undefined): PlaneObject[] {
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

    const { az, alt, groundM } = observerAzAlt(a.lat, a.lon, altitudeM);
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

function chicagoTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function staleOrEmpty(message: string): PlaneResult {
  if (snapshot && Date.now() - snapshot.fetchedAt < PLANES_STALE_MAX_MS) {
    return {
      planes: snapshot.planes,
      status: {
        ok: false,
        count: snapshot.planes.length,
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

export async function getPlanes(): Promise<PlaneResult> {
  // Fresh snapshot: serve it (many clients share one upstream call).
  if (snapshot && Date.now() - snapshot.fetchedAt < PLANES_SNAPSHOT_TTL_MS) {
    return {
      planes: snapshot.planes,
      status: { ok: true, count: snapshot.planes.length, mode: "live", message: null },
    };
  }
  if (inflight) return inflight;
  inflight = fetchPlanes().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchPlanes(): Promise<PlaneResult> {
  if (Date.now() < backoffUntil) {
    return staleOrEmpty(`${backoffReason} — retrying at ${chicagoTime(backoffUntil)}`);
  }

  const url = planesUrl();
  const host = new URL(url).hostname;
  let status: number | null = null;
  try {
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
        `[sky] plane fetch failed: HTTP 429 from ${host}, backing off until ${chicagoTime(backoffUntil)}`
      );
      return staleOrEmpty(`${backoffReason} until ${chicagoTime(backoffUntil)}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // airplanes.live/adsb.one name the array `ac`; adsb.fi names it `aircraft`.
    const body = (await res.json()) as { ac?: AdsbAircraft[]; aircraft?: AdsbAircraft[] };
    const planes = parseAircraft(body.ac ?? body.aircraft);
    snapshot = { planes, fetchedAt: Date.now() };
    console.log(
      `[sky] planes: ${planes.length} aircraft above ${PLANE_MIN_ALT_DEG} deg within ${PLANE_RADIUS_NM} nm (${host})`
    );
    return {
      planes,
      status: { ok: true, count: planes.length, mode: "live", message: null },
    };
  } catch (e) {
    const detail = describeError(e);
    console.warn(`[sky] plane fetch failed: ${detail} (${host}, status ${status ?? "n/a"})`);
    return staleOrEmpty(`plane feed unreachable (${detail})`);
  }
}
