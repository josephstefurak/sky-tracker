/**
 * Which clock the dome shows.
 *
 * The footer clock used to be whatever the *device's* timezone was, and the
 * server formatted its plane-feed pauses in America/Chicago for everyone. Both
 * are wrong once the dome can show someone else's sky: a projector in Chicago
 * displaying the New York sky should read New York time.
 *
 * Resolution order, cheapest first:
 *   1. Location came from `navigator.geolocation` → the device is AT those
 *      coordinates, so `Intl.DateTimeFormat().resolvedOptions().timeZone` is
 *      the right answer, free and instant.
 *   2. Location is the Chicago fallback → DEFAULT_OBSERVER_ZONE, a known fact.
 *   3. Custom coordinates (URL param or typed in) → offline coordinate lookup
 *      (tz-lookup: CC0 / public domain, no API, no key, ~28 KB gzip lazily
 *      downloaded only on this path). Its zone boundaries derive from
 *      timezone-boundary-builder, i.e. OpenStreetMap data under the ODbL.
 *      Frozen at 2019 data: a few zone names are archaic (Europe/Kiev rather
 *      than Europe/Kyiv) and post-2019 boundary splits are missing, so a
 *      handful of border towns can be an hour out. Fine for an ambient clock;
 *      see DECISIONS.md §13.
 *   4. Anything unavailable → null, and the clock is shown in UTC with a
 *      visible "UTC" label. Never a silently wrong local time.
 */

import type { ResolvedLocation } from "./location";
import { DEFAULT_OBSERVER, DEFAULT_OBSERVER_ZONE, sameObserver, type Observer } from "./observer";

/** Is this a zone name the runtime's Intl can actually format with? */
export function isUsableZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a zone id to the one Intl actually uses. Many IANA ids are *links*
 * to another zone (Asia/Kolkata → Asia/Calcutta, Etc/GMT → UTC), so comparing
 * two zone strings directly reports differences that do not exist.
 */
function canonicalZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions()
      .timeZone;
  } catch {
    return zone;
  }
}

let ownZone: string | null | undefined;

/** The device's own timezone, or null if the environment reports none usable. */
export function browserTimeZone(): string | null {
  if (ownZone === undefined) {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      ownZone = isUsableZone(zone) ? zone : null;
    } catch {
      ownZone = null;
    }
  }
  return ownZone;
}

/** Coordinate → IANA zone, offline. Null when the lookup is unavailable. */
async function lookupZone(observer: Observer): Promise<string | null> {
  try {
    // Lazily imported so the zone-boundary table (~73 KB raw, ~28 KB gzip) is
    // downloaded only by viewers who actually use custom coordinates. The
    // interop dance covers both shapes a CommonJS module can arrive in through
    // a bundler (verified: it arrives as a namespace with .default).
    const mod: unknown = await import("tz-lookup");
    const lookup = (
      typeof mod === "function" ? mod : (mod as { default?: unknown }).default
    ) as ((lat: number, lon: number) => string) | undefined;
    if (typeof lookup !== "function") return null;
    const zone = lookup(observer.lat, observer.lon);
    return isUsableZone(zone) ? zone : null;
  } catch (error) {
    console.info(
      "[sky-tracker] coordinate timezone lookup unavailable — showing UTC",
      error
    );
    return null;
  }
}

/** The zone the clock should use for this location (null → show UTC). */
export async function resolveDisplayZone(
  location: ResolvedLocation
): Promise<string | null> {
  if (location.source === "geolocation") {
    const own = browserTimeZone();
    if (own) return own;
  }
  if (
    location.source === "default" ||
    sameObserver(location.observer, DEFAULT_OBSERVER)
  ) {
    return DEFAULT_OBSERVER_ZONE;
  }
  return lookupZone(location.observer);
}

/**
 * Wall clock for the footer.
 *  - zone is the device's own  → bare time, as before ("19:42").
 *  - zone is somewhere else    → time plus its short name ("20:42 EDT"), so a
 *    remote sky's clock can't be misread as your own.
 *  - zone unknown (null)       → UTC, explicitly labeled ("00:42 UTC").
 */
export function formatClock(date: Date, zone: string | null): string {
  const timeZone = zone ?? "UTC";
  const own = browserTimeZone();
  const named =
    zone === null || own === null || canonicalZone(zone) !== canonicalZone(own);
  try {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
      ...(named ? { timeZoneName: "short" as const } : {}),
    });
  } catch {
    // An unexpected Intl refusal must not take the whole HUD tick down.
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}
