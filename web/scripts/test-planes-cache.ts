/**
 * Self-test for the per-observer plane snapshot cache.
 * Run from web/:  npx tsx scripts/test-planes-cache.ts
 * Exits non-zero on any failure. Makes NO network calls — global fetch is
 * stubbed with a synthetic ADS-B response, so this is safe to run repeatedly
 * and never touches the free community API.
 *
 * What matters here (see DECISIONS.md §13): the snapshot cache is shared
 * between viewers, so it must hold RAW upstream aircraft and project them per
 * observer. If it ever caches finished PlaneObjects again, one viewer's dome
 * would show another viewer's azimuths — the exact bug these assertions pin
 * down.
 */

import { PLANES_CACHE_MAX_ENTRIES, PLANES_UPSTREAM_MAX_PER_MIN } from "../lib/config";
import type { Observer } from "../lib/observer";
import { getPlanes } from "../lib/planes";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Two synthetic aircraft at 36 000 ft on the meridian of VIEWER_1, one nearly
// overhead and one 45 km south. The near one is the interesting fixture: a few
// hundred meters of viewer displacement swings its azimuth by tens of degrees,
// which is what makes "was this projected for ME?" testable inside a single
// ~1 km cache cell.
const AIRCRAFT = [
  { hex: "aaa111", flight: "TEST1", lat: 41.905, lon: -87.6042, alt_geom: 36000, gs: 450, track: 90, category: "A3" },
  { hex: "bbb222", flight: "TEST2", lat: 41.5, lon: -87.6042, alt_geom: 36000, gs: 450, track: 270, category: "A3" },
];

// Both sit in the same PLANES_CACHE_GRID_DEG cell (round(lon/0.01) = -8760),
// ~700 m apart — co-located enough to share an upstream call, far enough apart
// that the near aircraft's azimuth from each differs enormously.
const VIEWER_1 = { lat: 41.9, lon: -87.6042 };
const VIEWER_2 = { lat: 41.9, lon: -87.5958 };

let fetches = 0;
let lastUrl = "";
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetches++;
  lastUrl = String(input);
  return new Response(JSON.stringify({ ac: AIRCRAFT }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const observer = (lat: number, lon: number, elevationM = 0): Observer => ({ lat, lon, elevationM });

// A budget guard: this test must stay inside the upstream ceiling, or its own
// later assertions would be measuring the rate limiter instead of the cache.
// Four fetches for the geometry sections, then one per cell for the eviction
// section, which is sized off the cap.
const PLANNED_FETCHES = 4 + PLANES_CACHE_MAX_ENTRIES + 2;
if (PLANNED_FETCHES >= PLANES_UPSTREAM_MAX_PER_MIN) {
  console.error(
    `This test plans ${PLANNED_FETCHES} fetches but PLANES_UPSTREAM_MAX_PER_MIN is ${PLANES_UPSTREAM_MAX_PER_MIN}.`
  );
  process.exit(1);
}

// tsx transpiles this to CJS, where top-level await is unavailable.
async function main(): Promise<void> {
  // --- 1. The query is centred on the requesting observer -----------------------
  let viewer1Az = NaN;
  {
    const a = await getPlanes(observer(VIEWER_1.lat, VIEWER_1.lon));
    check("first request fetches upstream", fetches === 1, `${fetches} fetches`);
    check("query is centred on the caller", lastUrl.includes("41.90000/-87.60420"), lastUrl);
    check("aircraft are projected for the caller", a.planes.length === 2, `${a.planes.length} planes`);
    const near = a.planes.find((p) => p.icao24 === "aaa111")!;
    viewer1Az = near.az;
    check("aircraft due north of viewer 1 reads az~0", near.az < 1 || near.az > 359, `az=${near.az}`);
    check("and sits nearly overhead", near.alt > 80, `alt=${near.alt}`);
  }

  // --- 2. Same cell shares the fetch but NOT the projection ---------------------
  {
    const before = fetches;
    const b = await getPlanes(observer(VIEWER_2.lat, VIEWER_2.lon));
    check("a co-located viewer reuses the snapshot", fetches === before, `${fetches - before} extra fetches`);
    const near = b.planes.find((p) => p.icao24 === "aaa111")!;
    // Viewer 2 stands ~700 m east, so the same aircraft is off to its
    // north-WEST. A cache of finished PlaneObjects would have handed back
    // viewer 1's az~0 instead.
    const swing = Math.abs(((near.az - viewer1Az + 540) % 360) - 180);
    check(
      "shared snapshot is re-projected for the second viewer",
      swing > 30,
      `viewer 1 az=${viewer1Az}, viewer 2 az=${near.az} (swing ${swing.toFixed(1)}°)`
    );
  }

  // --- 3. A distant viewer never sees the first viewer's sky --------------------
  {
    const before = fetches;
    const nyc = await getPlanes(observer(40.7128, -74.006));
    check("a distant viewer triggers its own fetch", fetches === before + 1, `${fetches - before} fetches`);
    check("query re-centred on the distant viewer", lastUrl.includes("40.71280/-74.00600"), lastUrl);
    // Chicago-area aircraft are ~1150 km west of New York: far below the horizon,
    // so the PLANE_MIN_ALT_DEG cut must drop both.
    check(
      "aircraft below the distant viewer's horizon are dropped",
      nyc.planes.length === 0,
      `${nyc.planes.length} planes still visible`
    );
  }

  // --- 4. Concurrent requests for one cell collapse into one fetch -------------
  {
    const before = fetches;
    const [x, y] = await Promise.all([
      getPlanes(observer(35.6895, 139.6917)),
      getPlanes(observer(35.6899, 139.6919)),
    ]);
    check("concurrent same-cell requests share one fetch", fetches === before + 1, `${fetches - before} fetches`);
    check("both concurrent callers get a result", !!x.status && !!y.status);
  }

  // --- 5. The cache is bounded, evicting the stalest cell ----------------------
  {
    // Enough fresh cells to guarantee the cap is exceeded whatever it is set to,
    // so this assertion cannot rot when PLANES_CACHE_MAX_ENTRIES changes.
    const spread = Array.from({ length: PLANES_CACHE_MAX_ENTRIES + 1 }, (_, i) =>
      observer(-80 + i * 3, -170 + i * 7)
    );
    for (const o of spread) await getPlanes(o);

    const newest = spread[spread.length - 1];
    const before = fetches;
    await getPlanes(newest); // most recently fetched cell: still cached
    check("the newest cell is still a cache hit", fetches === before, `${fetches - before} fetches`);

    const beforeOldest = fetches;
    await getPlanes(observer(VIEWER_1.lat, VIEWER_1.lon)); // the very first cell
    check(
      `the stalest cell was evicted past the ${PLANES_CACHE_MAX_ENTRIES}-entry cap`,
      fetches === beforeOldest + 1,
      `${fetches - beforeOldest} fetches (expected a miss)`
    );
  }

  console.log(`\n${fetches} upstream fetches simulated (ceiling ${PLANES_UPSTREAM_MAX_PER_MIN}/min).`);

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("All plane-cache tests passed.");
}

void main();
