import { NextResponse } from "next/server";
import { computeAstro, sunEquatorial, sunPosition } from "@/lib/astro";
import { OBSERVER } from "@/lib/config";
import { enrichPlanes } from "@/lib/enrich";
import { getPlanes } from "@/lib/opensky";
import { computeSatellites } from "@/lib/satellites";
import { getTleSet } from "@/lib/tle";
import type { SkyResponse, SkyStatus } from "@/lib/types";

// Live sky on every hit; never statically cached.
export const dynamic = "force-dynamic";

type SatStatus = SkyStatus["satellites"];

export async function GET() {
  const now = new Date();
  const astro = computeAstro(now, OBSERVER.lat, OBSERVER.lon);
  const sun = sunEquatorial(now);
  const sunAlt = sunPosition(now, OBSERVER.lat, OBSERVER.lon).alt;

  const [sats, planesResult] = await Promise.all([
    (async () => {
      try {
        const tle = await getTleSet();
        const objects = computeSatellites(tle.records, now, sun.unit, sunAlt);
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
    getPlanes().catch((e: Error) => {
      // getPlanes handles its own failures; this is a belt-and-braces catch.
      console.warn(`[sky] plane pipeline failed: ${e.name}: ${e.message}`);
      return {
        planes: [],
        status: {
          ok: false,
          count: 0,
          mode: "disabled" as const,
          message: `plane pipeline failed (${e.name}: ${e.message})`,
          creditsRemaining: null,
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
    objects: [...sats.objects, ...planesResult.planes],
    astro,
    status: { satellites: sats.status, planes: planesResult.status },
  };

  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
