/**
 * Flight-route and aircraft enrichment via adsbdb (free, no auth).
 *
 * Serverless adaptation of the legacy fire-and-forget route_cache: background
 * tasks don't outlive a serverless response, so each /api/sky request instead
 * awaits AT MOST ADSBDB_MAX_LOOKUPS_PER_REQUEST uncached lookups inline (short
 * timeout, highest-elevation planes first) and the module-level cache warms
 * over successive polls. Positive entries are kept for the lambda's lifetime;
 * negative ones expire after ADSBDB_NEGATIVE_TTL_MS; transient errors are not
 * cached. Cold starts lose the cache — accepted tradeoff (see DECISIONS.md).
 */

import {
  ADSBDB_MAX_LOOKUPS_PER_REQUEST,
  ADSBDB_NEGATIVE_TTL_MS,
  ADSBDB_TIMEOUT_MS,
  USER_AGENT,
} from "./config";
import type { PlaneObject } from "./types";

interface RouteInfo {
  origin: string | null;
  destination: string | null;
  originName: string | null;
  destinationName: string | null;
  airline: string | null;
}

interface AircraftInfo {
  aircraftType: string | null;
  operator: string | null;
  photoUrl: string | null;
}

type Cached<T> = { value: T } | { negative: true; at: number };

const routeCache = new Map<string, Cached<RouteInfo>>(); // key: CALLSIGN
const aircraftCache = new Map<string, Cached<AircraftInfo>>(); // key: icao24
const inflight = new Set<string>();

/**
 * Cap on each cache. Until the observer became per-user these Maps were
 * self-limiting: the only keys that could ever appear were the airframes and
 * callsigns passing within 25 nm of one fixed point. The key space is now
 * wherever viewers point the dome, i.e. worldwide, so an explicit bound
 * replaces the geography that used to provide one. Generous enough that a real
 * viewing session never evicts (a busy 25 nm circle holds ~100 aircraft).
 */
const ENRICH_CACHE_MAX_ENTRIES = 2_000;

/** Insert, dropping the oldest insertions once past the cap. Map iteration is
 *  insertion-ordered, so the first keys are the oldest. */
function remember<T>(cache: Map<string, Cached<T>>, key: string, value: Cached<T>): void {
  cache.set(key, value);
  while (cache.size > ENRICH_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

const CALLSIGN_RE = /^[A-Z0-9]{3,8}$/;

function fresh<T>(entry: Cached<T> | undefined): { value: T } | null {
  if (!entry) return null;
  if ("negative" in entry) return null;
  return entry;
}

function needsLookup<T>(entry: Cached<T> | undefined): boolean {
  if (!entry) return true;
  if ("negative" in entry) return Date.now() - entry.at > ADSBDB_NEGATIVE_TTL_MS;
  return false;
}

async function fetchAdsbdb(url: string): Promise<{ kind: "hit"; body: unknown } | { kind: "miss" } | { kind: "error" }> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(ADSBDB_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status === 404) return { kind: "miss" };
    if (!res.ok) {
      console.warn(`[sky] adsbdb ${url.split("/v0/")[1]}: HTTP ${res.status}`);
      return { kind: "error" };
    }
    const body = (await res.json()) as { response?: unknown };
    if (typeof body.response === "string") return { kind: "miss" }; // "unknown callsign"/"unknown aircraft"
    return { kind: "hit", body: body.response };
  } catch (e) {
    const err = e as Error;
    console.warn(`[sky] adsbdb lookup failed: ${err.name}: ${err.message}`);
    return { kind: "error" };
  }
}

async function lookupRoute(callsign: string): Promise<void> {
  const key = `route:${callsign}`;
  inflight.add(key);
  try {
    const res = await fetchAdsbdb(`https://api.adsbdb.com/v0/callsign/${callsign}`);
    if (res.kind === "miss") {
      remember(routeCache, callsign, { negative: true, at: Date.now() });
      return;
    }
    if (res.kind === "error") return; // transient: retry on a later poll
    const fr = (res.body as { flightroute?: Record<string, any> }).flightroute;
    if (!fr) {
      remember(routeCache, callsign, { negative: true, at: Date.now() });
      return;
    }
    remember(routeCache, callsign, {
      value: {
        origin: fr.origin?.iata_code ?? null,
        destination: fr.destination?.iata_code ?? null,
        originName: fr.origin?.municipality ?? null,
        destinationName: fr.destination?.municipality ?? null,
        airline: fr.airline?.name ?? null,
      },
    });
  } finally {
    inflight.delete(key);
  }
}

async function lookupAircraft(icao24: string): Promise<void> {
  const key = `aircraft:${icao24}`;
  inflight.add(key);
  try {
    const res = await fetchAdsbdb(`https://api.adsbdb.com/v0/aircraft/${icao24}`);
    if (res.kind === "miss") {
      remember(aircraftCache, icao24, { negative: true, at: Date.now() });
      return;
    }
    if (res.kind === "error") return;
    const ac = (res.body as { aircraft?: Record<string, any> }).aircraft;
    if (!ac) {
      remember(aircraftCache, icao24, { negative: true, at: Date.now() });
      return;
    }
    const aircraftType = [ac.manufacturer, ac.type].filter(Boolean).join(" ").trim() || null;
    remember(aircraftCache, icao24, {
      value: {
        aircraftType,
        operator: ac.registered_owner ?? null,
        photoUrl: ac.url_photo_thumbnail ?? null,
      },
    });
  } finally {
    inflight.delete(key);
  }
}

function applyCaches(plane: PlaneObject): void {
  const cs = plane.callsign.toUpperCase();
  const route = fresh(routeCache.get(cs));
  if (route) {
    plane.origin = route.value.origin;
    plane.destination = route.value.destination;
    plane.originName = route.value.originName;
    plane.destinationName = route.value.destinationName;
    plane.airline = route.value.airline;
  }
  const ac = fresh(aircraftCache.get(plane.icao24));
  if (ac) {
    plane.aircraftType = ac.value.aircraftType;
    plane.operator = ac.value.operator;
    plane.photoUrl = ac.value.photoUrl;
  }
}

/** Enrich planes in place. Awaits a bounded number of uncached lookups. */
export async function enrichPlanes(planes: PlaneObject[]): Promise<void> {
  const tasks: Promise<void>[] = [];
  const byAltDesc = [...planes].sort((a, b) => b.alt - a.alt);

  for (const plane of byAltDesc) {
    if (tasks.length >= ADSBDB_MAX_LOOKUPS_PER_REQUEST) break;
    const cs = plane.callsign.toUpperCase();
    if (
      CALLSIGN_RE.test(cs) &&
      needsLookup(routeCache.get(cs)) &&
      !inflight.has(`route:${cs}`)
    ) {
      tasks.push(lookupRoute(cs));
    }
    if (tasks.length >= ADSBDB_MAX_LOOKUPS_PER_REQUEST) break;
    if (
      plane.icao24 &&
      needsLookup(aircraftCache.get(plane.icao24)) &&
      !inflight.has(`aircraft:${plane.icao24}`)
    ) {
      tasks.push(lookupAircraft(plane.icao24));
    }
  }

  if (tasks.length) await Promise.allSettled(tasks);
  for (const plane of planes) applyCaches(plane);
}
