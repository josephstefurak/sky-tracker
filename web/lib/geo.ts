/**
 * Observer-relative geometry for aircraft. This is an exact port of
 * backend/position_engine.py:_observer_az_alt (initial great-circle bearing,
 * haversine ground distance, atan2 elevation) to preserve parity with the
 * reference implementation.
 */

import { OBSERVER } from "./config";

const EARTH_RADIUS_M = 6371000.0;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface AzAltDist {
  az: number; // degrees [0, 360)
  alt: number; // elevation angle, degrees
  groundM: number; // great-circle ground distance, meters
}

export function observerAzAlt(lat: number, lon: number, altM: number): AzAltDist {
  const phi1 = OBSERVER.lat * DEG;
  const phi2 = lat * DEG;
  const dphi = (lat - OBSERVER.lat) * DEG;
  const dlmb = (lon - OBSERVER.lon) * DEG;

  // Initial bearing (azimuth), normalized to [0, 360).
  const y = Math.sin(dlmb) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlmb);
  const bearing = (Math.atan2(y, x) * RAD + 360.0) % 360.0;

  // Great-circle ground distance (haversine).
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlmb / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const ground = EARTH_RADIUS_M * c;

  // Elevation angle above the observer's horizontal plane.
  const dh = altM - OBSERVER.elevationM;
  const elevation = Math.atan2(dh, ground) * RAD;
  return { az: bearing, alt: elevation, groundM: ground };
}
