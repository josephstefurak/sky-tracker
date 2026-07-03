/**
 * OpenSky Network aircraft states with OAuth2 client-credentials support and
 * graceful degradation.
 *
 * Mode resolution:
 *   - OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET set  -> "oauth2" (4000 credits/day)
 *   - no credentials, OPENSKY_ANONYMOUS != "0"       -> "anonymous" (400 credits/day)
 *   - no credentials, OPENSKY_ANONYMOUS == "0"       -> "disabled"
 *
 * Failures NEVER propagate: every path returns a PlaneResult whose status
 * explains what happened, and every log line carries the error class, message
 * and HTTP status (the legacy backend logged `OpenSky fetch failed:` with an
 * empty error because timeout exceptions stringify to "" — never again).
 *
 * A module-level snapshot cache (TTL just under the client poll interval)
 * means any number of viewers costs one upstream call per ~10s per warm
 * lambda. On a 429 we back off and serve a recent snapshot for up to
 * OPENSKY_STALE_MAX_MS before degrading to satellites-only.
 */

import {
  OPENSKY_BACKOFF_MS,
  OPENSKY_SNAPSHOT_TTL_MS,
  OPENSKY_STALE_MAX_MS,
  PLANE_BBOX,
  PLANE_MIN_ALT_DEG,
  USER_AGENT,
} from "./config";
import { observerAzAlt } from "./geo";
import type { PlaneCategory, PlaneObject, SkyStatus } from "./types";

export type PlaneStatus = SkyStatus["planes"];
export interface PlaneResult {
  planes: PlaneObject[];
  status: PlaneStatus;
}

export const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL =
  `https://opensky-network.org/api/states/all?extended=1` +
  `&lamin=${PLANE_BBOX.lamin}&lomin=${PLANE_BBOX.lomin}` +
  `&lamax=${PLANE_BBOX.lamax}&lomax=${PLANE_BBOX.lomax}`;

const MS_TO_KNOTS = 1.94384;

const MSG_ANONYMOUS =
  "no OpenSky credentials — anonymous access (400 credits/day); set OPENSKY_CLIENT_ID/SECRET for 4000/day";
const MSG_DISABLED =
  "plane feed disabled (no OpenSky credentials and OPENSKY_ANONYMOUS=0) — satellites only";

// Module state (persists per warm serverless instance).
let snapshot: { planes: PlaneObject[]; fetchedAt: number; creditsRemaining: number | null } | null = null;
let token: { value: string; expiresAt: number } | null = null;
let backoffUntil = 0;
let backoffReason = "";
let inflight: Promise<PlaneResult> | null = null;

const CATEGORY_MAP: Record<number, PlaneCategory> = {
  2: "light",
  3: "small",
  4: "large",
  5: "large",
  6: "heavy",
  7: "heavy",
  8: "rotorcraft",
};

