/**
 * Browser-side observer resolution — how a device decides whose sky it shows.
 *
 * Priority, resolved once on load:
 *   1. URL params `?lat=&lon=` (+ optional `&elev=`, meters MSL). These win
 *      over everything and are also the manual override for testing.
 *   2. The location stored on this device by an earlier visit, so setup is a
 *      one-time thing and a reload never re-prompts.
 *   3. `navigator.geolocation` — the default path for a new user. Requires a
 *      secure context: production is HTTPS, and localhost counts as secure for
 *      development.
 *   4. DEFAULT_OBSERVER (Chicago) when geolocation is denied, unavailable or
 *      times out. This is a quiet fallback, not an error state: the footer just
 *      says which source is in use.
 *
 * Every path funnels through lib/observer.ts validation, so an invalid stored
 * value, URL param or form field degrades to the next source instead of
 * reaching the API or the renderer.
 */

import {
  DEFAULT_OBSERVER,
  ELEVATION_UNKNOWN_M,
  isValidElevation,
  observerFrom,
  type Observer,
} from "./observer";

export type LocationSource = "url" | "manual" | "geolocation" | "default";

export interface ResolvedLocation {
  observer: Observer;
  source: LocationSource;
}

/**
 * Footer/panel wording per source. "url" and "manual" are both *custom*
 * coordinates as far as a viewer is concerned — the distinction only matters
 * for precedence, not for the label.
 */
export const SOURCE_LABEL: Record<LocationSource, string> = {
  url: "custom",
  manual: "custom",
  geolocation: "your location",
  default: "Chicago (default)",
};

export const DEFAULT_LOCATION: ResolvedLocation = {
  observer: DEFAULT_OBSERVER,
  source: "default",
};

const STORAGE_KEY = "sky-tracker:location";
const GEOLOCATION_TIMEOUT_MS = 8_000;
/** A position up to 10 min old is fine for a fixed display. */
const GEOLOCATION_MAX_AGE_MS = 10 * 60_000;
/** Ignore a reported altitude less certain than this (meters). */
const MAX_ALTITUDE_ACCURACY_M = 100;

const SOURCES: LocationSource[] = ["url", "manual", "geolocation", "default"];

/** `?lat=&lon=&elev=` — null when absent OR invalid, so bad params fall through
 *  to the stored/geolocated/default path rather than showing a broken sky. */
export function locationFromUrl(search: string): ResolvedLocation | null {
  const params = new URLSearchParams(search);
  if (!params.has("lat") && !params.has("lon")) return null;
  const observer = observerFrom(
    params.get("lat"),
    params.get("lon"),
    params.get("elev")
  );
  if (!observer) {
    console.info("[sky-tracker] ignoring invalid lat/lon URL params");
    return null;
  }
  return { observer, source: "url" };
}

/** The location this device saved earlier. Anything unparseable or out of
 *  range is discarded (and the key cleared) rather than trusted. */
export function readStoredLocation(): ResolvedLocation | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage unavailable (privacy mode)
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Observer> & {
      source?: unknown;
    };
    const observer = observerFrom(parsed.lat, parsed.lon, parsed.elevationM);
    const source = SOURCES.find((s) => s === parsed.source);
    if (observer && source && source !== "default") {
      return { observer, source };
    }
    // A stored "default" carries no information, and a malformed entry is worse
    // than none: drop it so the normal resolution order runs.
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing more to do; resolution just continues.
    }
  }
  return null;
}

/** Remember a resolved location for next time. Best-effort only. */
export function storeLocation(location: ResolvedLocation): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        lat: location.observer.lat,
        lon: location.observer.lon,
        elevationM: location.observer.elevationM,
        source: location.source,
      })
    );
  } catch {
    // Best-effort persistence only: the display still works for this session.
  }
}

/** Forget this device's location, so the next load resolves from scratch. */
export function clearStoredLocation(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort only.
  }
}

/**
 * The part of the resolution order that needs no permission and no waiting:
 * URL params, then this device's stored location. Null means "ask the browser
 * where we are" (see requestGeolocation).
 */
export function resolveKnownLocation(): ResolvedLocation | null {
  if (typeof window === "undefined") return null;
  return locationFromUrl(window.location.search) ?? readStoredLocation();
}

/**
 * Geolocation altitude is a WGS84 *ellipsoidal* height and is usually absent
 * or wildly uncertain (wifi positioning can be off by hundreds of meters), so
 * it is taken only when the device claims ~100 m accuracy; otherwise sea level
 * is assumed. Observer elevation only enters the geometry as
 * `planeAltitude - observerElevation`, so this is a sub-degree question for
 * aircraft at cruise — correctable with `?elev=` where it matters.
 */
function elevationFrom(coords: GeolocationCoordinates): number {
  const { altitude, altitudeAccuracy } = coords;
  if (
    isValidElevation(altitude) &&
    typeof altitudeAccuracy === "number" &&
    Number.isFinite(altitudeAccuracy) &&
    altitudeAccuracy <= MAX_ALTITUDE_ACCURACY_M
  ) {
    return altitude;
  }
  return ELEVATION_UNKNOWN_M;
}

/**
 * Ask the browser where we are. NEVER rejects and never throws: denied,
 * unavailable, timed out, insecure context and "this WebView has no
 * geolocation" all resolve to null so the caller can fall back quietly.
 */
export function requestGeolocation(): Promise<ResolvedLocation | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ResolvedLocation | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Belt and braces: a few WebViews invoke neither callback when permission
    // is dismissed, which would leave the display waiting forever.
    const guard = window.setTimeout(() => done(null), GEOLOCATION_TIMEOUT_MS + 2_000);
    const finish = (value: ResolvedLocation | null): void => {
      window.clearTimeout(guard);
      done(value);
    };

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const observer = observerFrom(
            position.coords.latitude,
            position.coords.longitude,
            elevationFrom(position.coords)
          );
          finish(observer ? { observer, source: "geolocation" } : null);
        },
        (error) => {
          // Deliberately quiet — a denied prompt is a normal outcome, not a
          // fault, and this display has no business showing an error for it.
          console.info(
            `[sky-tracker] geolocation unavailable (code ${error.code}) — using the fallback location`
          );
          finish(null);
        },
        {
          enableHighAccuracy: false,
          timeout: GEOLOCATION_TIMEOUT_MS,
          maximumAge: GEOLOCATION_MAX_AGE_MS,
        }
      );
    } catch {
      finish(null); // getCurrentPosition itself can throw in locked-down WebViews
    }
  });
}

/**
 * Coordinates typed into the location panel. Returns null when either field is
 * invalid so the panel can simply refuse to apply them.
 *
 * Elevation is not asked for: a hand-entered location assumes sea level unless
 * the `elev` URL param says otherwise (see elevationFrom above for why that is
 * a sub-degree question).
 */
export function manualLocation(
  latRaw: string,
  lonRaw: string,
  elevationM: number = ELEVATION_UNKNOWN_M
): ResolvedLocation | null {
  const observer = observerFrom(latRaw, lonRaw, elevationM);
  return observer ? { observer, source: "manual" } : null;
}
