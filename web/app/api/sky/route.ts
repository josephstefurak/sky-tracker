import { NextResponse } from "next/server";
import { computeAstro, sunEquatorial, sunPosition } from "@/lib/astro";
import { enrichPlanes } from "@/lib/enrich";
import { DEFAULT_OBSERVER, observerFrom, type Observer } from "@/lib/observer";
import { getPlanes } from "@/lib/planes";
import { computeSatellites } from "@/lib/satellites";
import { getTleSet } from "@/lib/tle";
import type { SkyResponse, SkyStatus } from "@/lib/types";

// Live sky on every hit; never statically cached.
export const dynamic = "force-dynamic";
// No region pin: the ADS-B aggregator and adsbdb are US-hosted, so Vercel's
// default US region beats the old fra1 pin (which existed for OpenSky).
// Worst case: one 10s plane fetch plus bounded enrichment lookups.
export const maxDuration = 30;

type SatStatus = SkyStatus["satellites"];

/**
 * Who this request is looking up from: `?lat=&lon=` (+ optional `&elev=`,
 * meters MSL). Anything missing, unparseable or out of range falls back to the
 * default observer — this endpoint must never 500 on bad input, and a garbage
 * coordinate must never reach the upstream ADS-B query. Validation is the same
 * code the browser uses before it ever sends the values (lib/observer.ts).
 *
 * Query params rather than a POST body: the observer is a *read* parameter, it
 * keeps /api/sky a plain GET that is trivial to try by hand or to cache by URL
 * if that is ever wanted, and it survives the client's no-store polling.
 */
function observerForRequest(url: URL): { observer: Observer; invalid: boolean } {
  const params = url.searchParams;
  if (!params.has("lat") && !params.has("lon")) {
    return { observer: DEFAULT_OBSERVER, invalid: false };
  }
  const parsed = observerFrom(
    params.get("lat"),
    params.get("lon"),
    params.get("elev")
  );
  return parsed
    ? { observer: parsed, invalid: false }
    : { observer: DEFAULT_OBSERVER, invalid: true };
}

export async function GET(request: Request) {
  const now = new Date();
  const { observer, invalid } = observerForRequest(new URL(request.url));
  if (invalid) {
    // The values themselves are deliberately not logged: coordinates are the
    // caller's location, and logs are not the place to keep it.
    console.warn("[sky] rejected invalid lat/lon — using the default observer");
  }

  const astro = computeAstro(now, observer.lat, observer.lon);
  const sun = sunEquatorial(now);
  const sunAlt = sunPosition(now, observer.lat, observer.lon).alt;

  const [sats, planesResult] = await Promise.all([
    (async () => {
      try {
        const tle = await getTleSet();
        const objects = computeSatellites(
          tle.records,
          now,
          sun.unit,
          sunAlt,
          observer
        );
        const status: SatStatus = {
          ok: tle.records.length > 0,
          count: objects.length,
          tleAgeHours: tle.tleAgeHours,
          message: tle.message,
        };
        return { objects, status };
      } catch (e) {
        const err = e as Error;
        console.warn(`[sky] satellite pipeline failed: ${err.name}: ${err.message}`);
        const status: SatStatus = {
          ok: false,
          count: 0,
          tleAgeHours: null,
          message: `satellite pipeline failed (${err.name}: ${err.message})`,
        };
        return { objects: [], status };
      }
    })(),
    getPlanes(observer).catch((e: Error) => {
      // getPlanes handles its own failures; this is a belt-and-braces catch.
      console.warn(`[sky] plane pipeline failed: ${e.name}: ${e.message}`);
      return {
        planes: [],
        status: {
          ok: false,
          count: 0,
          mode: "disabled" as const,
          message: `plane pipeline failed (${e.name}: ${e.message})`,
        },
      };
    }),
  ]);

  try {
    await enrichPlanes(planesResult.planes);
  } catch (e) {
    const err = e as Error;
    console.warn(`[sky] enrichment failed: ${err.name}: ${err.message}`);
  }

  const body: SkyResponse = {
    ts: Math.floor(Date.now() / 1000),
    // Echoed back so the client can confirm which sky it is actually looking
    // at (and see when its coordinates were rejected in favour of the default).
    observer,
    objects: [...sats.objects, ...planesResult.planes],
    astro,
    status: { satellites: sats.status, planes: planesResult.status },
  };

  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
