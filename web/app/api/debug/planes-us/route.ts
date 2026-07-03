/**
 * TEMPORARY: same probe as /api/debug/planes but with NO region pin, so it
 * runs in Vercel's default US region (typically iad1). The candidate hosts
 * are US-friendly community aggregators, so this tells us whether dropping
 * the fra1 pin is the better choice. Delete once the swap ships.
 */
import { NextResponse } from "next/server";
import { probePlaneHosts } from "@/lib/planes-probe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  return NextResponse.json(await probePlaneHosts(), {
    headers: { "cache-control": "no-store" },
  });
}
