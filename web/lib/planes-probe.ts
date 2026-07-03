/**
 * TEMPORARY reachability probe for candidate ADS-B aggregators, all of which
 * speak the ADSBExchange v2 response shape. OpenSky is hard-blocked from
 * Vercel's datacenter IPs (confirmed via /api/debug/opensky — both hostnames
 * time out at the connect stage), so we're picking a replacement host.
 *
 * Shared by two debug routes that differ only in region pinning:
 *   /api/debug/planes    — preferredRegion "fra1" (matches the current pin)
 *   /api/debug/planes-us — no pin (Vercel default US region); these are
 *                          US-community hosts, so fra1 may not be optimal
 * Compare `region` in each response to confirm where the probe actually ran.
 *
 * One request per host, run in parallel across hosts (never against the same
 * host — adsb.fi 429s a second request within seconds). Delete after the swap.
 */
import { promises as dns } from "node:dns";
import { OBSERVER, USER_AGENT } from "./config";
import { describeError } from "./opensky";

/** Probe radius in nautical miles (all three APIs take nm). */
const PROBE_RADIUS_NM = 25;

const lat = OBSERVER.lat.toFixed(5);
const lon = OBSERVER.lon.toFixed(5);

const HOSTS = [
  {
    name: "airplanes.live",
    url: `https://api.airplanes.live/v2/point/${lat}/${lon}/${PROBE_RADIUS_NM}`,
  },
  {
    name: "adsb.fi",
    // Path verified against live API 2026-07-03; note adsb.fi returns
    // `{aircraft: [...]}` where the other two return `{ac: [...]}`.
    url: `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${PROBE_RADIUS_NM}`,
  },
  {
    name: "adsb.one",
    url: `https://api.adsb.one/v2/point/${lat}/${lon}/${PROBE_RADIUS_NM}`,
  },
] as const;

interface HostReport {
  name: string;
  url: string;
  dns: { a: string[] | string; aaaa: string[] | string };
  /** Any HTTP status counts as reachable — a network path exists. */
  reachable: boolean;
  status: number | null;
  ms: number;
  aircraftCount: number | null;
  error: string | null;
  bodyPreview: string | null;
}

async function dnsReport(hostname: string) {
  const [a, aaaa] = await Promise.all([
    dns.resolve4(hostname).catch((e) => `error: ${describeError(e)}`),
    dns.resolve6(hostname).catch((e) => `error: ${describeError(e)}`),
  ]);
  return { a, aaaa };
}

async function probeHost(host: (typeof HOSTS)[number]): Promise<HostReport> {
  const report: HostReport = {
    name: host.name,
    url: host.url,
    dns: await dnsReport(new URL(host.url).hostname),
    reachable: false,
    status: null,
    ms: 0,
    aircraftCount: null,
    error: null,
    bodyPreview: null,
  };
  const started = Date.now();
  try {
    const res = await fetch(host.url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    report.reachable = true;
    report.status = res.status;
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { ac?: unknown[]; aircraft?: unknown[] };
      const list = body.ac ?? body.aircraft;
      report.aircraftCount = Array.isArray(list) ? list.length : null;
    } catch {
      /* non-JSON body (e.g. an HTML error page) — preview below tells the story */
    }
    if (!res.ok || report.aircraftCount == null) report.bodyPreview = text.slice(0, 200);
  } catch (e) {
    report.error = describeError(e);
  }
  report.ms = Date.now() - started;
  return report;
}

export async function probePlaneHosts() {
  const hosts = await Promise.all(HOSTS.map(probeHost));
  const up = hosts
    .filter((h) => h.reachable && h.status === 200 && h.aircraftCount != null)
    .sort((a, b) => a.ms - b.ms);
  const down = hosts.filter((h) => !up.includes(h));

  let verdict: string;
  if (up.length === 0) {
    verdict =
      "no candidate host returned aircraft data from this region — check the per-host errors, and compare /api/debug/planes (fra1) vs /api/debug/planes-us (default US)";
  } else {
    verdict =
      `reachable with data: ${up.map((h) => `${h.name} (${h.ms}ms, ${h.aircraftCount} aircraft)`).join(", ")}` +
      ` — fastest is ${up[0].name}` +
      (down.length ? `; not usable: ${down.map((h) => `${h.name} (${h.error ?? `HTTP ${h.status}`})`).join(", ")}` : "");
  }

  return {
    vercelEnv: process.env.VERCEL_ENV ?? null,
    region: process.env.VERCEL_REGION ?? null,
    node: process.version,
    hosts,
    verdict,
  };
}
