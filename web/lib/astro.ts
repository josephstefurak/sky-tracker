/**
 * Sun / moon / twilight astronomy. Pure functions of (Date, lat, lon) — no
 * dependencies, small enough to audit, validated against Skyfield (see
 * DECISIONS.md for parity numbers).
 *
 * Sun: Meeus low-precision solar position (good to ~0.01 deg).
 * Moon: Schlyter's truncated series (~0.5–1 deg) + topocentric parallax.
 * Angles in degrees unless suffixed otherwise; azimuth is compass convention
 * (0 = north, 90 = east).
 */

import type { AstroState, TwilightState } from "./types";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function norm360(x: number): number {
  const y = x % 360;
  return y < 0 ? y + 360 : y;
}

function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Greenwich mean sidereal time in degrees. */
function gmstDeg(jd: number): number {
  const d = jd - 2451545.0;
  const t = d / 36525;
  return norm360(
    280.46061837 +
      360.98564736629 * d +
      0.000387933 * t * t -
      (t * t * t) / 38710000
  );
}

/** RA/Dec (degrees) -> local horizontal az/alt (degrees). */
function equatorialToHorizontal(
  raDeg: number,
  decDeg: number,
  jd: number,
  latDeg: number,
  lonDeg: number
): { az: number; alt: number } {
  const hDeg = norm360(gmstDeg(jd) + lonDeg - raDeg); // hour angle, west +
  const h = hDeg * DEG;
  const phi = latDeg * DEG;
  const dec = decDeg * DEG;
  const sinAlt =
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h);
  const alt = Math.asin(Math.min(1, Math.max(-1, sinAlt))) * RAD;
  const north =
    Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(h);
  const east = -Math.cos(dec) * Math.sin(h);
  const az = norm360(Math.atan2(east, north) * RAD);
  return { az, alt };
}

export interface SunEquatorial {
  raDeg: number;
  decDeg: number;
  /** Apparent ecliptic longitude, degrees (used for moon phase). */
  eclipticLonDeg: number;
  /** Geocentric unit vector in the equatorial frame (for shadow tests). */
  unit: [number, number, number];
}

/** Meeus low-precision apparent solar position. */
export function sunEquatorial(date: Date): SunEquatorial {
  const jd = julianDay(date);
  const t = (jd - 2451545.0) / 36525;

  const l0 = norm360(280.46646 + 36000.76983 * t + 0.0003032 * t * t);
  const m = norm360(357.52911 + 35999.05029 * t - 0.0001537 * t * t);
  const mR = m * DEG;
  const c =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(mR) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * mR) +
    0.000289 * Math.sin(3 * mR);
  const trueLon = l0 + c;
  const omega = (125.04 - 1934.136 * t) * DEG;
  const lambda = trueLon - 0.00569 - 0.00478 * Math.sin(omega); // apparent
  const eps0 = 23.439291111 - 0.013004167 * t - 1.64e-7 * t * t;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * DEG;
  const lam = lambda * DEG;

  const ra = norm360(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * RAD);
  const dec = Math.asin(Math.min(1, Math.max(-1, Math.sin(eps) * Math.sin(lam)))) * RAD;
  const raR = ra * DEG;
  const decR = dec * DEG;
  return {
    raDeg: ra,
    decDeg: dec,
    eclipticLonDeg: norm360(lambda),
    unit: [
      Math.cos(decR) * Math.cos(raR),
      Math.cos(decR) * Math.sin(raR),
      Math.sin(decR),
    ],
  };
}

export function sunPosition(
  date: Date,
  lat: number,
  lon: number
): { az: number; alt: number } {
  const s = sunEquatorial(date);
  return equatorialToHorizontal(s.raDeg, s.decDeg, julianDay(date), lat, lon);
}

export interface MoonPosition {
  az: number;
  alt: number;
  illuminatedFraction: number;
  waxing: boolean;
}

