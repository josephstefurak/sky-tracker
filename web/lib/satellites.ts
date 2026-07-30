/**
 * SGP4 propagation (satellite.js) -> observer-relative SatObjects.
 *
 * This replaces the Python backend's Skyfield path; az/alt parity with
 * Skyfield is validated to <0.1 deg (see DECISIONS.md). Sunlit state uses the
 * standard cylindrical Earth-shadow test in the ECI frame.
 */

import * as satellite from "satellite.js";
import { SAT_MIN_ALT_DEG } from "./config";
import type { Observer } from "./observer";
import type { SatCategory, SatObject } from "./types";
import type { TleRecord } from "./tle";

const EARTH_RADIUS_KM = 6371;
const ISS_NORAD_ID = 25544;

type SatRec = ReturnType<typeof satellite.twoline2satrec>;

// satrec cache keyed by the TLE lines, so records persist across polls and
// refresh naturally when Celestrak publishes new elements.
const satrecCache = new Map<string, SatRec>();

function norm360(x: number): number {
  const y = x % 360;
  return y < 0 ? y + 360 : y;
}

function categoryFor(rec: TleRecord): SatCategory {
  // Name heuristics outrank group membership: Celestrak's "stations" group
  // also contains station-adjacent debris (e.g. "FREGAT DEB").
  if (rec.name.includes(" DEB")) return "debris";
  if (rec.name.includes(" R/B")) return "rocket-body";
  if (rec.groups.includes("stations")) return "station";
  return "payload";
}

/** Cylindrical Earth-shadow test: is the satellite in direct sunlight? */
function isSunlit(posEciKm: { x: number; y: number; z: number }, sunUnit: [number, number, number]): boolean {
  const dot = posEciKm.x * sunUnit[0] + posEciKm.y * sunUnit[1] + posEciKm.z * sunUnit[2];
  if (dot > 0) return true; // on the day side of Earth's center
  const px = posEciKm.x - dot * sunUnit[0];
  const py = posEciKm.y - dot * sunUnit[1];
  const pz = posEciKm.z - dot * sunUnit[2];
  return Math.sqrt(px * px + py * py + pz * pz) > EARTH_RADIUS_KM;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function computeSatellites(
  records: TleRecord[],
  date: Date,
  sunUnit: [number, number, number],
  sunAltDeg: number,
  observer: Observer
): SatObject[] {
  if (satrecCache.size > records.length * 3 + 64) satrecCache.clear();

  // Derived per call now that the observer varies per request — three trig
  // conversions, i.e. nothing next to ~160 SGP4 propagations. The satrec
  // cache above stays shared: an SGP4 record is a property of the TLE alone,
  // independent of who is watching.
  const observerGd = {
    latitude: satellite.degreesToRadians(observer.lat),
    longitude: satellite.degreesToRadians(observer.lon),
    height: observer.elevationM / 1000,
  };

  const gmst = satellite.gstime(date);
  const skyIsDark = sunAltDeg <= -6;
  const out: SatObject[] = [];

  for (const rec of records) {
    try {
      const key = rec.line1 + rec.line2;
      let satrec = satrecCache.get(key);
      if (!satrec) {
        satrec = satellite.twoline2satrec(rec.line1, rec.line2);
        satrecCache.set(key, satrec);
      }

      const pv = satellite.propagate(satrec, date);
      const pos = pv?.position;
      if (!pos || typeof pos === "boolean" || !Number.isFinite(pos.x)) continue;

      const ecf = satellite.eciToEcf(pos, gmst);
      const look = satellite.ecfToLookAngles(observerGd, ecf);
      const alt = satellite.radiansToDegrees(look.elevation);
      if (alt <= SAT_MIN_ALT_DEG) continue;

      const az = norm360(satellite.radiansToDegrees(look.azimuth));
      const sunlit = isSunlit(pos, sunUnit);

      out.push({
        type: "sat",
        id: `sat:${rec.noradId}`,
        noradId: rec.noradId,
        name: rec.name,
        az: r2(az),
        alt: r2(alt),
        rangeKm: Math.round(look.rangeSat),
        sunlit,
        visibleNow: sunlit && skyIsDark,
        category: categoryFor(rec),
        launchYear: rec.launchYear,
        isISS: rec.noradId === ISS_NORAD_ID,
      });
    } catch {
      // Skip satellites SGP4 cannot propagate (decayed, malformed elements).
      continue;
    }
  }
  return out;
}