function categoryFor(raw: unknown): PlaneCategory | null {
  if (typeof raw !== "number" || raw === 0 || raw === 1) return null;
  return CATEGORY_MAP[raw] ?? "other";
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** OpenSky state row (extended=1 appends category as the 18th field). */
type StateRow = (string | number | boolean | null)[];

/** Exported for offline tests against a saved states/all sample. */
export function parseStates(rows: StateRow[] | null): PlaneObject[] {
  const out: PlaneObject[] = [];
  for (const s of rows ?? []) {
    const icao24 = String(s[0] ?? "").trim().toLowerCase();
    const callsign = String(s[1] ?? "").trim();
    const lon = s[5] as number | null;
    const lat = s[6] as number | null;
    const baroAlt = s[7] as number | null;
    const onGround = s[8] as boolean;
    const velocity = s[9] as number | null;
    const track = s[10] as number | null;
    const verticalRate = s[11] as number | null;
    const geoAlt = s[13] as number | null;
    const category = categoryFor(s[17]);

    if (onGround || lat == null || lon == null || !icao24) continue;
    const altitudeM = geoAlt ?? baroAlt;
    if (altitudeM == null) continue;

    const { az, alt, groundM } = observerAzAlt(lat, lon, altitudeM);
    if (alt <= PLANE_MIN_ALT_DEG) continue;

    out.push({
      type: "plane",
      id: `plane:${icao24}`,
      icao24,
      callsign,
      az: r2(az),
      alt: r2(alt),
      altitudeM: Math.round(altitudeM),
      speedKt: velocity == null ? null : Math.round(velocity * MS_TO_KNOTS),
      heading: track == null ? null : r1(track),
      verticalRateMs: verticalRate == null ? null : r1(verticalRate),
      groundDistKm: r1(groundM / 1000),
      category,
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

function maskVar(name: string): { present: boolean; length: number; hasWhitespace: boolean; preview: string | null } {
  const raw = process.env[name];
  if (!raw) return { present: false, length: 0, hasWhitespace: false, preview: null };
  return {
    present: true,
    length: raw.length,
    // A trailing newline from a paste into the Vercel dashboard is a classic
    // way for "valid" credentials to fail upstream.
    hasWhitespace: raw !== raw.trim(),
    preview: `${raw.slice(0, 3)}…`,
  };
}

/** Masked env/mode report for the temporary debug endpoint. Never exposes secret values. */
export function openskyEnvDebug() {
  return {
    mode: resolveMode().mode,
    OPENSKY_CLIENT_ID: maskVar("OPENSKY_CLIENT_ID"),
    OPENSKY_CLIENT_SECRET: { ...maskVar("OPENSKY_CLIENT_SECRET"), preview: null },
    OPENSKY_ANONYMOUS: process.env.OPENSKY_ANONYMOUS ?? null,
  };
}

function resolveMode(): { mode: PlaneStatus["mode"]; id?: string; secret?: string } {
  const id = process.env.OPENSKY_CLIENT_ID?.trim();
  const secret = process.env.OPENSKY_CLIENT_SECRET?.trim();
  if (id && secret) return { mode: "oauth2", id, secret };
  if (process.env.OPENSKY_ANONYMOUS !== "0") return { mode: "anonymous" };
  return { mode: "disabled" };
}

async function getToken(id: string, secret: string): Promise<{ ok: true; value: string } | { ok: false; status: number | null; detail: string }> {
  if (token && Date.now() < token.expiresAt) return { ok: true, value: token.value };
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: id,
        client_secret: secret,
      }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) {
      token = null;
      return { ok: false, status: res.status, detail: `token endpoint HTTP ${res.status}` };
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      return { ok: false, status: res.status, detail: "token response missing access_token" };
    }
    token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 1800) - 60) * 1000,
    };
    return { ok: true, value: token.value };
  } catch (e) {
    return { ok: false, status: null, detail: describeError(e) };
  }
}

function chicagoTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function staleOrEmpty(mode: PlaneStatus["mode"], message: string): PlaneResult {
  if (snapshot && Date.now() - snapshot.fetchedAt < OPENSKY_STALE_MAX_MS) {
    return {
      planes: snapshot.planes,
      status: {
        ok: false,
        count: snapshot.planes.length,
        mode,
        message: `${message} — showing planes from ${Math.round((Date.now() - snapshot.fetchedAt) / 1000)}s ago`,
        creditsRemaining: snapshot.creditsRemaining,
      },
    };
  }
  return {
    planes: [],
    status: {
      ok: false,
      count: 0,
      mode,
      message,
      creditsRemaining: snapshot?.creditsRemaining ?? null,
    },
  };
}

