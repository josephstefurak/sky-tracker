import * as THREE from "three";

// One-line swap to wss://<cloud-run-host>/ws when this is deployed later.
const WS_URL = 'ws://192.168.1.65:8080/ws'; // use your actual IP

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const DOME_MARGIN = 0.92;      // fraction of the half-viewport the dome fills

// Dead reckoning.
const MIN_DT = 1.0;            // ignore velocity from sub-second frame gaps
const VEL_CLAMP = 6.0;         // max |velocity| in deg/s (guards bad data)
const MISSING_SECONDS = 30;    // start fading after this long with no update
const FADE_SECONDS = 2;        // fade-out duration before removal

// Trails (sampled extrapolated positions).
const TRAIL_SAMPLE_MS = 400;
const PLANE_TRAIL = 8;
const SAT_TRAIL = 12;

// Labels.
const LABEL_MIN_GAP = 20;      // hide a label whose center is within this many px
const SAT_LABEL_MIN_ALT = 15;  // only label satellites above this altitude
const ROUTE_MIN_ALT = 25;      // only show the route line above this altitude
const PLANE_LABEL_OFFSET = 22; // callsign sits this far above the chevron
const ROUTE_LABEL_OFFSET = 11; // route line between callsign and chevron

// Marker sizes.
const SAT_DOT = 8;
const ISS_DOT = 12;

const COLORS = {
  sat: new THREE.Color(0xaaaacc),   // dim blue-white
  plane: new THREE.Color(0xffa040), // amber
  iss: new THREE.Color(0xffd700),   // gold
};

const PRIORITY = { iss: 3, plane: 2, sat: 1 };

// ---------------------------------------------------------------------------
// Scene / camera / renderer
// ---------------------------------------------------------------------------
let width = window.innerWidth;
let height = window.innerHeight;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.OrthographicCamera(
  -width / 2, width / 2, height / 2, -height / 2, -1000, 1000
);
camera.position.z = 10;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(width, height);
document.body.appendChild(renderer.domElement);

let radius = computeRadius();

function computeRadius() {
  return (Math.min(width, height) / 2) * DOME_MARGIN;
}

// ---------------------------------------------------------------------------
// Coordinate mapping
// ---------------------------------------------------------------------------
// Provided dome mapping: center = zenith (alt 90), edge = horizon (alt 0).
function toCanvas(az, alt, radius) {
  const r = (1 - alt / 90) * radius;
  const rad = (az * Math.PI) / 180;
  return { x: r * Math.sin(rad), y: -r * Math.cos(rad) };
}

// Three.js has +y up, so flip the canvas y to put North at the top of the
// screen (and East to the right). The same transform is used for everything,
// so dots, labels, and the ring stay mutually consistent.
function worldPos(az, alt) {
  const c = toCanvas(az, alt, radius);
  return { x: c.x, y: -c.y };
}

