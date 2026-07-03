/**
 * Texture, sprite, and marker factories for the dome renderer. Ported from
 * frontend/main.js (glow dots, text sprites, labels, chevron) and extended
 * with the moon-phase painter and the twilight background painter.
 *
 * Everything here creates resources lazily inside functions (never at module
 * scope) so this file is safe to import during SSR.
 */

import * as THREE from "three";
import type { TwilightState } from "@/lib/types";

export const FONT_STACK =
  "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// --- Glow texture (shared by all dots) --------------------------------------

export function makeGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  );
  g.addColorStop(0.0, "rgba(255,255,255,1.0)");
  g.addColorStop(0.25, "rgba(255,255,255,0.85)");
  g.addColorStop(0.6, "rgba(255,255,255,0.25)");
  g.addColorStop(1.0, "rgba(255,255,255,0.0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

// --- Text sprites ------------------------------------------------------------

/** Plain text sprite (used for the static cardinal labels). */
export function makeTextSprite(
  text: string,
  color: string,
  fontSize = 44
): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `bold ${fontSize}px ${FONT_STACK}`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(64, 32, 1);
  return sprite;
}

/** Object label sized so the rendered glyph height is ~pxHeight on screen. */
export function makeLabel(
  text: string,
  color: string,
  pxHeight: number
): THREE.Sprite {
  const fontPx = 64; // render hi-res, scale down for crispness
  const pad = 6;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `600 ${fontPx}px ${FONT_STACK}`;
  const textW = Math.max(1, Math.ceil(measure.measureText(text).width));

  const canvas = document.createElement("canvas");
  canvas.width = textW + pad * 2;
  canvas.height = Math.ceil(fontPx * 1.4);
  const ctx = canvas.getContext("2d")!;
  ctx.font = `600 ${fontPx}px ${FONT_STACK}`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  const screenH = pxHeight * 1.4; // glyph itself is ~pxHeight
  sprite.scale.set((screenH * canvas.width) / canvas.height, screenH, 1);
  return sprite;
}

export function disposeSprite(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}

// --- Markers ------------------------------------------------------------------

/** Glowing dot (satellites / ISS). */
export function makeDot(
  glow: THREE.Texture,
  color: THREE.Color,
  size: number,
  opacity: number
): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: glow,
    color,
    transparent: true,
    opacity,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  return sprite;
}

/** Chevron / arrowhead pointing +y (North); rotated per-frame to its heading. */
export function makeChevron(color: THREE.Color): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(0, 9); // tip
  shape.lineTo(7, -7); // right wing
  shape.lineTo(0, -3); // inner notch
  shape.lineTo(-7, -7); // left wing
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  return new THREE.Mesh(geo, mat);
}

/** Rotorcraft marker: a ring with a center dot (heading-agnostic). */
export function makeRotorMarker(color: THREE.Color): {
  group: THREE.Group;
  materials: THREE.MeshBasicMaterial[];
} {
  const group = new THREE.Group();
  const ringGeo = new THREE.RingGeometry(4.6, 6.4, 24);
  const ringMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  const dotGeo = new THREE.CircleGeometry(2.1, 12);
  const dotMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  group.add(new THREE.Mesh(ringGeo, ringMat));
  group.add(new THREE.Mesh(dotGeo, dotMat));
  return { group, materials: [ringMat, dotMat] };
}

// --- Moon phase ----------------------------------------------------------------

/**
 * Paint the moon disc with the bright limb facing +x. The mesh showing this
 * texture is rotated so +x points at the sun's dome direction, which keeps
 * the phase physically correct in both mirror modes.
 */
export function drawMoonPhase(
  canvas: HTMLCanvasElement,
  illuminatedFraction: number
): void {
  const size = 64;
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const r = 26;

  // Dark side (barely-there earthshine grey).
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(40,46,60,0.9)";
  ctx.fill();

  // Lit side: right semicircle closed by the terminator ellipse.
  const f = Math.min(1, Math.max(0, illuminatedFraction));
  const k = 2 * f - 1; // terminator semi-axis, signed
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false);
  if (k >= 0) {
    // Gibbous: terminator bulges into the dark (left) half.
    ctx.ellipse(cx, cy, r * k, r, 0, Math.PI / 2, Math.PI * 1.5, false);
  } else {
    // Crescent: terminator bulges into the lit (right) half.
    ctx.ellipse(cx, cy, r * -k, r, 0, Math.PI / 2, -Math.PI / 2, true);
  }
  ctx.closePath();
  ctx.fillStyle = "#e9e7dc";
  ctx.fill();

  // Faint rim so the dark limb reads against the sky.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(215,225,245,0.28)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// --- Twilight background ----------------------------------------------------------

const TWILIGHT_TONES: Record<TwilightState, { center: string; edge: string }> = {
  day: { center: "#0d1b33", edge: "#17294b" },
  civil: { center: "#0a1226", edge: "#122145" },
  nautical: { center: "#070d1d", edge: "#0e1a36" },
  astronomical: { center: "#04070f", edge: "#0a1226" },
  night: { center: "#02040a", edge: "#060d1c" },
};

/**
 * Paint the dome background: a radial sky gradient for the twilight state,
 * plus a warm horizon glow toward the sun while it is within [-8, +2] deg of
 * the horizon. `sunDir` is the UNIT direction of the sun's horizon point in
 * world coords (already mirrored by the caller via project()).
 */
export function drawTwilightBackground(
  canvas: HTMLCanvasElement,
  twilight: TwilightState,
  sunAltDeg: number,
  sunDir: { x: number; y: number } | null
): void {
  const size = 512;
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const tones = TWILIGHT_TONES[twilight];

  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, tones.center);
  g.addColorStop(0.82, tones.edge);
  g.addColorStop(1, tones.center); // settle back down right at the horizon rim
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();

  if (sunDir && sunAltDeg >= -8 && sunAltDeg <= 2) {
    // Strength peaks with the sun right at the horizon.
    const strength = 1 - Math.min(1, Math.abs(sunAltDeg + 3) / 5) * 0.55;
    // World +y = canvas up; canvas y grows downward.
    const gx = c + sunDir.x * c;
    const gy = c - sunDir.y * c;
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, size * 0.42);
    glow.addColorStop(0, `rgba(255,150,60,${(0.34 * strength).toFixed(3)})`);
    glow.addColorStop(0.45, `rgba(220,110,50,${(0.16 * strength).toFixed(3)})`);
    glow.addColorStop(1, "rgba(180,80,40,0)");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
}
