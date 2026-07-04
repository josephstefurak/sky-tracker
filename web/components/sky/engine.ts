/**
 * SkyEngine — the dome renderer, ported from frontend/main.js.
 *
 * Faithful to the reference: same tunables, dead-reckoning model, trails,
 * label de-confliction, altitude sizing/opacity, fade-out lifecycle, and dome
 * furniture. Adapted for the ceiling mirror (all az/alt → screen mapping goes
 * through lib/projection), the polled SkyResponse contract, and the new
 * ambient layers (twilight background, sun/moon, satellite visibility,
 * aircraft categories).
 */

import * as THREE from "three";
import {
  getMapRotationQuarters,
  headingToRotationZ,
  project,
  setMapRotationQuarters as setProjectionMapRotation,
} from "@/lib/projection";
import type {
  AstroState,
  PlaneObject,
  SatObject,
  SkyObject,
} from "@/lib/types";
import {
  disposeSprite,
  drawMoonPhase,
  drawTwilightBackground,
  makeChevron,
  makeDot,
  makeGlowTexture,
  makeLabel,
  makeRotorMarker,
  makeTextSprite,
} from "./textures";

// ---------------------------------------------------------------------------
// Tunables (verbatim from frontend/main.js)
// ---------------------------------------------------------------------------
const DOME_MARGIN = 0.92; // fraction of the half-viewport the dome fills

// Dead reckoning.
const MIN_DT = 1.0; // ignore velocity from sub-second frame gaps
const VEL_CLAMP = 6.0; // max |velocity| in deg/s (guards bad data)
const MISSING_SECONDS = 30; // start fading after this long with no update
const FADE_SECONDS = 2; // fade-out duration before removal

// Trails (sampled extrapolated positions).
const TRAIL_SAMPLE_MS = 400;
const PLANE_TRAIL = 8;
const SAT_TRAIL = 12;

// Labels.
const LABEL_MIN_GAP = 20; // hide a label whose center is within this many px
const SAT_LABEL_MIN_ALT = 15; // only label satellites above this altitude
const ROUTE_MIN_ALT = 25; // only show the route line above this altitude
const PLANE_LABEL_OFFSET = 22; // callsign sits this far above the chevron
const ROUTE_LABEL_OFFSET = 11; // route line between callsign and chevron

// Marker sizes.
const SAT_DOT = 8;
const ISS_DOT = 12;

const COLORS = {
  sat: new THREE.Color(0xaaaacc), // dim blue-white
  plane: new THREE.Color(0xffa040), // amber
  iss: new THREE.Color(0xffd700), // gold
};

const PRIORITY: Record<Kind, number> = { iss: 3, plane: 2, sat: 1 };

// New-layer tunables.
const VISIBLE_PULSE_PERIOD_MS = 2000; // gentle sine pulse for visible-now sats
const GHOST_OPACITY = 0.55; // eclipsed (not sunlit) satellites
const SUN_SPRITE_PX = 30;
const MOON_SPRITE_PX = 24;
const CLIMB_ARROW_MS = 2; // |vertical rate| beyond this shows ↑/↓

type Kind = "sat" | "plane" | "iss";

export interface TrackedRecord {
  id: string;
  kind: Kind;
  color: THREE.Color;
  priority: number;
  // Dead-reckoning state (anchors in az/alt space).
  az: number;
  alt: number;
  dAz: number;
  dAlt: number;
  lastUpdated: number; // anchor time: advanced only when the position changes
  lastSeen: number; // any appearance in a snapshot; drives the 30s expiry
  // Render state.
  curAlt: number;
  pos: { x: number; y: number };
  trail: { x: number; y: number }[];
  trailLen: number;
  lastTrailSample: number;
  marker: THREE.Object3D;
  markerMaterials: (THREE.SpriteMaterial | THREE.MeshBasicMaterial)[];
  markerIsChevron: boolean;
  baseScale: number; // dots: px size; chevrons: category multiplier
  baseOpacity: number;
  trailLine: THREE.Line;
  label: THREE.Sprite | null;
  labelKey: string | null;
  routeLabel: THREE.Sprite | null;
  routeText: string | null;
  /** Latest wire object, merged across polls (HUD/spotlight reads this). */
  data: SkyObject;
}

