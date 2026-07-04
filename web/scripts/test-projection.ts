/**
 * Self-test for the dome projection / ceiling-mirror math.
 * Run from web/:  npx tsx scripts/test-projection.ts
 * Exits non-zero on any failure.
 */

import {
  CEILING_MIRROR,
  getMapRotationQuarters,
  headingToRotationZ,
  headingToRotationZWith,
  mapAzimuthOffsetDegWith,
  project,
  projectWith,
  setMapRotationQuarters,
} from "../lib/projection";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function approx(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

/** Rotate a 2D vector by theta radians (counterclockwise, matching Three.js rotation.z). */
function rotate(v: { x: number; y: number }, theta: number) {
  return {
    x: v.x * Math.cos(theta) - v.y * Math.sin(theta),
    y: v.x * Math.sin(theta) + v.y * Math.cos(theta),
  };
}

const R = 100;

// --- Flag state -------------------------------------------------------------
check("CEILING_MIRROR is enabled by default", CEILING_MIRROR === true);

// --- Mirrored cardinal placement (viewed from below, N kept at top) ---------
{
  const n = projectWith(true, 0, 0, R);
  check("mirrored: az=0 (N) at top", n.y > 0 && approx(n.x, 0), JSON.stringify(n));
  const e = projectWith(true, 90, 0, R);
  check("mirrored: az=90 (E) on the LEFT", e.x < 0 && approx(e.y, 0), JSON.stringify(e));
  const s = projectWith(true, 180, 0, R);
  check("mirrored: az=180 (S) at bottom", s.y < 0 && approx(s.x, 0), JSON.stringify(s));
  const w = projectWith(true, 270, 0, R);
  check("mirrored: az=270 (W) on the RIGHT", w.x > 0 && approx(w.y, 0), JSON.stringify(w));
}

// --- Motion agreement: an eastbound object drifts toward the E label --------
{
  // Approaching due east from the NE (az 70 → 85), x must strictly decrease
  // (move LEFT, toward the mirrored E label).
  let prev = projectWith(true, 70, 45, R);
  let monotonic = true;
  for (const az of [75, 80, 85]) {
    const p = projectWith(true, az, 45, R);
    if (!(p.x < prev.x)) monotonic = false;
    prev = p;
  }
  check("mirrored: eastbound az 70→85 moves toward -x (E label)", monotonic);

  // Crossing due east (az 80 → 100): stays on the left half the whole way,
  // and az=90 is the leftmost extreme of the arc.
  const xs = [80, 85, 90, 95, 100].map((az) => projectWith(true, az, 45, R).x);
  const allLeft = xs.every((x) => x < 0);
  const extremeAt90 = Math.min(...xs) === xs[2];
  check("mirrored: az 80→100 arc stays on the E (left) side", allLeft, JSON.stringify(xs));
  check("mirrored: az=90 is the leftmost point of the arc", extremeAt90);
}

// --- Chevron/heading agreement (marker shape points +y at rest) -------------
{
  const tipE = rotate({ x: 0, y: 1 }, headingToRotationZWith(true, 90));
  check(
    "mirrored: heading 90 points at the E label (-1, 0)",
    approx(tipE.x, -1) && approx(tipE.y, 0),
    JSON.stringify(tipE)
  );
  const tipN = rotate({ x: 0, y: 1 }, headingToRotationZWith(true, 0));
  check("mirrored: heading 0 points N (0, 1)", approx(tipN.x, 0) && approx(tipN.y, 1));
  const tipS = rotate({ x: 0, y: 1 }, headingToRotationZWith(true, 180));
  check("mirrored: heading 180 points S (0, -1)", approx(tipS.x, 0) && approx(tipS.y, -1));
  const tipW = rotate({ x: 0, y: 1 }, headingToRotationZWith(true, 270));
  check("mirrored: heading 270 points at the W label (1, 0)", approx(tipW.x, 1) && approx(tipW.y, 0));
}

// --- Position/heading consistency: chevron points where the object goes -----
{
  // An eastbound object passing overhead rises on the W side and sets on the
  // E side: az 270 (alt 89) → zenith → az 90 (alt 89). With the mirror, that
  // is a right-to-left crossing, agreeing with the heading-90 chevron.
  const p1 = projectWith(true, 270, 89, R); // just west of zenith
  const p2 = projectWith(true, 90, 89, R); // just east of zenith
  const motion = { x: p2.x - p1.x, y: p2.y - p1.y };
  const tip = rotate({ x: 0, y: 1 }, headingToRotationZWith(true, 90));
  const dot = motion.x * tip.x + motion.y * tip.y;
  check(
    "mirrored: eastbound zenith crossing (W→E) moves right-to-left, agreeing with heading-90 chevron",
    p1.x > 0 && p2.x < 0 && dot > 0,
    JSON.stringify({ p1, p2 })
  );
}

// --- Legacy mode (flag off) reproduces the original renderer ----------------
{
  const e = projectWith(false, 90, 0, R);
  check("legacy: az=90 (E) on the RIGHT", e.x > 0 && approx(e.y, 0), JSON.stringify(e));
  const n = projectWith(false, 0, 0, R);
  check("legacy: az=0 (N) at top", n.y > 0 && approx(n.x, 0));
  const tipE = rotate({ x: 0, y: 1 }, headingToRotationZWith(false, 90));
  check(
    "legacy: heading 90 rotates (0,1) → (1,0), matching old -heading behavior",
    approx(tipE.x, 1) && approx(tipE.y, 0),
    JSON.stringify(tipE)
  );
}

// --- Radius law --------------------------------------------------------------
{
  const zenith = projectWith(true, 123, 90, R);
  check("radius: alt=90 → center", approx(Math.hypot(zenith.x, zenith.y), 0));
  const horizon = projectWith(true, 200, 0, R);
  check("radius: alt=0 → dome edge", approx(Math.hypot(horizon.x, horizon.y), R));
  const mid = projectWith(true, 321, 45, R);
  check("radius: alt=45 → half radius", approx(Math.hypot(mid.x, mid.y), R / 2));
}

// --- Exported bindings use the configured flag -------------------------------
{
  const a = project(37, 21, R);
  const b = projectWith(CEILING_MIRROR, 37, 21, R);
  check("project() binds CEILING_MIRROR", approx(a.x, b.x) && approx(a.y, b.y));
  check(
    "headingToRotationZ() binds CEILING_MIRROR",
    approx(headingToRotationZ(55), headingToRotationZWith(CEILING_MIRROR, 55))
  );
}

// --- out-param reuse ---------------------------------------------------------
{
  const out = { x: 0, y: 0 };
  const ret = project(90, 45, R, out);
  check("project(out) writes and returns the same object", ret === out && out.x !== 0);
}

// --- Map rotation (screen-clockwise quarter-turn azimuth offset) -------------
{
  check("map rotation defaults to 0 quarters", getMapRotationQuarters() === 0);

  // One press = one screen-CLOCKWISE step, regardless of mirror mode. With
  // the mirror on (default), N walks top → right → bottom → left.
  setMapRotationQuarters(1);
  const n1 = project(0, 0, R);
  check("map q=1: N label lands on the RIGHT", n1.x > 0 && approx(n1.y, 0), JSON.stringify(n1));
  const e1 = project(90, 0, R);
  check("map q=1: E label lands at the TOP", approx(e1.x, 0) && e1.y > 0, JSON.stringify(e1));

  // The chevron composes the same offset: heading 90 keeps pointing at
  // wherever the E label now sits.
  const tip1 = rotate({ x: 0, y: 1 }, headingToRotationZ(90));
  check(
    "map q=1: heading-90 chevron points at the rotated E label",
    approx(tip1.x, e1.x / R) && approx(tip1.y, e1.y / R),
    JSON.stringify({ tip1, e1 })
  );

  setMapRotationQuarters(2);
  const n2 = project(0, 0, R);
  const s2 = project(180, 0, R);
  check("map q=2: N label at the BOTTOM", approx(n2.x, 0) && n2.y < 0, JSON.stringify(n2));
  check("map q=2: S label at the TOP", approx(s2.x, 0) && s2.y > 0, JSON.stringify(s2));

  setMapRotationQuarters(3);
  const n3 = project(0, 0, R);
  check("map q=3: N label on the LEFT", n3.x < 0 && approx(n3.y, 0), JSON.stringify(n3));

  // Rigid rotation: chirality of the ring is preserved (E stays 90° counter-
  // clockwise of N on screen in mirrored mode, at every quarter).
  for (const q of [0, 1, 2, 3]) {
    setMapRotationQuarters(q);
    const n = project(0, 0, R);
    const e = project(90, 0, R);
    const cross = n.x * e.y - n.y * e.x; // >0 ⇔ E is 90° CCW of N
    check(`map q=${q}: ring chirality preserved (E is CCW of N)`, cross > 0);
  }

  // Altitude law is untouched by the offset.
  setMapRotationQuarters(1);
  const mid = project(321, 45, R);
  check("map rotation preserves the radius law", approx(Math.hypot(mid.x, mid.y), R / 2));

  // Normalization.
  setMapRotationQuarters(4);
  check("map rotation normalizes q=4 → 0", getMapRotationQuarters() === 0);
  setMapRotationQuarters(-1);
  check("map rotation normalizes q=-1 → 3", getMapRotationQuarters() === 3);
  setMapRotationQuarters(6);
  check("map rotation normalizes q=6 → 2", getMapRotationQuarters() === 2);

  // The data-space offset flips sign with the mirror (mirroring flips the
  // handedness of every rotation) so the SCREEN direction stays clockwise.
  check("offset helper: legacy q=1 → +90°", mapAzimuthOffsetDegWith(false, 1) === 90);
  check("offset helper: mirrored q=1 → -90°", mapAzimuthOffsetDegWith(true, 1) === -90);
  const nLegacy = projectWith(false, 0 + mapAzimuthOffsetDegWith(false, 1), 0, R);
  check(
    "legacy q=1: N also lands on the RIGHT (screen-clockwise in both modes)",
    nLegacy.x > 0 && approx(nLegacy.y, 0),
    JSON.stringify(nLegacy)
  );

  // Reset: q=0 restores the base mapping exactly.
  setMapRotationQuarters(0);
  const back = project(37, 21, R);
  const pure = projectWith(CEILING_MIRROR, 37, 21, R);
  check(
    "map rotation reset restores the base mapping",
    approx(back.x, pure.x) && approx(back.y, pure.y)
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll projection tests passed.");
