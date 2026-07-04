/**
 * Dome projection for sky-tracker — the single source of truth for every
 * azimuth/altitude → screen mapping (objects, trails, cardinal labels, ring
 * labels, sun, moon, moon-phase orientation). No other module may do this
 * trigonometry inline.
 *
 * Geometry
 * --------
 * The dome maps the sky hemisphere onto a disc: center = zenith (alt 90°),
 * edge = horizon (alt 0°), with r = (1 - alt/90) * radius. Coordinates are
 * Three.js orthographic world coords: +y = up on screen = North.
 *
 * CEILING MIRROR (Stage 1 fix)
 * ----------------------------
 * The legacy renderer used the looking-DOWN (map) convention: N top, E right.
 * This image is projected onto a CEILING and viewed from BELOW, which flips
 * chirality: keeping North at the top, East must appear on the LEFT and West
 * on the RIGHT (the star-chart convention). That is a horizontal mirror —
 * negate x. Mirroring also flips the sign of every rotation angle, so a
 * heading-aligned marker (the plane chevron points +y = North at rest) must
 * rotate by +heading instead of -heading.
 *
 * Set CEILING_MIRROR = false to restore the legacy looking-down mapping
 * (e.g. if the projector's own image-flip setting is used instead).
 *
 * Text is never mirrored: we mirror coordinates and leave sprites upright —
 * never apply a negative scale to the scene or canvas (it would flip glyphs).
 *
 * MAP ROTATION (projector aiming)
 * -------------------------------
 * A presentation-layer quarter-turn offset composed ON TOP of the mapping so
 * the compass can face any screen edge (e.g. North at the bottom to match how
 * the projector is aimed in a room). `mapRotationQuarters` counts SCREEN-
 * clockwise 90° steps; because mirroring flips the handedness of every
 * rotation, one screen-clockwise quarter is -90° of azimuth when mirrored and
 * +90° when not. The offset enters only through project() and
 * headingToRotationZ() — raw az/alt data, CEILING_MIRROR, and the pure
 * *With() helpers are untouched, and text stays upright because positions
 * rotate while glyphs never do.
 */

export const CEILING_MIRROR = true;

let mapRotationQuarters = 0;

/** Set the map orientation in screen-clockwise quarter-turns (any integer;
 *  normalized into 0–3). */
export function setMapRotationQuarters(quarters: number): void {
  mapRotationQuarters = ((Math.round(quarters) % 4) + 4) % 4;
}

export function getMapRotationQuarters(): number {
  return mapRotationQuarters;
}

/** Azimuth offset (deg) realizing `quarters` screen-clockwise steps under the
 *  given mirror mode (exported for tests). */
export function mapAzimuthOffsetDegWith(
  mirror: boolean,
  quarters: number
): number {
  return (mirror ? -90 : 90) * quarters;
}

function mapAzimuthOffsetDeg(): number {
  return mapAzimuthOffsetDegWith(CEILING_MIRROR, mapRotationQuarters);
}

export interface Vec2 {
  x: number;
  y: number;
}

const DEG = Math.PI / 180;

/** Core mapping with an explicit mirror flag (exported for tests). */
export function projectWith(
  mirror: boolean,
  azDeg: number,
  altDeg: number,
  radius: number,
  out?: Vec2
): Vec2 {
  const r = (1 - altDeg / 90) * radius;
  const rad = azDeg * DEG;
  const sx = mirror ? -1 : 1;
  const v = out ?? { x: 0, y: 0 };
  v.x = sx * r * Math.sin(rad);
  v.y = r * Math.cos(rad);
  return v;
}

/**
 * Rotation (radians, about z) for a marker shape that points +y (North) at
 * rest, so that it points along a compass heading on the dome.
 * Legacy (no mirror): -heading. Mirrored: +heading (mirror flips rotations).
 */
export function headingToRotationZWith(
  mirror: boolean,
  headingDeg: number
): number {
  return (mirror ? 1 : -1) * headingDeg * DEG;
}

/** Project an az/alt onto the dome: configured mirror mode + map rotation. */
export function project(
  azDeg: number,
  altDeg: number,
  radius: number,
  out?: Vec2
): Vec2 {
  return projectWith(
    CEILING_MIRROR,
    azDeg + mapAzimuthOffsetDeg(),
    altDeg,
    radius,
    out
  );
}

/**
 * Chevron/marker rotation for a compass heading, configured mirror mode +
 * map rotation. The same azimuth offset is composed into the heading so a
 * chevron keeps pointing at the (rotated) cardinal matching its heading.
 */
export function headingToRotationZ(headingDeg: number): number {
  return headingToRotationZWith(
    CEILING_MIRROR,
    headingDeg + mapAzimuthOffsetDeg()
  );
}