export interface EngineStats {
  total: number;
  sat: number;
  plane: number;
  iss: number;
  lastTs: number; // unix seconds of the latest ingested snapshot (0 = none)
}

// Shortest signed angular delta b-a, in [-180, 180].
function angularDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function clampVel(v: number): number {
  return Math.max(-VEL_CLAMP, Math.min(VEL_CLAMP, v));
}

function planeLabelText(p: PlaneObject): string {
  const cs = (p.callsign || "").trim() || p.icao24;
  const vr = p.verticalRateMs;
  if (typeof vr === "number" && vr > CLIMB_ARROW_MS) return `${cs} ↑`;
  if (typeof vr === "number" && vr < -CLIMB_ARROW_MS) return `${cs} ↓`;
  return cs;
}

function satLabelColor(s: SatObject): string {
  return s.visibleNow ? "rgba(225,235,255,0.85)" : "rgba(200,205,225,0.6)";
}

export class SkyEngine {
  readonly tracked = new Map<string, TrackedRecord>();
  lastTs = 0;

  private width: number;
  private height: number;
  private radius: number;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly glowTexture: THREE.Texture;
  private readonly decorations: THREE.Object3D[] = [];

  // Ambient astro layers.
  private astro: AstroState | null = null;
  private readonly bgCanvas: HTMLCanvasElement;
  private readonly bgTexture: THREE.CanvasTexture;
  private bgMesh: THREE.Mesh;
  private bgKey = "";
  private readonly sunSprite: THREE.Sprite;
  private readonly moonCanvas: HTMLCanvasElement;
  private readonly moonTexture: THREE.CanvasTexture;
  private readonly moonMesh: THREE.Mesh;
  private moonFractionKey = -1;

  private raf = 0;
  private running = false;
  private pausedAt = 0;
  private disposed = false;

