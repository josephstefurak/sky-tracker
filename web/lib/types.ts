/**
 * Shared wire types for sky-tracker.
 *
 * This file is the CONTRACT between the server data layer (app/api/sky) and
 * the client renderer (components/SkyDome). Both sides code against it.
 *
 * Conventions:
 *  - `az`  is a compass azimuth in degrees [0, 360): 0 = true north, 90 = east.
 *  - `alt` is the ELEVATION ANGLE above the horizon in degrees (0 = horizon,
 *    90 = zenith). It is NOT the flight altitude; that is `altitudeM`.
 *  - `id` is stable across polls and namespaced ("sat:25544", "plane:a3a4ed")
 *    so satellite NORAD ids can never collide with aircraft hex codes.
 */

export type TwilightState =
  | "day" // sun above horizon
  | "civil" // sun 0 .. -6 deg
  | "nautical" // sun -6 .. -12 deg
  | "astronomical" // sun -12 .. -18 deg
  | "night"; // sun below -18 deg

export type SatCategory = "station" | "payload" | "rocket-body" | "debris";

export interface SatObject {
  type: "sat";
  id: string; // "sat:<noradId>"
  noradId: number;
  name: string; // e.g. "ISS (ZARYA)"
  az: number;
  alt: number;
  rangeKm: number; // slant range observer -> satellite
  /** In direct sunlight (not inside Earth's shadow). */
  sunlit: boolean;
  /** Naked-eye candidate right now: sunlit AND the observer's sky is dark
   *  (sun elevation <= -6 deg). Drives the "visible pass" emphasis. */
  visibleNow: boolean;
  category: SatCategory;
  launchYear: number | null; // from the TLE international designator
  isISS: boolean;
}

export type PlaneCategory =
  | "light"
  | "small"
  | "large"
  | "heavy"
  | "rotorcraft"
  | "other";

export interface PlaneObject {
  type: "plane";
  id: string; // "plane:<icao24>"
  icao24: string;
  callsign: string; // trimmed; may be ""
  az: number;
  alt: number;
  altitudeM: number | null; // geometric altitude, meters MSL
  speedKt: number | null;
  heading: number | null; // degrees true, direction of travel
  verticalRateMs: number | null; // + climbing / - descending, m/s
  groundDistKm: number | null; // great-circle distance observer -> plane
  category: PlaneCategory | null; // from OpenSky extended category (null = unknown)

  // ---- Route enrichment (adsbdb /v0/callsign), present once cached ----
  origin?: string | null; // IATA, e.g. "ORD"
  destination?: string | null;
  originName?: string | null; // municipality, e.g. "Chicago"
  destinationName?: string | null;
  airline?: string | null; // e.g. "United Airlines"

  // ---- Aircraft enrichment (adsbdb /v0/aircraft), present once cached ----
  aircraftType?: string | null; // e.g. "Boeing 737-824"
  operator?: string | null; // registered owner
  photoUrl?: string | null; // small photo thumbnail URL
}

export type SkyObject = SatObject | PlaneObject;

export interface AstroState {
  sun: { az: number; alt: number };
  moon: {
    az: number;
    alt: number;
    /** 0 = new moon, 1 = full moon. */
    illuminatedFraction: number;
    waxing: boolean;
  };
  twilight: TwilightState;
}

export type PlaneFeedMode = "oauth2" | "anonymous" | "disabled";

export interface SkyStatus {
  satellites: {
    ok: boolean;
    count: number;
    tleAgeHours: number | null;
    /** Human-readable problem description when !ok, else null. */
    message: string | null;
  };
  planes: {
    /** True when the most recent upstream fetch (or fresh cache) succeeded. */
    ok: boolean;
    count: number;
    mode: PlaneFeedMode;
    /** Human-readable state, e.g. why planes are missing or degraded. */
    message: string | null;
    /** OpenSky X-Rate-Limit-Remaining header when available. */
    creditsRemaining: number | null;
  };
}

export interface SkyResponse {
  /** Unix seconds, server time of this snapshot. */
  ts: number;
  objects: SkyObject[];
  astro: AstroState;
  status: SkyStatus;
}
