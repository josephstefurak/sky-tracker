/**
 * TEMPORARY debug endpoint for diagnosing OpenSky auth failures on Vercel.
 * Reports which mode resolveMode() picks, masked env-var presence, DNS
 * resolution of the auth host, and a live token-grant probe. Never exposes
 * secret values or the issued token. Delete once the incident is resolved.
 */
import { promises as dns } from "node:dns";
import { NextResponse } from "next/server";
import { USER_AGENT } from "@/lib/config";
import { TOKEN_URL, describeError, openskyEnvDebug } from "@/lib/opensky";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const host = new URL(TOKEN_URL).hostname;

  const [a, aaaa] = await Promise.all([
    dns.resolve4(host).catch((e) => `error: ${describeError(e)}`),
    dns.resolve6(host).catch((e) => `error: ${describeError(e)}`),
  ]);

  // Live probe of the client-credentials grant. Runs even without credentials
  // (expect HTTP 401) so it still exercises the network path on Preview
  // deploys where OPENSKY_CLIENT_ID isn't scoped.
  const id = process.env.OPENSKY_CLIENT_ID?.trim();
  const secret = process.env.OPENSKY_CLIENT_SECRET?.trim();
  const probe: Record<string, unknown> = { url: TOKEN_URL, usedCredentials: Boolean(id && secret) };
  const started = Date.now();
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: id ?? "sky-tracker-debug-no-id",
        client_secret: secret ?? "none",
      }),
      // Shorter than the 10s undici connect timeout AND Vercel's default
      // function duration, so we get a clean TimeoutError instead of a killed
      // function if the host blackholes us.
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const text = await res.text();
    probe.status = res.status;
    probe.gotToken = res.ok && text.includes("access_token");
    if (!res.ok) probe.bodyPreview = text.slice(0, 200);
  } catch (e) {
    probe.error = describeError(e);
  }
  probe.ms = Date.now() - started;

  return NextResponse.json(
    {
      vercelEnv: process.env.VERCEL_ENV ?? null, // "production" | "preview" | null (local)
      region: process.env.VERCEL_REGION ?? null,
      node: process.version,
      env: openskyEnvDebug(),
      dns: { host, a, aaaa },
      probe,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
