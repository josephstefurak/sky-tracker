/**
 * TEMPORARY: ADS-B aggregator reachability probe, pinned to fra1 like the
 * existing /api/sky and /api/debug/opensky routes. Compare against
 * /api/debug/planes-us (unpinned) before choosing the replacement host.
 * See lib/planes-probe.ts for details. Delete once the swap ships.
 */
import { NextResponse } from "next/server";
import { probePlaneHosts } from "@/lib/planes-probe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "fra1";
export const maxDuration = 30;

export async function GET() {
  return NextResponse.json(await probePlaneHosts(), {
    headers: { "cache-control": "no-store" },
  });
}