// Shortest signed angular delta b-a, in [-180, 180].
function angularDelta(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function clampVel(v) {
  return Math.max(-VEL_CLAMP, Math.min(VEL_CLAMP, v));
}

// ---------------------------------------------------------------------------
// Shared textures / marker + label factories
// ---------------------------------------------------------------------------
const glowTexture = makeGlowTexture();

function makeGlowTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(
    size / 2, size / 2, 0, size / 2, size / 2, size / 2
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

// Plain text sprite (used for the static cardinal labels).
function makeTextSprite(text, color, fontSize = 44) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.font = `bold ${fontSize}px -apple-system, Helvetica, Arial, sans-serif`;
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

// Object label sized so the rendered glyph height is ~pxHeight on screen.
function makeLabel(text, color, pxHeight) {
  const fontPx = 64; // render hi-res, scale down for crispness
  const pad = 6;
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `600 ${fontPx}px -apple-system, Helvetica, Arial, sans-serif`;
  const textW = Math.ceil(measure.measureText(text).width);

  const canvas = document.createElement("canvas");
  canvas.width = textW + pad * 2;
  canvas.height = Math.ceil(fontPx * 1.4);
  const ctx = canvas.getContext("2d");
  ctx.font = `600 ${fontPx}px -apple-system, Helvetica, Arial, sans-serif`;
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
  // Canvas height maps to pxHeight*1.4 on screen, so the glyph is ~pxHeight.
  const screenH = pxHeight * 1.4;
  sprite.scale.set((screenH * canvas.width) / canvas.height, screenH, 1);
  return sprite;
}

// Glowing dot (satellites / ISS).
function makeDot(color, size, opacity) {
  const mat = new THREE.SpriteMaterial({
    map: glowTexture,
    color: color,
    transparent: true,
    opacity: opacity,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  return sprite;
}

// Chevron / arrowhead pointing +y (North); rotated per-frame to its heading.
function makeChevron(color) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 9);    // tip
  shape.lineTo(7, -7);   // right wing
  shape.lineTo(0, -3);   // inner notch
  shape.lineTo(-7, -7);  // left wing
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshBasicMaterial({
    color: color,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  return new THREE.Mesh(geo, mat);
}

// ---------------------------------------------------------------------------
// Static dome furniture: horizon + altitude rings, cardinals, center marker
// ---------------------------------------------------------------------------
// Everything here is rebuilt only on resize (never per-frame), so it is cheap
// to dispose and recreate as one group.
const decorations = [];

function addDecoration(obj, renderOrder) {
  obj.renderOrder = renderOrder;
  scene.add(obj);
  decorations.push(obj);
}

function makeRing(r, color, opacity, dashed) {
  const segments = 128;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = dashed
    ? new THREE.LineDashedMaterial({
      color, transparent: true, opacity, dashSize: 6, gapSize: 6, depthTest: false,
    })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
  const line = new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  return line;
}

function buildDome() {
  for (const o of decorations) {
    scene.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  }
  decorations.length = 0;

  // Faint horizon circle (alt 0).
  addDecoration(makeRing(radius, 0x3a4456, 0.5, false), 0);

  // Dashed altitude reference rings: 60 deg (overhead zone), 30 deg (mid-sky).
  for (const deg of [60, 30]) {
    const r = (1 - deg / 90) * radius;
    addDecoration(makeRing(r, 0xffffff, 0.12, true), 0);
    // Angle label at the north (top) point of the ring.
    const lbl = makeLabel(`${deg}°`, "rgba(255,255,255,0.3)", 9);
    const p = worldPos(0, deg);
    lbl.position.set(p.x, p.y, 0);
    addDecoration(lbl, 4);
  }

  // Center crosshair + "overhead" label at the zenith.
  const chGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-5, 0, 0), new THREE.Vector3(5, 0, 0),
    new THREE.Vector3(0, -5, 0), new THREE.Vector3(0, 5, 0),
  ]);
  const chMat = new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.25, depthTest: false,
  });
  addDecoration(new THREE.LineSegments(chGeo, chMat), 0);
  const overhead = makeLabel("overhead", "rgba(255,255,255,0.25)", 9);
  overhead.position.set(0, -12, 0);
  addDecoration(overhead, 4);

  // Cardinal labels sit just inside the horizon ring (alt 0).
  const cardinals = [
    { text: "N", az: 0 },
    { text: "E", az: 90 },
    { text: "S", az: 180 },
    { text: "W", az: 270 },
  ];
  for (const c of cardinals) {
    const sprite = makeTextSprite(c.text, "rgba(150,165,190,0.7)", 40);
    const p = worldPos(c.az, 0);
    // Nudge inward so the glyph isn't clipped at the edge.
    sprite.position.set(p.x * 0.94, p.y * 0.94, 0);
    addDecoration(sprite, 4);
  }
}

buildDome();

// ---------------------------------------------------------------------------
// Legend (bottom-left DOM overlay)
// ---------------------------------------------------------------------------
function buildLegend() {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "left:14px",
    "bottom:12px",
    "font:11px -apple-system, Helvetica, Arial, sans-serif",
    "line-height:1.55",
    "opacity:0.7",
    "pointer-events:none",
    "user-select:none",
  ].join(";");
  el.innerHTML =
    '<div style="color:#AAAACC">● satellites</div>' +
    '<div style="color:#FFA040">▶ planes</div>' +
    '<div style="color:#FFD700">● ISS</div>';
  document.body.appendChild(el);
}

buildLegend();

// ---------------------------------------------------------------------------
// Tracked objects
// ---------------------------------------------------------------------------
const tracked = new Map(); // id -> record