export async function getPlanes(): Promise<PlaneResult> {
  // Fresh snapshot: serve it (many clients share one upstream call).
  if (snapshot && Date.now() - snapshot.fetchedAt < OPENSKY_SNAPSHOT_TTL_MS) {
    const { mode } = resolveMode();
    return {
      planes: snapshot.planes,
      status: {
        ok: true,
        count: snapshot.planes.length,
        mode,
        message: mode === "anonymous" ? MSG_ANONYMOUS : null,
        creditsRemaining: snapshot.creditsRemaining,
      },
    };
  }
  if (inflight) return inflight;
  inflight = fetchPlanes().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchPlanes(): Promise<PlaneResult> {
  const resolved = resolveMode();

  if (resolved.mode === "disabled") {
    console.log(`[sky] OpenSky disabled: ${MSG_DISABLED}`);
    return {
      planes: [],
      status: { ok: false, count: 0, mode: "disabled", message: MSG_DISABLED, creditsRemaining: null },
    };
  }

  if (Date.now() < backoffUntil) {
    return staleOrEmpty(
      resolved.mode,
      `${backoffReason} — retrying at ${chicagoTime(backoffUntil)}`
    );
  }

  const headers: Record<string, string> = { "user-agent": USER_AGENT };

  if (resolved.mode === "oauth2") {
    const tok = await getToken(resolved.id!, resolved.secret!);
    if (!tok.ok) {
      if (tok.status === 400 || tok.status === 401 || tok.status === 403) {
        const message =
          `OpenSky credentials rejected (HTTP ${tok.status}) — check OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET`;
        console.warn(`[sky] OpenSky auth failed: ${tok.detail}`);
        // A config error must be visible, not silently downgraded to anonymous.
        return {
          planes: [],
          status: { ok: false, count: 0, mode: "disabled", message, creditsRemaining: null },
        };
      }
      console.warn(`[sky] OpenSky token fetch failed: ${tok.detail}`);
      return staleOrEmpty("oauth2", `OpenSky auth unreachable (${tok.detail})`);
    }
    headers.authorization = `Bearer ${tok.value}`;
  }

  let status: number | null = null;
  try {
    const res = await fetch(STATES_URL, {
      headers,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    status = res.status;
    const credits = res.headers.get("x-rate-limit-remaining");
    const creditsRemaining = credits == null ? null : parseInt(credits, 10);

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const waitMs = Math.max(
        Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
        OPENSKY_BACKOFF_MS
      );
      backoffUntil = Date.now() + waitMs;
      backoffReason = "OpenSky rate limit exhausted — planes paused";
      console.warn(
        `[sky] OpenSky fetch failed: HTTP 429 (rate limited), backing off until ${chicagoTime(backoffUntil)}`
      );
      return staleOrEmpty(resolved.mode, `${backoffReason} until ${chicagoTime(backoffUntil)}`);
    }
    if (res.status === 401 || res.status === 403) {
      // Token expired mid-window or anonymous access blocked for this IP.
      token = null;
      const detail =
        resolved.mode === "oauth2"
          ? `OpenSky rejected the request (HTTP ${res.status}) — token invalidated, will retry`
          : `OpenSky anonymous access blocked (HTTP ${res.status}) — set OPENSKY_CLIENT_ID/SECRET`;
      console.warn(`[sky] OpenSky fetch failed: HTTP ${res.status} (${resolved.mode})`);
      return staleOrEmpty(resolved.mode, detail);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as { states: StateRow[] | null };
    const planes = parseStates(body.states);
    snapshot = { planes, fetchedAt: Date.now(), creditsRemaining };
    console.log(
      `[sky] OpenSky: ${planes.length} aircraft above ${PLANE_MIN_ALT_DEG} deg (${resolved.mode}, credits left: ${creditsRemaining ?? "?"})`
    );
    return {
      planes,
      status: {
        ok: true,
        count: planes.length,
        mode: resolved.mode,
        message: resolved.mode === "anonymous" ? MSG_ANONYMOUS : null,
        creditsRemaining,
      },
    };
  } catch (e) {
    const detail = describeError(e);
    console.warn(`[sky] OpenSky fetch failed: ${detail} (status ${status ?? "n/a"})`);
    return staleOrEmpty(resolved.mode, `OpenSky unreachable (${detail})`);
  }
}