/** Schlyter's lunar position (stjarnhimlen.se), truncated perturbation series. */
export function moonPosition(date: Date, lat: number, lon: number): MoonPosition {
  const jd = julianDay(date);
  const d = jd - 2451543.5; // Schlyter's epoch: 2000 Jan 0.0
  const ecl = (23.4393 - 3.563e-7 * d) * DEG;

  // Sun mean elements (for perturbation arguments).
  const ws = norm360(282.9404 + 4.70935e-5 * d);
  const ms = norm360(356.047 + 0.9856002585 * d);
  const ls = norm360(ws + ms); // sun mean longitude

  // Moon orbital elements.
  const n = norm360(125.1228 - 0.0529538083 * d);
  const i = 5.1454 * DEG;
  const w = norm360(318.0634 + 0.1643573223 * d);
  const a = 60.2666; // Earth radii
  const e = 0.0549;
  const mm = norm360(115.3654 + 13.0649929509 * d);

  // Kepler's equation.
  const mmR = mm * DEG;
  let ea = mmR + e * Math.sin(mmR) * (1 + e * Math.cos(mmR));
  for (let k = 0; k < 10; k++) {
    const dE = (ea - e * Math.sin(ea) - mmR) / (1 - e * Math.cos(ea));
    ea -= dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  const xv = a * (Math.cos(ea) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(ea);
  const v = Math.atan2(yv, xv);
  let r = Math.sqrt(xv * xv + yv * yv);

  // Ecliptic coordinates.
  const nR = n * DEG;
  const vw = v + w * DEG;
  const xh = r * (Math.cos(nR) * Math.cos(vw) - Math.sin(nR) * Math.sin(vw) * Math.cos(i));
  const yh = r * (Math.sin(nR) * Math.cos(vw) + Math.cos(nR) * Math.sin(vw) * Math.cos(i));
  const zh = r * Math.sin(vw) * Math.sin(i);
  let lonm = norm360(Math.atan2(yh, xh) * RAD);
  let latm = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) * RAD;

  // Perturbations (degrees).
  const lm = norm360(n + w + mm); // moon mean longitude
  const dd = norm360(lm - ls); // mean elongation
  const f = norm360(lm - n); // argument of latitude
  const s = (x: number) => Math.sin(x * DEG);
  const c = (x: number) => Math.cos(x * DEG);
  lonm +=
    -1.274 * s(mm - 2 * dd) +
    0.658 * s(2 * dd) -
    0.186 * s(ms) -
    0.059 * s(2 * mm - 2 * dd) -
    0.057 * s(mm - 2 * dd + ms) +
    0.053 * s(mm + 2 * dd) +
    0.046 * s(2 * dd - ms) +
    0.041 * s(mm - ms) -
    0.035 * s(dd) -
    0.031 * s(mm + ms) -
    0.015 * s(2 * f - 2 * dd) +
    0.011 * s(mm - 4 * dd);
  latm +=
    -0.173 * s(f - 2 * dd) -
    0.055 * s(mm - f - 2 * dd) -
    0.046 * s(mm + f - 2 * dd) +
    0.033 * s(f + 2 * dd) +
    0.017 * s(2 * mm + f);
  r += -0.58 * c(mm - 2 * dd) - 0.46 * c(2 * dd);

  // Ecliptic -> equatorial -> horizontal.
  const lonR = lonm * DEG;
  const latR = latm * DEG;
  const xe = Math.cos(lonR) * Math.cos(latR);
  const ye = Math.sin(lonR) * Math.cos(latR);
  const ze = Math.sin(latR);
  const yeq = ye * Math.cos(ecl) - ze * Math.sin(ecl);
  const zeq = ye * Math.sin(ecl) + ze * Math.cos(ecl);
  const ra = norm360(Math.atan2(yeq, xe) * RAD);
  const dec = Math.asin(Math.min(1, Math.max(-1, zeq))) * RAD;
  const geo = equatorialToHorizontal(ra, dec, jd, lat, lon);

  // Topocentric altitude: subtract parallax (moon distance r in Earth radii).
  const mpar = Math.asin(Math.min(1, 1 / r)) * RAD;
  const alt = geo.alt - mpar * Math.cos(geo.alt * DEG);

  // Phase from elongation vs the sun's apparent ecliptic longitude.
  const sunLon = sunEquatorial(date).eclipticLonDeg;
  const elong = Math.acos(
    Math.min(1, Math.max(-1, Math.cos(latm * DEG) * Math.cos((lonm - sunLon) * DEG)))
  );
  const illuminatedFraction = (1 - Math.cos(elong)) / 2;
  const waxing = norm360(lonm - sunLon) < 180;

  return { az: geo.az, alt, illuminatedFraction, waxing };
}

export function twilightState(sunAlt: number): TwilightState {
  if (sunAlt > 0) return "day";
  if (sunAlt > -6) return "civil";
  if (sunAlt > -12) return "nautical";
  if (sunAlt > -18) return "astronomical";
  return "night";
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function computeAstro(date: Date, lat: number, lon: number): AstroState {
  const sun = sunPosition(date, lat, lon);
  const moon = moonPosition(date, lat, lon);
  return {
    sun: { az: r2(sun.az), alt: r2(sun.alt) },
    moon: {
      az: r2(moon.az),
      alt: r2(moon.alt),
      illuminatedFraction: r3(moon.illuminatedFraction),
      waxing: moon.waxing,
    },
    twilight: twilightState(sun.alt),
  };
}