function makeRecord(data, now) {
  const isISS = data.id === "ISS";
  const type = isISS ? "iss" : data.type === "plane" ? "plane" : "sat";
  const color = COLORS[type];

  // Marker.
  let marker;
  let baseOpacity = 1;
  let baseSize = 1; // chevrons scale from 1; dots scale from their pixel size
  let trailLen;
  if (type === "plane") {
    marker = makeChevron(color);
    trailLen = PLANE_TRAIL;
  } else {
    baseOpacity = isISS ? 1.0 : 0.9;
    baseSize = isISS ? ISS_DOT : SAT_DOT;
    marker = makeDot(color, baseSize, baseOpacity);
    trailLen = SAT_TRAIL;
  }
  marker.renderOrder = 3;
  scene.add(marker);

  // Trail line (vertex colors fade to black = invisible on black bg).
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(trailLen * 3), 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(trailLen * 3), 3));
  const trailMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    depthTest: false,
  });
  const trailLine = new THREE.Line(trailGeo, trailMat);
  trailLine.renderOrder = 1;
  trailLine.frustumCulled = false;
  scene.add(trailLine);

  // Label.
  let label = null;
  if (type === "plane") {
    const cs = (data.callsign || "").trim();
    if (cs) label = makeLabel(cs, "rgba(255,255,255,0.7)", 10);
  } else if (isISS) {
    label = makeLabel("ISS", "rgba(255,215,0,0.95)", 11);
  } else {
    const name = (data.name || data.id || "").trim();
    if (name) label = makeLabel(name, "rgba(200,205,225,0.6)", 9);
  }
  if (label) {
    label.renderOrder = 4;
    scene.add(label);
  }

  return {
    id: data.id,
    type,
    isISS,
    color,
    priority: PRIORITY[type],
    // Dead-reckoning state.
    az: data.az,
    alt: data.alt,
    dAz: 0,
    dAlt: 0,
    lastUpdated: now, // anchor time: advanced only when position changes
    lastSeen: now,    // any appearance in a frame; drives the 30s expiry
    heading: typeof data.heading === "number" ? data.heading : null,
    callsign: data.callsign,
    name: data.name,
    bright: data.bright,
    origin: data.origin,
    destination: data.destination,
    // Render state.
    curAlt: data.alt,
    pos: worldPos(data.az, data.alt),
    trail: [],
    trailLen,
    lastTrailSample: now,
    marker,
    trailLine,
    label,
    routeLabel: null,
    routeText: null,
    baseOpacity,
    baseSize,
  };
}

