/**
 * TEMPORARY debug endpoint for diagnosing OpenSky auth failures on Vercel.
 * Reports which mode resolveMode() picks, masked env-var presence, and — for
 * BOTH OpenSky hosts (auth.opensky-network.org and opensky-network.org) —
 * DNS resolution plus a live connectivity probe. Never exposes secret values
 * or the issued token. Delete once the incident is resolved.
 *
 * How to read the output:
 *   - `region` must say "fra1"; if it doesn't, the preferredRegion pin below
 *     did not apply and any conclusion about fra1 is untested.
 *   - `states.probe.reachable` true while `auth.probe.reachable` is false is
 *     the signal that anonymous mode works where oauth2 cannot (the states
 *     host never touches the auth server). `verdict` spells this out.
 *
 * NOTE: the states probe is a real anonymous states/all call and spends one
 * OpenSky credit per hit — fine for a manually-poked debug endpoint.
 */
import { promises as dns } from "node:dns";
import { NextResponse } from "next/server";
import { USER_AGENT } from "@/lib/config";
import { STATES_URL, TOKEN_URL, describeError, openskyEnvDebug } from "@/lib/opensky";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "fra1";
// Two 8s probes run in parallel; keep headroom over the legacy 10s default.
export const maxDuration = 30;

async function dnsReport(host: string) {
  const [a, aaaa] = await Promise.all([
    dns.resolve4(host).catch((e) => `error: ${describeError(e)}`),
    dns.resolve6(host).catch((e) => `error: ${describeError(e)}`),
  ]);
  return { host, a, aaaa };
}

/** Live probe of the client-credentials grant. Runs even without credentials
 *  (expect HTTP 401) so it still exercises the network path on Preview
 *  deploys where OPENSKY_CLIENT_ID isn't scoped. */
async function probeAuth(): Promise<Record<string, unknown>> {
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
    // Any HTTP status means TCP+TLS+HTTP worked — even a 401 proves the host
    // is reachable; `reachable` is about the network path, not auth success.
    probe.reachable = true;
    probe.status = res.status;
    probe.gotToken = res.ok && text.includes("access_token");
    if (!res.ok) probe.bodyPreview = text.slice(0, 200);
  } catch (e) {
    probe.reachable = false;
    probe.error = describeError(e);
  }
  probe.ms = Date.now() - started;
  return probe;
}

/** Anonymous probe of the states host — deliberately no Authorization header,
 *  so it succeeds or fails independent of the auth server. */
async function probeStates(): Promise<Record<string, unknown>> {
  const probe: Record<string, unknown> = { url: STATES_URL };
  const started = Date.now();
  try {
    const res = await fetch(STATES_URL, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    probe.reachable = true;
    probe.status = res.status;
    probe.creditsRemaining = res.headers.get("x-rate-limit-remaining");
    if (res.ok) {
      await res.body?.cancel();
    } else {
      probe.bodyPreview = (await res.text()).slice(0, 200);
    }
  } catch (e) {
    probe.reachable = false;
    probe.error = describeError(e);
  }
  probe.ms = Date.now() - started;
  return probe;
}

function verdictFor(authReachable: boolean, statesReachable: boolean): string {
  if (authReachable && statesReachable)
    return "both hosts reachable — oauth2 should work from here; if /api/sky still fails, the block is intermittent (the token retry loop should ride it out) or the problem is elsewhere";
  if (!authReachable && statesReachable)
    return "states host reachable while auth host is NOT — anonymous mode is viable (400 credits/day); lib/opensky.ts falls back to it automatically";
  if (!authReachable && !statesReachable)
    return "BOTH hosts unreachable from this region — OpenSky is blocking this datacenter entirely; no purely-internal fix exists";
  return "auth host reachable but states host is not — unusual; recheck the states URL/bbox";
}

export async function GET() {
  const authHost = new URL(TOKEN_URL).hostname;
  const statesHost = new URL(STATES_URL).hostname;

  const [authDns, statesDns, authProbe, statesProbe] = await Promise.all([
    dnsReport(authHost),
    dnsReport(statesHost),
    probeAuth(),
    probeStates(),
  ]);

  return NextResponse.json(
    {
      vercelEnv: process.env.VERCEL_ENV ?? null, // "production" | "preview" | null (local)
      region: process.env.VERCEL_REGION ?? null, // must report "fra1" for the pin to be proven
      node: process.version,
      env: openskyEnvDebug(),
      auth: { dns: authDns, probe: authProbe },
      states: { dns: statesDns, probe: statesProbe },
      verdict: verdictFor(
        authProbe.reachable === true,
        statesProbe.reachable === true
      ),
    },
    { headers: { "cache-control": "no-store" } }
  );
}