  constructor(host: HTMLElement) {
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.OrthographicCamera(
      -this.width / 2,
      this.width / 2,
      this.height / 2,
      -this.height / 2,
      -1000,
      1000
    );
    this.camera.position.z = 10;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "low-power",
    });
    // Modest projector hardware: cap the backing-store resolution.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(this.width, this.height);
    host.appendChild(this.renderer.domElement);

    this.radius = this.computeRadius();
    this.glowTexture = makeGlowTexture();

    // Twilight background disc (behind everything).
    this.bgCanvas = document.createElement("canvas");
    this.bgTexture = new THREE.CanvasTexture(this.bgCanvas);
    this.bgTexture.minFilter = THREE.LinearFilter;
    this.bgMesh = new THREE.Mesh(
      new THREE.CircleGeometry(this.radius, 64),
      new THREE.MeshBasicMaterial({ map: this.bgTexture, depthTest: false })
    );
    this.bgMesh.renderOrder = -1;
    this.bgMesh.visible = false; // until the first astro snapshot
    this.scene.add(this.bgMesh);

    // Sun glow sprite.
    this.sunSprite = makeDot(
      this.glowTexture,
      new THREE.Color(0xffc26b),
      SUN_SPRITE_PX,
      0.9
    );
    this.sunSprite.renderOrder = 2;
    this.sunSprite.visible = false;
    this.scene.add(this.sunSprite);

    // Moon phase mesh (a plane, so it can rotate its bright limb).
    this.moonCanvas = document.createElement("canvas");
    this.moonTexture = new THREE.CanvasTexture(this.moonCanvas);
    this.moonTexture.minFilter = THREE.LinearFilter;
    this.moonMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(MOON_SPRITE_PX, MOON_SPRITE_PX),
      new THREE.MeshBasicMaterial({
        map: this.moonTexture,
        transparent: true,
        depthTest: false,
      })
    );
    this.moonMesh.renderOrder = 2;
    this.moonMesh.visible = false;
    this.scene.add(this.moonMesh);

    this.buildDome();
    window.addEventListener("resize", this.onResize);

    this.running = true;
    this.raf = requestAnimationFrame(this.animate);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Feed a snapshot (from /api/sky or the simulate() debug hook). */
  ingest(msg: {
    ts?: number;
    objects?: SkyObject[];
    astro?: AstroState;
  }): void {
    if (this.disposed) return;
    const now = performance.now();
    if (typeof msg.ts === "number") this.lastTs = msg.ts;

    for (const data of msg.objects ?? []) {
      if (!data || !data.id) continue;
      let rec = this.tracked.get(data.id);
      if (!rec) {
        rec = this.makeRecord(data, now);
        this.tracked.set(data.id, rec);
        this.ensureLabel(rec);
        this.ensureRouteLabel(rec);
        continue;
      }

      rec.lastSeen = now; // keep it alive even on duplicate re-broadcasts
      this.mergeData(rec, data);
      this.ensureLabel(rec);
      this.ensureRouteLabel(rec);

      // Only a genuinely new position is a velocity sample / anchor;
      // duplicates leave the extrapolation running off the last velocity.
      if (data.az === rec.az && data.alt === rec.alt) continue;

      const dt = (now - rec.lastUpdated) / 1000;
      if (dt >= MIN_DT) {
        rec.dAz = clampVel(angularDelta(rec.az, data.az) / dt);
        rec.dAlt = clampVel((data.alt - rec.alt) / dt);
      }
      rec.az = data.az;
      rec.alt = data.alt;
      rec.lastUpdated = now;
      // Do NOT snap the rendered position; the extrapolation loop handles it,
      // which keeps motion continuous when corrections arrive.
    }

    if (msg.astro) {
      this.astro = msg.astro;
      this.updateAstroLayers();
    }
  }

  stats(): EngineStats {
    let sat = 0;
    let plane = 0;
    let iss = 0;
    for (const r of this.tracked.values()) {
      if (r.kind === "iss") iss++;
      else if (r.kind === "plane") plane++;
      else sat++;
    }
    return { total: this.tracked.size, sat, plane, iss, lastTs: this.lastTs };
  }

  /** Fresh (non-fading) records ranked for the HUD spotlight. */
  spotlightCandidates(): TrackedRecord[] {
    const now = performance.now();
    const out: TrackedRecord[] = [];
    for (const rec of this.tracked.values()) {
      if ((now - rec.lastSeen) / 1000 > MISSING_SECONDS) continue;
      out.push(rec);
    }
    const score = (rec: TrackedRecord): number => {
      if (rec.kind === "iss" && rec.curAlt > 10) return 4000 + rec.curAlt;
      if (rec.kind === "sat" && (rec.data as SatObject).visibleNow)
        return 3000 + rec.curAlt;
      if (rec.kind === "plane") {
        const p = rec.data as PlaneObject;
        if (p.airline || p.origin) return 2000 + rec.curAlt;
      }
      return rec.curAlt;
    };
    return out.sort((a, b) => score(b) - score(a)).slice(0, 8);
  }

  /** Pause rendering (tab hidden). Timestamps are shifted on resume. */
  pause(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.pausedAt = performance.now();
  }

  /**
   * Re-aim the dome's compass (map rotation, screen-clockwise quarter turns).
   * Markers and labels pick the new mapping up on the next frame because
   * every position flows through project(); this refreshes what CACHES
   * projected positions: dome furniture (cardinal + ring labels), screen-
   * space trail samples (cleared, as on resize), and the astro layers
   * (sun, moon, horizon glow band).
   */
  setMapRotationQuarters(quarters: number): void {
    if (this.disposed) return;
    const before = getMapRotationQuarters();
    setProjectionMapRotation(quarters);
    if (getMapRotationQuarters() === before) return;
    this.buildDome();
    for (const rec of this.tracked.values()) rec.trail.length = 0;
    this.bgKey = ""; // glow band must repaint toward the sun's moved dome point
    this.updateAstroLayers();
  }

  resume(): void {
    if (this.running || this.disposed) return;
    // Shift every wall-clock anchor by the pause duration so dead reckoning
    // does not extrapolate across the gap; the next poll re-anchors.
    const delta = performance.now() - this.pausedAt;
    for (const rec of this.tracked.values()) {
      rec.lastUpdated += delta;
      rec.lastSeen += delta;
      rec.lastTrailSample += delta;
    }
    this.running = true;
    this.raf = requestAnimationFrame(this.animate);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);

    for (const rec of this.tracked.values()) this.disposeRecord(rec);
    this.tracked.clear();
    this.clearDecorations();

    this.bgMesh.geometry.dispose();
    (this.bgMesh.material as THREE.Material).dispose();
    this.bgTexture.dispose();
    disposeSprite(this.sunSprite);
    this.moonMesh.geometry.dispose();
    (this.moonMesh.material as THREE.Material).dispose();
    this.moonTexture.dispose();
    this.glowTexture.dispose();

    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  private makeRecord(data: SkyObject, now: number): TrackedRecord {
    const kind: Kind =
      data.type === "plane" ? "plane" : data.isISS ? "iss" : "sat";
    const color = COLORS[kind];

    let marker: THREE.Object3D;
    let markerMaterials: (THREE.SpriteMaterial | THREE.MeshBasicMaterial)[];
    let markerIsChevron = false;
    let baseOpacity = 1;
    let baseScale = 1;
    let trailLen: number;

    if (kind === "plane") {
      const p = data as PlaneObject;
      if (p.category === "rotorcraft") {
        const rotor = makeRotorMarker(color);
        marker = rotor.group;
        markerMaterials = rotor.materials;
      } else {
        const chevron = makeChevron(color);
        marker = chevron;
        markerMaterials = [chevron.material as THREE.MeshBasicMaterial];
        markerIsChevron = true;
        baseScale =
          p.category === "heavy"
            ? 1.25
            : p.category === "light" || p.category === "small"
              ? 0.85
              : 1;
      }
      trailLen = PLANE_TRAIL;
    } else {
      baseOpacity = kind === "iss" ? 1.0 : 0.9;
      baseScale = kind === "iss" ? ISS_DOT : SAT_DOT;
      const dot = makeDot(this.glowTexture, color, baseScale, baseOpacity);
      marker = dot;
      markerMaterials = [dot.material];
      trailLen = SAT_TRAIL;
    }
    marker.renderOrder = 3;
    this.scene.add(marker);

    // Trail line (vertex colors fade to black = invisible on the dark dome).
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(trailLen * 3), 3)
    );
    trailGeo.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(trailLen * 3), 3)
    );
    const trailMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });
    const trailLine = new THREE.Line(trailGeo, trailMat);
    trailLine.renderOrder = 1;
    trailLine.frustumCulled = false;
    this.scene.add(trailLine);

    return {
      id: data.id,
      kind,
      color,
      priority: PRIORITY[kind],
      az: data.az,
      alt: data.alt,
      dAz: 0,
      dAlt: 0,
      lastUpdated: now,
      lastSeen: now,
      curAlt: data.alt,
      pos: project(data.az, data.alt, this.radius),
      trail: [],
      trailLen,
      lastTrailSample: now,
      marker,
      markerMaterials,
      markerIsChevron,
      baseScale,
      baseOpacity,
      trailLine,
      label: null,
      labelKey: null,
      routeLabel: null,
      routeText: null,
      data: { ...data },
    };
  }

  /** Merge a fresh wire object into the record's data (enrichment may arrive
   *  on later polls; never let a missing field erase a remembered one). */
  private mergeData(rec: TrackedRecord, data: SkyObject): void {
    const target = rec.data as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) target[key] = value;
    }
  }

  private disposeRecord(rec: TrackedRecord): void {
    this.scene.remove(rec.marker);
    rec.marker.traverse((obj) => {
      // Never dispose a Sprite's geometry: three shares ONE geometry across
      // all sprites, so disposing it would churn every sprite on screen.
      if ((obj as THREE.Sprite).isSprite) return;
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const mat of rec.markerMaterials) mat.dispose();

    this.scene.remove(rec.trailLine);
    rec.trailLine.geometry.dispose();
    (rec.trailLine.material as THREE.Material).dispose();

    if (rec.label) {
      this.scene.remove(rec.label);
      disposeSprite(rec.label);
    }
    if (rec.routeLabel) {
      this.scene.remove(rec.routeLabel);
      disposeSprite(rec.routeLabel);
    }
  }

  // -------------------------------------------------------------------------
  // Labels (rebuilt only when their text/color actually changes)
  // -------------------------------------------------------------------------

  private ensureLabel(rec: TrackedRecord): void {
    let text = "";
    let color = "";
    let px = 0;
    if (rec.kind === "plane") {
      text = planeLabelText(rec.data as PlaneObject);
      color = "rgba(255,255,255,0.7)";
      px = 11;
    } else if (rec.kind === "iss") {
      text = "ISS";
      color = "rgba(255,215,0,0.95)";
      px = 12;
    } else {
      const s = rec.data as SatObject;
      text = (s.name || "").trim();
      color = satLabelColor(s);
      px = 10;
    }

    const key = text ? `${text}|${color}|${px}` : null;
    if (key === rec.labelKey) return;
    if (rec.label) {
      this.scene.remove(rec.label);
      disposeSprite(rec.label);
      rec.label = null;
    }
    rec.labelKey = key;
    if (!key) return;
    const label = makeLabel(text, color, px);
    label.renderOrder = 4;
    label.visible = false;
    this.scene.add(label);
    rec.label = label;
  }

  /** Lazily build (or rebuild) a plane's "ORIG → DEST" route label. */
  private ensureRouteLabel(rec: TrackedRecord): void {
    if (rec.kind !== "plane") return;
    const p = rec.data as PlaneObject;
    if (!p.origin || !p.destination) return;
    const text = `${p.origin} → ${p.destination}`;
    if (rec.routeLabel && rec.routeText === text) return;
    if (rec.routeLabel) {
      this.scene.remove(rec.routeLabel);
      disposeSprite(rec.routeLabel);
    }
    const lbl = makeLabel(text, "rgba(255,255,255,0.6)", 10);
    lbl.renderOrder = 4;
    lbl.visible = false;
    this.scene.add(lbl);
    rec.routeLabel = lbl;
    rec.routeText = text;
  }

  // -------------------------------------------------------------------------
  // Dome furniture (rebuilt only on resize)
  // -------------------------------------------------------------------------

  private computeRadius(): number {
    return (Math.min(this.width, this.height) / 2) * DOME_MARGIN;
  }

  private addDecoration(obj: THREE.Object3D, renderOrder: number): void {
    obj.renderOrder = renderOrder;
    this.scene.add(obj);
    this.decorations.push(obj);
  }

  private makeRing(
    r: number,
    color: number,
    opacity: number,
    dashed: boolean
  ): THREE.Line {
    const segments = 128;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = dashed
      ? new THREE.LineDashedMaterial({
          color,
          transparent: true,
          opacity,
          dashSize: 6,
          gapSize: 6,
          depthTest: false,
        })
      : new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity,
          depthTest: false,
        });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    return line;
  }

  private clearDecorations(): void {
    for (const o of this.decorations) {
      this.scene.remove(o);
      // As in disposeRecord: never dispose a Sprite's geometry — three shares
      // ONE geometry across all sprites, and map-rotation rebuilds would
      // churn every sprite on screen (labels, dots, sun) on each press.
      const mesh = o as THREE.Mesh;
      if (mesh.geometry && !(o as THREE.Sprite).isSprite)
        mesh.geometry.dispose();
      const mat = (o as THREE.Mesh).material as THREE.Material & {
        map?: THREE.Texture;
      };
      if (mat) {
        if (mat.map) mat.map.dispose();
        mat.dispose();
      }
    }
    this.decorations.length = 0;
  }

  private buildDome(): void {
    this.clearDecorations();

    // Faint horizon circle (alt 0).
    this.addDecoration(this.makeRing(this.radius, 0x3a4456, 0.5, false), 0);

    // Dashed altitude reference rings: 60 deg (overhead zone), 30 deg (mid-sky).
    for (const deg of [60, 30]) {
      const r = (1 - deg / 90) * this.radius;
      this.addDecoration(this.makeRing(r, 0xffffff, 0.12, true), 0);
      // Angle label at the north (top) point of the ring.
      const lbl = makeLabel(`${deg}°`, "rgba(255,255,255,0.3)", 9);
      const p = project(0, deg, this.radius);
      lbl.position.set(p.x, p.y, 0);
      this.addDecoration(lbl, 4);
    }

    // Center crosshair + "overhead" label at the zenith.
    const chGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-5, 0, 0),
      new THREE.Vector3(5, 0, 0),
      new THREE.Vector3(0, -5, 0),
      new THREE.Vector3(0, 5, 0),
    ]);
    const chMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.25,
      depthTest: false,
    });
    this.addDecoration(new THREE.LineSegments(chGeo, chMat), 0);
    const overhead = makeLabel("overhead", "rgba(255,255,255,0.25)", 9);
    overhead.position.set(0, -12, 0);
    this.addDecoration(overhead, 4);

    // Cardinal labels just inside the horizon ring. Positions flow through
    // project(), so the ceiling mirror puts E/W on the correct sides for a
    // viewer looking up and the map rotation re-seats all four — while each
    // glyph stays upright (sprites always face the camera, never rotated).
    const cardinals = [
      { text: "N", az: 0 },
      { text: "E", az: 90 },
      { text: "S", az: 180 },
      { text: "W", az: 270 },
    ];
    for (const c of cardinals) {
      const sprite = makeTextSprite(c.text, "rgba(150,165,190,0.7)", 40);
      const p = project(c.az, 0, this.radius);
      sprite.position.set(p.x * 0.94, p.y * 0.94, 0); // nudge inward
      this.addDecoration(sprite, 4);
    }
  }

  // -------------------------------------------------------------------------
  // Ambient astro layers
  // -------------------------------------------------------------------------

  private updateAstroLayers(): void {
    const astro = this.astro;
    if (!astro) return;

    // Twilight background — regenerate only when the look would change.
    const sunHorizon = project(astro.sun.az, 0, 1); // unit direction, mirrored
    const inGlowBand = astro.sun.alt >= -8 && astro.sun.alt <= 2;
    const key = [
      astro.twilight,
      inGlowBand ? Math.round(astro.sun.az / 2) : "x",
      inGlowBand ? Math.round(astro.sun.alt / 2) : "x",
    ].join("|");
    if (key !== this.bgKey) {
      this.bgKey = key;
      drawTwilightBackground(
        this.bgCanvas,
        astro.twilight,
        astro.sun.alt,
        inGlowBand ? sunHorizon : null
      );
      this.bgTexture.needsUpdate = true;
      this.bgMesh.visible = true;
    }

    // Sun glow, only while actually up.
    if (astro.sun.alt > 0) {
      const p = project(astro.sun.az, astro.sun.alt, this.radius);
      this.sunSprite.position.set(p.x, p.y, 0);
      this.sunSprite.visible = true;
    } else {
      this.sunSprite.visible = false;
    }

    // Moon with its phase, bright limb rotated toward the sun's dome point.
    if (astro.moon.alt > 0) {
      const moonPos = project(astro.moon.az, astro.moon.alt, this.radius);
      this.moonMesh.position.set(moonPos.x, moonPos.y, 0);

      const fractionKey = Math.round(astro.moon.illuminatedFraction * 100);
      if (fractionKey !== this.moonFractionKey) {
        this.moonFractionKey = fractionKey;
        drawMoonPhase(this.moonCanvas, astro.moon.illuminatedFraction);
        this.moonTexture.needsUpdate = true;
      }

      // The texture paints the bright limb toward +x; point +x at the sun.
      const sunEdge = project(astro.sun.az, 0, this.radius);
      this.moonMesh.rotation.z = Math.atan2(
        sunEdge.y - moonPos.y,
        sunEdge.x - moonPos.x
      );
      this.moonMesh.visible = true;
    } else {
      this.moonMesh.visible = false;
    }
  }

  // -------------------------------------------------------------------------
  // Animation loop
  // -------------------------------------------------------------------------

  private updateTrail(rec: TrackedRecord, fade: number): void {
    const n = rec.trail.length;
    const posAttr = rec.trailLine.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute;
    const colAttr = rec.trailLine.geometry.getAttribute(
      "color"
    ) as THREE.BufferAttribute;
    const c = rec.color;
    const posArr = posAttr.array as Float32Array;
    const colArr = colAttr.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const p = rec.trail[i];
      posArr[i * 3] = p.x;
      posArr[i * 3 + 1] = p.y;
      posArr[i * 3 + 2] = 0;
      // Fade oldest -> newest by scaling rgb toward black.
      const f = n > 1 ? i / (n - 1) : 1;
      colArr[i * 3] = c.r * f;
      colArr[i * 3 + 1] = c.g * f;
      colArr[i * 3 + 2] = c.b * f;
    }
    rec.trailLine.geometry.setDrawRange(0, n);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    (rec.trailLine.material as THREE.LineBasicMaterial).opacity = 0.7 * fade;
  }

  private fadeFor(rec: TrackedRecord, now: number): number {
    const sinceSeen = (now - rec.lastSeen) / 1000;
    return sinceSeen > MISSING_SECONDS
      ? Math.max(0, 1 - (sinceSeen - MISSING_SECONDS) / FADE_SECONDS)
      : 1;
  }

  /** Higher-priority labels claim their spot first; a lower-priority label
   *  within LABEL_MIN_GAP px of one already placed is hidden. */
  private resolveLabels(now: number): void {
    const candidates: TrackedRecord[] = [];
    for (const rec of this.tracked.values()) {
      if (!rec.label) continue;
      rec.label.visible = false;
      const show =
        rec.kind === "plane" || rec.kind === "iss"
          ? true
          : rec.curAlt > SAT_LABEL_MIN_ALT;
      if (show) candidates.push(rec);
    }
    candidates.sort((a, b) => b.priority - a.priority);

    const placed: { x: number; y: number }[] = [];
    const gapSq = LABEL_MIN_GAP * LABEL_MIN_GAP;
    for (const rec of candidates) {
      const off =
        rec.kind === "sat" ? 12 : rec.kind === "iss" ? 16 : PLANE_LABEL_OFFSET;
      const lx = rec.pos.x;
      const ly = rec.pos.y + off;

      let ok = true;
      for (const pl of placed) {
        const dx = lx - pl.x;
        const dy = ly - pl.y;
        if (dx * dx + dy * dy < gapSq) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      rec.label!.visible = true;
      rec.label!.position.set(lx, ly, 0);
      rec.label!.material.opacity = this.fadeFor(rec, now);
      placed.push({ x: lx, y: ly });
    }

    // Route lines: shown only when the callsign label survived de-confliction
    // and the plane is high enough.
    for (const rec of this.tracked.values()) {
      if (!rec.routeLabel) continue;
      const show =
        !!rec.label && rec.label.visible && rec.curAlt > ROUTE_MIN_ALT;
      rec.routeLabel.visible = show;
      if (!show) continue;
      rec.routeLabel.position.set(rec.pos.x, rec.pos.y + ROUTE_LABEL_OFFSET, 0);
      rec.routeLabel.material.opacity = this.fadeFor(rec, now);
    }
  }

  private animate = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.animate);
    const now = performance.now();

    const expired: string[] = [];
    for (const rec of this.tracked.values()) {
      // Fade out and expire objects missing (not re-broadcast) for too long.
      const sinceSeen = (now - rec.lastSeen) / 1000;
      let fade = 1;
      if (sinceSeen > MISSING_SECONDS) {
        fade = 1 - (sinceSeen - MISSING_SECONDS) / FADE_SECONDS;
        if (fade <= 0) {
          expired.push(rec.id);
          continue;
        }
      }

      // Dead reckoning: extrapolate from the last real position anchor.
      const elapsed = (now - rec.lastUpdated) / 1000;
      const curAz = rec.az + rec.dAz * elapsed;
      const curAlt = Math.max(0, Math.min(90, rec.alt + rec.dAlt * elapsed));
      rec.curAlt = curAlt;
      project(curAz, curAlt, this.radius, rec.pos);
      rec.marker.position.set(rec.pos.x, rec.pos.y, 0);

      // Altitude-based sizing: smaller near the horizon, larger overhead.
      const sizeFactor = 0.5 + 0.5 * (curAlt / 90);

      if (rec.kind === "plane") {
        const p = rec.data as PlaneObject;
        const s = sizeFactor * rec.baseScale;
        rec.marker.scale.set(s, s, 1);
        if (rec.markerIsChevron && typeof p.heading === "number") {
          rec.marker.rotation.z = headingToRotationZ(p.heading);
        }
        // Altitude hint: lower toward the horizon = more transparent.
        const altOpacity = Math.max(
          0.25,
          Math.min(1, 0.25 + 0.75 * (curAlt / 60))
        );
        for (const mat of rec.markerMaterials) {
          mat.opacity = altOpacity * fade;
        }
      } else {
        const d = rec.data as SatObject;
        let s = rec.baseScale * sizeFactor;
        let op = rec.baseOpacity;
        if (d.visibleNow) {
          // Naked-eye pass: brighter, larger, gently pulsing.
          const pulse =
            1 + 0.15 * Math.sin((now * 2 * Math.PI) / VISIBLE_PULSE_PERIOD_MS);
          s *= 1.2 * pulse;
          op = 1;
        } else if (!d.sunlit) {
          op *= GHOST_OPACITY; // in Earth's shadow: a ghost of itself
        }
        rec.marker.scale.set(s, s, 1);
        for (const mat of rec.markerMaterials) {
          mat.opacity = op * fade;
        }
      }

      // Sample the extrapolated position into the trail.
      if (now - rec.lastTrailSample >= TRAIL_SAMPLE_MS) {
        rec.trail.push({ x: rec.pos.x, y: rec.pos.y });
        if (rec.trail.length > rec.trailLen) rec.trail.shift();
        rec.lastTrailSample = now;
      }
      this.updateTrail(rec, fade);
    }

    for (const id of expired) {
      const rec = this.tracked.get(id);
      if (rec) {
        this.disposeRecord(rec);
        this.tracked.delete(id);
      }
    }

    this.resolveLabels(now);
    this.renderer.render(this.scene, this.camera);
  };

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------

  private onResize = (): void => {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.camera.left = -this.width / 2;
    this.camera.right = this.width / 2;
    this.camera.top = this.height / 2;
    this.camera.bottom = -this.height / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
    this.radius = this.computeRadius();
    this.buildDome();

    // Background disc tracks the dome radius.
    this.bgMesh.geometry.dispose();
    this.bgMesh.geometry = new THREE.CircleGeometry(this.radius, 64);
    this.bgKey = ""; // force repaint at the new size
    this.updateAstroLayers();

    // Trails were captured in the old scale; clear them to avoid a jump.
    for (const rec of this.tracked.values()) rec.trail.length = 0;
  };
}
