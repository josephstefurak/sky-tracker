import * as THREE from "three";

// One-line swap to wss://<cloud-run-host>/ws when this is deployed later.
const WS_URL = "ws://localhost:8080/ws";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const DOME_MARGIN = 0.92;     // fraction of the half-viewport the dome fills
const LERP = 0.08;            // per-frame easing toward target position
const TRAIL_MAX = 48;         // points kept per trail
const TRAIL_EVERY = 5;        // append to trails every N frames

const COLORS = {
  sat: new THREE.Color(0xc6ccd6),   // dim white/grey
  plane: new THREE.Color(0xffa31a), // amber
  iss: new THREE.Color(0xffd24a),   // gold
};

const SIZES = {
  sat: 7,
  plane: 9,
  iss: 12,
};

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

// ---------------------------------------------------------------------------
// Shared textures / helpers
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

// ---------------------------------------------------------------------------
// Static dome furniture: horizon ring + cardinal labels
// ---------------------------------------------------------------------------
let horizonRing = null;
const cardinalLabels = [];

function buildDome() {
  if (horizonRing) {
    scene.remove(horizonRing);
    horizonRing.geometry.dispose();
    horizonRing.material.dispose();
  }
  for (const lbl of cardinalLabels) scene.remove(lbl);
  cardinalLabels.length = 0;

  // Faint horizon circle.
  const segments = 128;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color: 0x3a4456,
    transparent: true,
    opacity: 0.5,
    depthTest: false,
  });
  horizonRing = new THREE.Line(geo, mat);
  horizonRing.renderOrder = 0;
  scene.add(horizonRing);

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
    sprite.renderOrder = 4;
    scene.add(sprite);
    cardinalLabels.push(sprite);
  }
}

buildDome();

// ---------------------------------------------------------------------------
// Tracked objects
// ---------------------------------------------------------------------------
const tracked = new Map(); // id -> record
let frame = 0;

function makeRecord(data) {
  const isISS = data.id === "ISS";
  const type = isISS ? "iss" : data.type === "plane" ? "plane" : "sat";
  const color = COLORS[type];
  const baseOpacity = type === "sat" ? 0.55 : type === "plane" ? 0.9 : 1.0;
  const opacity =
    type === "sat" && typeof data.bright === "number"
      ? Math.max(0.25, Math.min(1, data.bright)) * baseOpacity
      : baseOpacity;

  const dot = makeDot(color, SIZES[type], opacity);
  dot.renderOrder = 3;
  scene.add(dot);

  // Trail line (vertex colors fade to black = invisible on black bg).
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
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

  // Heading line for planes.
  let headingLine = null;
  if (type === "plane") {
    const hGeo = new THREE.BufferGeometry();
    hGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const hMat = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
    });
    headingLine = new THREE.Line(hGeo, hMat);
    headingLine.renderOrder = 2;
    headingLine.frustumCulled = false;
    scene.add(headingLine);
  }

  // Floating "ISS" label.
  let label = null;
  if (isISS) {
    label = makeTextSprite("ISS", "rgba(255,210,74,0.95)", 40);
    label.renderOrder = 4;
    scene.add(label);
  }

  const start = worldPos(data.az, data.alt);
  return {
    id: data.id,
    type,
    isISS,
    color,
    az: data.az,
    alt: data.alt,
    data,
    current: { x: start.x, y: start.y },
    trail: [],
    dot,
    trailLine,
    headingLine,
    label,
    seen: true,
  };
}

function disposeRecord(rec) {
  scene.remove(rec.dot);
  rec.dot.material.dispose();
  scene.remove(rec.trailLine);
  rec.trailLine.geometry.dispose();
  rec.trailLine.material.dispose();
  if (rec.headingLine) {
    scene.remove(rec.headingLine);
    rec.headingLine.geometry.dispose();
    rec.headingLine.material.dispose();
  }
  if (rec.label) {
    scene.remove(rec.label);
    rec.label.material.map.dispose();
    rec.label.material.dispose();
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
  const objects = msg.objects || [];
  for (const rec of tracked.values()) rec.seen = false;

  for (const data of objects) {
    if (!data.id) continue;
    let rec = tracked.get(data.id);
    if (!rec) {
      rec = makeRecord(data);
      tracked.set(data.id, rec);
    } else {
      rec.az = data.az;
      rec.alt = data.alt;
      rec.data = data;
    }
    rec.seen = true;
  }

  // Drop objects no longer reported.
  for (const [id, rec] of tracked) {
    if (!rec.seen) {
      disposeRecord(rec);
      tracked.delete(id);
    }
  }
}

connect();

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------
function updateTrail(rec) {
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
}

function updateHeading(rec) {
  const data = rec.data;
  if (typeof data.heading !== "number") {
    rec.headingLine.visible = false;
    return;
  }
  rec.headingLine.visible = true;
  const len = 18;
  const h = (data.heading * Math.PI) / 180;
  // North = up (+y), East = right (+x), matching the dome's screen layout.
  const dx = Math.sin(h) * len;
  const dy = Math.cos(h) * len;
  const arr = rec.headingLine.geometry.attributes.position.array;
  arr[0] = rec.current.x;
  arr[1] = rec.current.y;
  arr[2] = 0;
  arr[3] = rec.current.x + dx;
  arr[4] = rec.current.y + dy;
  arr[5] = 0;
  rec.headingLine.geometry.attributes.position.needsUpdate = true;
}

function animate() {
  requestAnimationFrame(animate);
  frame++;
  const pushTrail = frame % TRAIL_EVERY === 0;

  for (const rec of tracked.values()) {
    const target = worldPos(rec.az, rec.alt);
    rec.current.x += (target.x - rec.current.x) * LERP;
    rec.current.y += (target.y - rec.current.y) * LERP;

    rec.dot.position.set(rec.current.x, rec.current.y, 0);

    if (pushTrail) {
      rec.trail.push({ x: rec.current.x, y: rec.current.y });
      if (rec.trail.length > TRAIL_MAX) rec.trail.shift();
    }
    updateTrail(rec);

    if (rec.headingLine) updateHeading(rec);

    if (rec.label) {
      rec.label.position.set(rec.current.x, rec.current.y + 22, 0);
    }
  }

  renderer.render(scene, camera);
}

animate();

// Debug hook: inspect live state from the browser console, e.g.
// `skyTracker.stats()` or `skyTracker.tracked`.
window.skyTracker = {
  tracked,
  scene,
  renderer,
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