function disposeRecord(rec) {
  scene.remove(rec.marker);
  if (rec.type === "plane" && rec.marker.geometry) rec.marker.geometry.dispose();
  rec.marker.material.dispose();

  scene.remove(rec.trailLine);
  rec.trailLine.geometry.dispose();
  rec.trailLine.material.dispose();

  if (rec.label) {
    scene.remove(rec.label);
    rec.label.material.map.dispose();
    rec.label.material.dispose();
  }
  if (rec.routeLabel) {
    scene.remove(rec.routeLabel);
    rec.routeLabel.material.map.dispose();
    rec.routeLabel.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
let ws = null;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => console.log("[sky-tracker] connected");
  ws.onmessage = (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch (err) {
      console.warn("[sky-tracker] bad message", err);
    }
  };
  ws.onclose = () => {
    console.warn("[sky-tracker] disconnected; retrying in 3s");
    setTimeout(connect, 3000);
  };
  ws.onerror = () => ws && ws.close();
}

function handleMessage(msg) {
  const now = performance.now();
  const objects = msg.objects || [];

  for (const data of objects) {
    if (!data.id) continue;
    let rec = tracked.get(data.id);
    if (!rec) {
      tracked.set(data.id, makeRecord(data, now));
      continue;
    }

    rec.lastSeen = now; // keep it alive even on duplicate re-broadcasts
    if (typeof data.heading === "number") rec.heading = data.heading;
    rec.callsign = data.callsign;
    rec.name = data.name;
    rec.bright = data.bright;
    // Route fields arrive later, once the backend's adsbdb lookup resolves.
    rec.origin = data.origin;
    rec.destination = data.destination;

    // The backend re-broadcasts unchanged OpenSky data (5s push vs 10s poll),
    // so only treat a genuinely new position as a velocity sample / anchor.
    // Duplicates leave the extrapolation running off the last real velocity.
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
}

connect();

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------
function updateTrail(rec, fade) {
  const n = rec.trail.length;
  const posAttr = rec.trailLine.geometry.attributes.position;
  const colAttr = rec.trailLine.geometry.attributes.color;
  const c = rec.color;
  for (let i = 0; i < n; i++) {
    const p = rec.trail[i];
    posAttr.array[i * 3] = p.x;
    posAttr.array[i * 3 + 1] = p.y;
    posAttr.array[i * 3 + 2] = 0;
    // Fade oldest -> newest by scaling rgb toward black.
    const f = n > 1 ? i / (n - 1) : 1;
    colAttr.array[i * 3] = c.r * f;
    colAttr.array[i * 3 + 1] = c.g * f;
    colAttr.array[i * 3 + 2] = c.b * f;
  }
  rec.trailLine.geometry.setDrawRange(0, n);
  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  rec.trailLine.material.opacity = 0.7 * fade;
}

// Lazily build (or rebuild) a plane's "ORIG → DEST" route label.
function ensureRouteLabel(rec) {
  const text = `${rec.origin} → ${rec.destination}`;
  if (rec.routeLabel && rec.routeText === text) return;
  if (rec.routeLabel) {
    scene.remove(rec.routeLabel);
    rec.routeLabel.material.map.dispose();
    rec.routeLabel.material.dispose();
  }
  const lbl = makeLabel(text, "rgba(255,255,255,0.6)", 9);
  lbl.renderOrder = 4;
  lbl.visible = false;
  scene.add(lbl);
  rec.routeLabel = lbl;
  rec.routeText = text;
}

function fadeFor(rec, now) {
  const sinceSeen = (now - rec.lastSeen) / 1000;
  return sinceSeen > MISSING_SECONDS
    ? Math.max(0, 1 - (sinceSeen - MISSING_SECONDS) / FADE_SECONDS)
    : 1;
}

// Resolve label visibility: higher-priority labels claim their spot first;
// a lower-priority label within LABEL_MIN_GAP px of one already placed is hidden.
function resolveLabels(now) {
  const candidates = [];
  for (const rec of tracked.values()) {
    if (!rec.label) continue;
    rec.label.visible = false;
    let show;
    if (rec.type === "plane" || rec.isISS) show = true;
    else show = rec.curAlt > SAT_LABEL_MIN_ALT;
    if (show) candidates.push(rec);
  }
  candidates.sort((a, b) => b.priority - a.priority);

  const placed = [];
  const gapSq = LABEL_MIN_GAP * LABEL_MIN_GAP;
  for (const rec of candidates) {
    const off = rec.type === "sat" ? 12 : rec.isISS ? 16 : PLANE_LABEL_OFFSET;
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

    rec.label.visible = true;
    rec.label.position.set(lx, ly, 0);
    rec.label.material.opacity = fadeFor(rec, now);
    placed.push({ x: lx, y: ly });
  }

  // Route lines: a second line below the callsign, shown only when the callsign
  // label survived de-confliction and the plane is high enough.
  for (const rec of tracked.values()) {
    if (!rec.routeLabel) continue;
    const show = rec.label && rec.label.visible && rec.curAlt > ROUTE_MIN_ALT;
    rec.routeLabel.visible = !!show;
    if (!show) continue;
    rec.routeLabel.position.set(rec.pos.x, rec.pos.y + ROUTE_LABEL_OFFSET, 0);
    rec.routeLabel.material.opacity = fadeFor(rec, now);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();

  const expired = [];
  for (const rec of tracked.values()) {
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
    const p = worldPos(curAz, curAlt);
    rec.pos.x = p.x;
    rec.pos.y = p.y;
    rec.marker.position.set(p.x, p.y, 0);

    // Altitude-based sizing: smaller near the horizon, larger overhead.
    const sizeFactor = 0.5 + 0.5 * (curAlt / 90);

    if (rec.type === "plane") {
      rec.marker.scale.set(sizeFactor, sizeFactor, 1);
      // Point the chevron along its heading; +y shape, screen North = +y.
      if (typeof rec.heading === "number") {
        rec.marker.rotation.z = -(rec.heading * Math.PI) / 180;
      }
      // Altitude hint: lower toward the horizon = more transparent.
      const altOpacity = Math.max(0.25, Math.min(1, 0.25 + 0.75 * (curAlt / 60)));
      rec.marker.material.opacity = altOpacity * fade;
      if (rec.origin && rec.destination) ensureRouteLabel(rec);
    } else {
      const s = rec.baseSize * sizeFactor;
      rec.marker.scale.set(s, s, 1);
      rec.marker.material.opacity = rec.baseOpacity * fade;
    }

    // Sample the extrapolated position into the trail.
    if (now - rec.lastTrailSample >= TRAIL_SAMPLE_MS) {
      rec.trail.push({ x: p.x, y: p.y });
      if (rec.trail.length > rec.trailLen) rec.trail.shift();
      rec.lastTrailSample = now;
    }
    updateTrail(rec, fade);
  }

  for (const id of expired) {
    disposeRecord(tracked.get(id));
    tracked.delete(id);
  }

  resolveLabels(now);
  renderer.render(scene, camera);
}

animate();

// Debug hook: inspect live state from the browser console, e.g.
// `skyTracker.stats()`, `skyTracker.tracked`, or feed synthetic objects with
// `skyTracker.simulate([{ id: "ISS", type: "sat", az: 120, alt: 60, name: "ISS (ZARYA)" }])`.
window.skyTracker = {
  tracked,
  scene,
  renderer,
  simulate(objects) {
    handleMessage({ objects: objects || [] });
  },
  stats() {
    let sat = 0, plane = 0, iss = 0;
    for (const r of tracked.values()) {
      if (r.type === "iss") iss++;
      else if (r.type === "plane") plane++;
      else sat++;
    }
    return {
      total: tracked.size,
      sat,
      plane,
      iss,
      connected: !!ws && ws.readyState === 1,
    };
  },
};

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
window.addEventListener("resize", () => {
  width = window.innerWidth;
  height = window.innerHeight;
  camera.left = -width / 2;
  camera.right = width / 2;
  camera.top = height / 2;
  camera.bottom = -height / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  radius = computeRadius();
  buildDome();
  // Trails were captured in the old scale; clear them to avoid a jump.
  for (const rec of tracked.values()) rec.trail.length = 0;
});
