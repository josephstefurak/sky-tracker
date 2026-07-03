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
 */

export const CEILING_MIRROR = true;

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

/** Project an az/alt onto the dome using the configured mirror mode. */
export function project(
  azDeg: number,
  altDeg: number,
  radius: number,
  out?: Vec2
): Vec2 {
  return projectWith(CEILING_MIRROR, azDeg, altDeg, radius, out);
}

/** Chevron/marker rotation for a compass heading, configured mirror mode. */
export function headingToRotationZ(headingDeg: number): number {
  return headingToRotationZWith(CEILING_MIRROR, headingDeg);
}
