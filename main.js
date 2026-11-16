import * as THREE from 'three';

// ---------- helpers ----------
let seed = 1337;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const rr = (a, b) => a + rnd() * (b - a);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const WORLD_R = 50;       // island radius
const WALK_R = 47;        // how far the player can walk
const FARM = { x: 27, z: 23 };                      // the farm (far south-east)
const PEN = { x: FARM.x - 7, z: FARM.z - 2, hw: 3.5, hd: 2.5 };       // chicken pen: centre + half sizes
const FIELD = { x: FARM.x + 1.5, z: FARM.z + 4.5, hw: 4.5, hd: 3 };   // wheat field
const SAWMILL = { x: 2, z: 34 };                    // the sawmill (south)
const MILL = { x: FARM.x + 8, z: FARM.z - 4 };                        // windmill
const HOLLOW = { x: 14, z: -14, r: 9 }; // the Blighted Hollow (hostile area)
const GROVE = { x: -32, z: -8, r: 10 };               // the Crystal Grove (far west)
const CRYSTAL_COLS = [0x35e0ff, 0xff3df0, 0x7dff3a, 0xffb02e, 0x8a5bff, 0xff3a5a]; // cyan, magenta, lime, amber, violet, red
const GROVE_CLUSTERS = (() => {
  let seed = 4242; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647, out = [];
  for (let i = 0; i < 15; i++) {
    let x = GROVE.x, z = GROVE.z, tries = 0;
    if (i > 0) do { const a = r() * 6.283, d = Math.sqrt(r()) * (GROVE.r - 1.5); x = GROVE.x + Math.cos(a) * d; z = GROVE.z + Math.sin(a) * d; tries++; } while (tries < 40 && out.some(o => Math.hypot(o.x - x, o.z - z) < 3.2));
    out.push({ x, z, ci: i % 6, h: i === 0 ? 3.8 : 1.2 + r() * 2.3 });
  }
  return out;
})();
// A stream runs the whole way across the island, west of the graveyard, and off the edge of the world at both ends.
// The Crystal Grove lies on the far side. The water is solid; a bridge will be added later.
const STREAM_HW = 2.2; // blocking half-width (the visible water edge is ~2.5)
const STREAM_PTS = new THREE.CatmullRomCurve3([[-22, -54], [-18, -38], [-20.5, -24], [-19.5, -8], [-21, 6], [-19, 22], [-21.5, 38], [-25, 54]].map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal').getPoints(110).map(v => ({ x: v.x, z: v.z }));
const STREAM_X0 = Math.min(...STREAM_PTS.map(p => p.x)), STREAM_X1 = Math.max(...STREAM_PTS.map(p => p.x));
const _sn = { d: 0, cx: 0, cz: 0 }, _sp = [0, 0];
function streamNearest(x, z) { // nearest point on the stream's centre line (null when far away: cheap early-out)
  if (x < STREAM_X0 - 12 || x > STREAM_X1 + 12) return null;
  let best = 1e9;
  for (let i = 0; i < STREAM_PTS.length - 1; i++) {
    const a = STREAM_PTS[i], b = STREAM_PTS[i + 1], abx = b.x - a.x, abz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz || 1)));
    const cx = a.x + t * abx, cz = a.z + t * abz, d2 = (x - cx) ** 2 + (z - cz) ** 2;
    if (d2 < best) { best = d2; _sn.cx = cx; _sn.cz = cz; }
  }
  _sn.d = Math.sqrt(best); return _sn;
}
function streamPush(x, z, r) { // push a body of radius r out of the water; returns a shared [x, z]
  _sp[0] = x; _sp[1] = z;
  if (BRIDGE.open && x > BRIDGE.x0 && x < BRIDGE.x1 && Math.abs(z - BRIDGE.z) <= BRIDGE.hw) return _sp; // on the bridge: the water does not push you
  const n = streamNearest(x, z);
  if (n && n.d < STREAM_HW + r) { const k = (STREAM_HW + r) / (n.d || 0.0001); _sp[0] = n.cx + (x - n.cx) * k; _sp[1] = n.cz + (z - n.cz) * k; }
  return _sp;
}
function nearStream(x, z, pad) { const n = streamNearest(x, z); return !!n && n.d < STREAM_HW + pad; }
function streamXAt(z) { // x of the stream's centre line at this z (it always runs north to south)
  for (let i = 0; i < STREAM_PTS.length - 1; i++) { const a = STREAM_PTS[i], b = STREAM_PTS[i + 1]; if (z >= a.z && z <= b.z) return a.x + (b.x - a.x) * (z - a.z) / ((b.z - a.z) || 1); }
  return z < STREAM_PTS[0].z ? STREAM_PTS[0].x : STREAM_PTS[STREAM_PTS.length - 1].x;
}
const isCutOff = (x, z) => x < streamXAt(z); // on the far (west) side of the water, where nothing the player must reach may spawn
// The bridge crosses the stream due west of the graveyard, straight toward the Crystal Grove. It exists once the quest is finished.
const BRIDGE = (() => { const z = -8, cx = streamXAt(z); return { z, cx, x0: cx - 4.9, x1: cx + 4.9, hw: 1.3, y: 0.22, open: false }; })();
function groundY(x, z) { // the height to stand at: the deck while crossing the bridge, otherwise the terrain
  const h = heightAt(x, z);
  if (!BRIDGE.open || Math.abs(z - BRIDGE.z) > BRIDGE.hw + 0.3 || x < BRIDGE.x0 || x > BRIDGE.x1) return h;
  return h + (BRIDGE.y - h) * smooth(0, 1.2, Math.min(x - BRIDGE.x0, BRIDGE.x1 - x));
}
const HOUSE = { x: -11, z: 10, hw: 3, hd: 2.5 }; // blacksmith house (door faces +z)

// gentle rolling hills
function heightAt(x, z) {
  const h = Math.sin(x * 0.21) * Math.cos(z * 0.17) * 0.8 + Math.sin(x * 0.07 + z * 0.09) * 0.9;
  const base = h * smooth(2, 8, Math.hypot(x, z)) * smooth(5, 9, Math.hypot(x - HOUSE.x, z - HOUSE.z)) * smooth(10, 14, Math.hypot(x - FARM.x, z - FARM.z)) * smooth(7, 11, Math.hypot(x - SAWMILL.x, z - SAWMILL.z)); // keep spawn, house, farm and sawmill flat
  const n = streamNearest(x, z);
  if (!n) return base;
  return base * smooth(5.5, 11, n.d) - 0.9 * (1 - smooth(1.0, 3.6, n.d)); // hills flatten toward the stream, then the channel dips below the waterline
}

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const FOG = 0x120a24;
scene.background = new THREE.Color(FOG);
scene.fog = new THREE.Fog(FOG, 16, 42);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 120);
const CAM_OFFSET = new THREE.Vector3(0, 17, 5.5); // mostly straight down, slight tilt

// lights
scene.add(new THREE.HemisphereLight(0x6a5acd, 0x1a0f2e, 0.55));
const moon = new THREE.DirectionalLight(0x9fb4ff, 0.7);
moon.position.set(-14, 22, -10);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
Object.assign(moon.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 70 });
scene.add(moon, moon.target);

// ---------- materials ----------
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95, metalness: 0, ...extra });
const M = {
  bark: mat(0x2a1d2b), stone: mat(0x6d6a85), moss: mat(0x3a5a45), cloak: mat(0x3b2a6b),
  skin: mat(0xe9d6c0), lantern: mat(0xffc65c, { emissive: 0xff9a1c, emissiveIntensity: 1.6 }),
  pumpkin: mat(0xe8731a, { emissive: 0x401800, emissiveIntensity: 0.5 }), stem: mat(0x2f4a22),
  glow: new THREE.MeshBasicMaterial({ color: 0xffb347 }),
  ghost: new THREE.MeshStandardMaterial({ color: 0xcfd8ff, emissive: 0x7f8cff, emissiveIntensity: 0.7, flatShading: true, transparent: true, opacity: 0.75 }),
  wisp: new THREE.MeshBasicMaterial({ color: 0x9dffb0 }),
};

// ---------- terrain ----------
function buildTerrain() {
  const size = WORLD_R * 2 + 4, seg = Math.round(size / 1.45);
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const cell = size / seg;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i) + rr(-0.3, 0.3) * cell, z = p.getZ(i) + rr(-0.3, 0.3) * cell;
    const r = Math.hypot(x, z);
    let y = heightAt(x, z) + rr(-0.12, 0.12);
    if (r > WORLD_R) { // pull edge verts into a rim and drop them -> floating island cliff
      const k = WORLD_R / r; x *= k; z *= k; y -= 5 + (r - WORLD_R) * 1.5;
    } else if (r > WORLD_R - 2) y -= (r - (WORLD_R - 2)) * 0.5;
    p.setXYZ(i, x, y, z);
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  const pos = flat.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const grassA = new THREE.Color(0x2f6b3a), grassB = new THREE.Color(0x3f7f3c), dirt = new THREE.Color(0x3a2c24), blight = new THREE.Color(0x2c1f3a), tilled = new THREE.Color(0x2e2018), straw = new THREE.Color(0x4a3d22), crystalGround = new THREE.Color(0x1d2540), mud = new THREE.Color(0x2b2619), bed = new THREE.Color(0x151a24), sawdust = new THREE.Color(0x4a3a26), c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3, cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    c.copy(grassA).lerp(grassB, rnd()).multiplyScalar(0.7 + rnd() * 0.3);
    if (cy < -0.5 || Math.hypot(cx, cz) > WORLD_R - 1.5) c.copy(dirt).multiplyScalar(0.8 + rnd() * 0.4);
    if (Math.abs(cx - FIELD.x) < FIELD.hw + 0.4 && Math.abs(cz - FIELD.z) < FIELD.hd + 0.4) c.copy(tilled).multiplyScalar(0.8 + 0.4 * Math.abs(Math.sin(cx * 9.1 + cz * 3.7)));
    else if (Math.abs(cx - PEN.x) < PEN.hw + 0.3 && Math.abs(cz - PEN.z) < PEN.hd + 0.3) c.copy(straw).multiplyScalar(0.8 + 0.4 * Math.abs(Math.sin(cx * 7.3 + cz * 5.1)));
    const dg = Math.hypot(cx - GROVE.x, cz - GROVE.z); // dark blue-violet ground in the crystal grove
    if (dg < GROVE.r + 1) c.lerp(crystalGround.clone().multiplyScalar(0.8 + 0.5 * Math.abs(Math.sin(cx * 8.3 + cz * 6.1))), smooth(GROVE.r + 1, GROVE.r - 3, dg) * 0.9);
    const ds = streamNearest(cx, cz); // muddy banks and a dark bed along the stream
    if (ds && ds.d < 4.2) c.lerp(ds.d < 2.3 ? bed : mud, ds.d < 2.3 ? 0.95 : smooth(4.2, 2.3, ds.d) * 0.9);
    const dm = Math.hypot(cx - SAWMILL.x, cz - SAWMILL.z); // trodden, sawdust-covered ground at the sawmill
    if (dm < 6.5) c.lerp(sawdust, smooth(6.5, 3.5, dm) * 0.85);
    const dh = Math.hypot(cx - HOLLOW.x, cz - HOLLOW.z); // corrupted ground inside the hollow
    if (dh < HOLLOW.r + 1) c.lerp(blight.clone().multiplyScalar(0.7 + 0.5 * Math.abs(Math.sin(cx * 12.9 + cz * 78.2))), smooth(HOLLOW.r + 1, HOLLOW.r - 2, dh));
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (i + k) * 3);
  }
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  mesh.receiveShadow = true;
  scene.add(mesh);
}
buildTerrain();

// ---------- props ----------
const colliders = []; // circle {x, z, r} or box {x, z, hw, hd}
const treeObjs = []; // dead trees (crows perch on them)
const interactables = []; // {world, getPos, r, label, act}
const avoid = [{ x: HOUSE.x, z: HOUSE.z + HOUSE.hd + 3, r: 3.2 }]; // keep props off the porch
const flickers = [];  // lights that flicker
const bobbers = [];   // floating things

function place(obj, x, z, r) {
  obj.position.set(x, heightAt(x, z), z);
  obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(obj);
  if (obj.userData.isTree) treeObjs.push(obj);
  if (r) { const cc = { x, z, r }; colliders.push(cc); obj.userData.collider = cc; }
}
const spot = (minR = 4, maxR = WORLD_R - 3) => {
  for (;;) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rr(minR * minR, maxR * maxR));
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (colliders.every(c => Math.hypot(c.x - x, c.z - z) > c.r + 1.4) && avoid.every(c => Math.hypot(c.x - x, c.z - z) > c.r) && !isCutOff(x, z) && !nearStream(x, z, 3)) return [x, z];
  }
};

function deadTree() {
  const t = new THREE.Group();
  const h = rr(2.4, 4);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.28, h, 5), M.bark);
  trunk.position.y = h / 2; trunk.rotation.z = rr(-0.08, 0.08);
  t.add(trunk);
  for (let i = 0; i < 4; i++) {
    const len = rr(1, 1.8), b = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.1, len, 4), M.bark);
    const a = rnd() * Math.PI * 2, y = rr(h * 0.45, h * 0.95);
    b.position.set(Math.cos(a) * len * 0.35, y + len * 0.3, Math.sin(a) * len * 0.35);
    b.rotation.set(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9);
    t.add(b);
  }
  t.rotation.y = rnd() * 6.28;
  t.userData.isTree = true; t.userData.topY = h;
  return t;
}

function tombstone() {
  const t = new THREE.Group();
  const w = rr(0.7, 1), h = rr(0.9, 1.4);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.25), M.stone);
  slab.position.y = h / 2;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 0.25, 6, 1, false, 0, Math.PI), M.stone);
  top.rotation.set(Math.PI / 2, 0, Math.PI / 2); top.position.y = h;
  const moss = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.12, 0.28), M.moss);
  moss.position.y = 0.06;
  t.add(slab, top, moss);
  t.rotation.set(rr(-0.1, 0.1), rr(-0.4, 0.4), rr(-0.12, 0.12));
  return t;
}

function pumpkin() {
  const p = new THREE.Group();
  const s = rr(0.45, 0.7);
  const body = new THREE.Mesh(new THREE.SphereGeometry(s, 7, 5), M.pumpkin);
  body.scale.y = 0.8; body.position.y = s * 0.7;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.2, 5), M.stem);
  stem.position.y = s * 1.4;
  // glowing face
  const eye = new THREE.BoxGeometry(s * 0.22, s * 0.22, 0.05);
  const e1 = new THREE.Mesh(eye, M.glow), e2 = new THREE.Mesh(eye, M.glow);
  e1.position.set(-s * 0.3, s * 0.85, s * 0.9); e2.position.set(s * 0.3, s * 0.85, s * 0.9);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(s * 0.7, s * 0.14, 0.05), M.glow);
  mouth.position.set(0, s * 0.5, s * 0.92);
  const light = new THREE.PointLight(0xff8a2a, 1.6, 7, 1.6);
  light.position.y = s * 0.8; light.userData.base = 1.6;
  flickers.push(light);
  p.add(body, stem, e1, e2, mouth, light);
  p.rotation.y = rnd() * 6.28;
  return p;
}

function ghost() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.3, 6), M.ghost);
  body.position.y = 0.65;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 6, 5), M.ghost);
  head.position.y = 1.35;
  const eyeG = new THREE.SphereGeometry(0.07, 4, 4), dark = new THREE.MeshBasicMaterial({ color: 0x111122 });
  const a = new THREE.Mesh(eyeG, dark), b = new THREE.Mesh(eyeG, dark);
  a.position.set(-0.14, 1.4, 0.34); b.position.set(0.14, 1.4, 0.34);
  g.add(body, head, a, b);
  const l = new THREE.PointLight(0x8f9cff, 1.2, 6);
  l.position.y = 1;
  g.add(l);
  return g;
}

// ---------- campfire with people ----------
const FIRE = { x: 8, z: 6 };
const flames = [], embers = [], sitters = [];
let fireBoost = 1; // grows when the quest is completed
{
  const fy = heightAt(FIRE.x, FIRE.z);
  const fire = new THREE.Group();
  fire.position.set(FIRE.x, fy, FIRE.z);
  // stone ring
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2, s = rr(0.22, 0.32);
    const st = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), M.stone);
    st.position.set(Math.cos(a) * 0.95, s * 0.5, Math.sin(a) * 0.95);
    st.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    fire.add(st);
  }
  // crossed logs
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.3, 5), M.bark);
    log.rotation.order = 'YXZ';
    log.rotation.set(Math.PI / 2 - 0.3, (i / 3) * Math.PI, 0);
    log.position.y = 0.2;
    fire.add(log);
  }
  // flames (layered cones)
  const flameCols = [0xff3d00, 0xff8a00, 0xffd23f];
  flameCols.forEach((c, i) => {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.42 - i * 0.1, 1.4 - i * 0.3, 5), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.92 }));
    f.position.y = 0.7 + (1.4 - i * 0.3) / 2 - 0.3;
    f.userData = { ph: i * 1.7, base: f.position.y, i };
    fire.add(f); flames.push(f);
  });
  // glowing embers drifting up
  const emGeo = new THREE.OctahedronGeometry(0.04, 0), emMat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
  for (let i = 0; i < 18; i++) {
    const e = new THREE.Mesh(emGeo, emMat);
    e.userData = { t: rnd() * 3, sp: rr(0.5, 1.1), a: rnd() * 6.28, r: rr(0.1, 0.4) };
    fire.add(e); embers.push(e);
  }
  const fl = new THREE.PointLight(0xff7a22, 40, 22, 1.2);
  fl.position.y = 1.3; fl.userData.base = 40;
  flickers.push(fl);
  fire.add(fl);
  scene.add(fire);
  colliders.push({ x: FIRE.x, z: FIRE.z, r: 1.2 });

  // people sitting around it on logs
  const cloakCols = [0x7a2e3b, 0x2e5a7a, 0x4d6b2e, 0x6b4a2e, 0x5b3a7a];
  const skinCols = [0xe9d6c0, 0xc99a73, 0x8d5a3b, 0xf0cfae, 0xa8744f];
  const seats = 5;
  for (let i = 0; i < seats; i++) {
    const a = (i / seats) * Math.PI * 2 + 0.4, d = 2.5;
    const sx = FIRE.x + Math.cos(a) * d, sz = FIRE.z + Math.sin(a) * d;
    const p = new THREE.Group();
    p.position.set(sx, heightAt(sx, sz), sz);
    p.rotation.y = Math.atan2(FIRE.x - sx, FIRE.z - sz); // face the fire
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 1, 6), M.bark);
    seat.rotation.z = Math.PI / 2; seat.position.y = 0.22;
    const cm = mat(cloakCols[i]);
    const torso = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.8, 6), cm);
    torso.position.set(0, 0.7, -0.05);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 6, 5), mat(skinCols[i]));
    head.position.y = 1.2;
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.35, 6), cm);
    hood.position.y = 1.38;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.5), cm);
    legs.position.set(0, 0.42, 0.28);
    const hands = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.2), mat(skinCols[i]));
    hands.position.set(0, 0.68, 0.42);
    p.add(seat, torso, head, hood, legs, hands);
    p.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    p.userData.ph = rnd() * 6.28;
    scene.add(p);
    colliders.push({ x: sx, z: sz, r: 0.6 });
    sitters.push(p);
  }
}

// ---------- blacksmith house ----------
const houseScene = new THREE.Scene();
houseScene.background = new THREE.Color(0x0b0710);
const houseColliders = [];
const HOUSE_BOUNDS = { x0: -4.6, x1: 4.6, z0: -3.5, z1: 3.7 };
const smoke = [], houseFlames = [], sparks = [];
const smith = { group: null, arm: null, k: 0, talked: false };
const ANVIL_POS = { x: 0, z: 0 }, SMITH_POS = { x: 1.35, z: 0 };

const metal = mat(0x3a3d4a, { metalness: 0.3, roughness: 0.6 });
const steel = mat(0xaab2c5, { metalness: 0.3, roughness: 0.5 });
const woodDark = mat(0x3b2619), woodMid = mat(0x5a3b24);
const glowOrange = new THREE.MeshBasicMaterial({ color: 0xff7a22 });
function box(w, h, d, m, x, y, z, parent) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z); parent.add(o); return o;
}
function cyl(rt, rb, h, seg, m, x, y, z, parent) {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  o.position.set(x, y, z); parent.add(o); return o;
}
function makeAnvil() {
  const a = new THREE.Group();
  cyl(0.5, 0.58, 0.5, 8, M.bark, 0, 0.25, 0, a); // stump
  box(0.8, 0.3, 0.5, metal, 0, 0.65, 0, a);
  box(0.5, 0.3, 0.34, metal, 0, 0.95, 0, a);
  box(1.1, 0.2, 0.5, mat(0x4a4e5e, { metalness: 0.3, roughness: 0.5 }), 0, 1.2, 0, a);
  const horn = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.7, 6), metal);
  horn.rotation.z = Math.PI / 2; horn.position.set(-0.85, 1.2, 0); a.add(horn);
  box(0.4, 0.07, 0.14, glowOrange, 0.05, 1.33, 0, a); // hot iron
  return a;
}

// --- exterior ---
{
  const h = new THREE.Group();
  const wall = mat(0x4a3426), roofM = mat(0x2d2745), doorM = mat(0x2a170f);
  box(6.4, 0.7, 5.4, M.stone, 0, 0, 0, h);
  box(6, 2.4, 5, wall, 0, 1.5, 0, h);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.35, 2.6, 0.35, woodDark, sx * 3, 1.5, sz * 2.5, h);
  const roofG = new THREE.Group();
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.9, 2.3, 4), roofM);
  roof.rotation.y = Math.PI / 4; roofG.add(roof); roofG.scale.set(1, 1, 0.8); roofG.position.y = 3.85; h.add(roofG);
  box(0.8, 2.6, 0.8, M.stone, -2.0, 3.7, -1.6, h);        // chimney
  box(0.5, 0.1, 0.5, glowOrange, -2.0, 5.02, -1.6, h);
  // door + frame
  box(1.3, 1.9, 0.14, doorM, 0, 1.25, 2.55, h);
  box(1.6, 0.15, 0.2, woodDark, 0, 2.28, 2.55, h);
  box(0.15, 2.1, 0.2, woodDark, -0.75, 1.25, 2.55, h);
  box(0.15, 2.1, 0.2, woodDark, 0.75, 1.25, 2.55, h);
  box(1.3, 0.1, 0.16, metal, 0, 0.8, 2.58, h);
  box(1.3, 0.1, 0.16, metal, 0, 1.7, 2.58, h);
  box(1.8, 0.12, 0.7, M.stone, 0, 0, 3.05, h);           // step
  // glowing windows
  const winM = new THREE.MeshBasicMaterial({ color: 0xffa347 });
  for (const sx of [-2, 2]) {
    box(1.05, 0.85, 0.08, woodDark, sx, 1.7, 2.49, h);
    box(0.9, 0.7, 0.1, winM, sx, 1.7, 2.52, h);
    box(0.06, 0.7, 0.12, woodDark, sx, 1.7, 2.55, h);
    box(0.9, 0.06, 0.12, woodDark, sx, 1.7, 2.55, h);
  }
  // hanging sign with an anvil icon
  box(1.0, 0.5, 0.06, woodDark, 1.7, 2.45, 2.62, h);
  box(0.5, 0.1, 0.07, steel, 1.7, 2.5, 2.66, h);
  box(0.2, 0.14, 0.07, steel, 1.7, 2.4, 2.66, h);
  box(0.25, 0.32, 0.25, M.lantern, -1.1, 1.9, 2.68, h);  // door lantern
  const dl = new THREE.PointLight(0xff9a3c, 14, 11, 1.4);
  dl.position.set(0, 2.4, 3.8); dl.userData.base = 14; flickers.push(dl); h.add(dl);
  // chimney smoke
  for (let i = 0; i < 6; i++) {
    const p = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), new THREE.MeshBasicMaterial({ color: 0x8a8499, transparent: true, opacity: 0.3, depthWrite: false }));
    p.userData = { t: i / 6, ph: rnd() * 6.28 }; h.add(p); smoke.push(p);
  }
  place(h, HOUSE.x, HOUSE.z, 0);
  colliders.push({ x: HOUSE.x, z: HOUSE.z, hw: HOUSE.hw + 0.05, hd: HOUSE.hd + 0.05, r: 4.4 });
  interactables.push({ world: 'outside', getPos: () => ({ x: HOUSE.x, z: HOUSE.z + HOUSE.hd + 0.8 }), r: 1.9, label: 'ENTER', act: () => switchWorld('house') });
}

// --- interior ---
{
  const hs = houseScene;
  hs.add(new THREE.HemisphereLight(0x7a6a9a, 0x2a1810, 0.55));
  // floor planks
  const plankCols = [0x5a3b24, 0x4d321f, 0x654328, 0x56391f];
  for (let i = -5; i < 5; i++) box(0.98, 0.1, 8.6, mat(plankCols[(i + 5) % 4]), i + 0.5, -0.05, 0, hs);
  box(3.2, 0.02, 2.4, mat(0x5a1f1f), 0.6, 0.01, 0.2, hs); // rug
  // walls (south wall is low so the camera sees in, with a doorway)
  box(10.8, 3, 0.4, woodMid, 0, 1.5, -4.2, hs);
  box(0.4, 3, 8.8, woodMid, -5.2, 1.5, 0, hs);
  box(0.4, 3, 8.8, woodMid, 5.2, 1.5, 0, hs);
  box(4.5, 0.6, 0.4, woodMid, -3.05, 0.3, 4.2, hs);
  box(4.5, 0.6, 0.4, woodMid, 3.05, 0.3, 4.2, hs);
  box(0.2, 1.6, 0.3, woodDark, -0.85, 0.8, 4.2, hs);
  box(0.2, 1.6, 0.3, woodDark, 0.85, 0.8, 4.2, hs);
  box(1.9, 0.05, 1.4, mat(0x1d2440), 0, 0.0, 4.9, hs); // moonlit doorway
  const outside = new THREE.PointLight(0x7080ff, 3, 8); outside.position.set(0, 1.5, 5.2); hs.add(outside);

  // forge (west wall)
  const forge = new THREE.Group(); forge.position.set(-3.7, 0, -2.8);
  box(2.2, 1.0, 1.6, M.stone, 0, 0.5, 0, forge);
  box(1.8, 0.12, 1.2, mat(0x551100, { emissive: 0xff3300, emissiveIntensity: 1.5 }), 0, 1.04, 0, forge);
  box(1.4, 2.6, 0.6, M.stone, 0, 2.3, -0.65, forge); // hood / chimney
  [0xff3d00, 0xff8a00, 0xffd23f].forEach((c, i) => {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.34 - i * 0.08, 0.9 - i * 0.2, 5), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.92 }));
    f.position.set((i - 1) * 0.35, 1.5 - i * 0.05, 0); f.userData = { ph: i * 1.9, y: f.position.y }; forge.add(f); houseFlames.push(f);
  });
  hs.add(forge);
  const fl = new THREE.PointLight(0xff6a1a, 32, 15, 1.2); fl.position.set(-3.3, 1.9, -2.4); fl.userData.base = 32; flickers.push(fl); hs.add(fl);
  houseColliders.push({ x: -3.7, z: -2.8, hw: 1.15, hd: 0.85 });

  // barrels, crates, workbench
  for (const [x, z] of [[-4.2, 1.5], [-3.5, 2.5]]) {
    cyl(0.42, 0.38, 0.9, 8, woodMid, x, 0.45, z, hs); cyl(0.44, 0.44, 0.06, 8, metal, x, 0.6, z, hs);
    houseColliders.push({ x, z, r: 0.45 });
  }
  box(0.9, 0.8, 0.9, woodDark, 3.9, 0.4, 2.8, hs); box(0.7, 0.6, 0.7, woodMid, 3.0, 0.3, 3.2, hs); box(0.7, 0.5, 0.7, woodDark, 3.95, 1.05, 2.8, hs);
  houseColliders.push({ x: 3.9, z: 2.8, hw: 0.5, hd: 0.5 }, { x: 3.0, z: 3.2, hw: 0.4, hd: 0.4 });
  const bench = new THREE.Group(); bench.position.set(4.3, 0, -0.6);
  box(1.0, 0.1, 3, woodMid, 0, 0.95, 0, bench); box(0.1, 0.95, 2.8, woodDark, -0.4, 0.47, 0, bench); box(0.1, 0.95, 2.8, woodDark, 0.4, 0.47, 0, bench);
  box(0.12, 0.08, 0.7, steel, 0.1, 1.04, -0.8, bench); box(0.1, 0.06, 0.6, steel, -0.1, 1.03, 0.2, bench);
  box(0.25, 0.14, 0.2, metal, 0.05, 1.07, 0.9, bench);
  hs.add(bench);
  houseColliders.push({ x: 4.3, z: -0.6, hw: 0.55, hd: 1.55 });

  // weapons on the north wall
  box(3.4, 0.14, 0.1, woodDark, 2.2, 1.9, -3.95, hs);
  for (let i = 0; i < 5; i++) {
    const x = 0.9 + i * 0.65, bl = 1.1 + (i % 2) * 0.2;
    box(0.08, bl, 0.03, steel, x, 1.9 - bl / 2 - 0.05, -3.9, hs);
    box(0.3, 0.06, 0.06, woodDark, x, 1.82, -3.88, hs);
  }
  const shield = cyl(0.5, 0.5, 0.08, 8, mat(0x7a2e3b), -0.5, 1.9, -3.95, hs); shield.rotation.x = Math.PI / 2;
  cyl(0.15, 0.15, 0.1, 8, steel, -0.5, 1.9, -3.9, hs).rotation.x = Math.PI / 2;
  for (const x of [-1.5, 4.2]) {
    box(0.28, 0.36, 0.28, M.lantern, x, 2.2, -3.9, hs);
    const l = new THREE.PointLight(0xffb060, 9, 12, 1.4); l.position.set(x, 2.1, -3.4); l.userData.base = 9; flickers.push(l); hs.add(l);
  }

  // anvil
  const anvil = makeAnvil(); anvil.position.set(ANVIL_POS.x, 0, ANVIL_POS.z); hs.add(anvil);
  houseColliders.push({ x: ANVIL_POS.x, z: ANVIL_POS.z, r: 0.75 });
  const sp = new THREE.MeshBasicMaterial({ color: 0xffc060 }), spg = new THREE.OctahedronGeometry(0.05, 0);
  for (let i = 0; i < 16; i++) { const m = new THREE.Mesh(spg, sp); m.visible = false; m.userData = { v: new THREE.Vector3(), life: 0 }; hs.add(m); sparks.push(m); }

  // the blacksmith
  const g = new THREE.Group(), skin = mat(0xc99a73), shirt = mat(0x6a2e2e), leather = mat(0x5b3a22);
  box(0.5, 0.65, 0.35, mat(0x2a2a33), 0, 0.33, 0, g);
  box(0.85, 0.7, 0.46, shirt, 0, 1.0, 0, g);
  box(0.62, 0.95, 0.06, leather, 0, 0.82, 0.26, g);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.29, 6, 5), skin); head.position.y = 1.62; g.add(head);
  box(0.36, 0.3, 0.2, mat(0x3a2418), 0, 1.45, 0.2, g);
  const dk = new THREE.MeshBasicMaterial({ color: 0x111111 });
  box(0.06, 0.06, 0.04, dk, -0.1, 1.68, 0.27, g); box(0.06, 0.06, 0.04, dk, 0.1, 1.68, 0.27, g);
  box(0.18, 0.18, 0.55, shirt, -0.5, 1.05, 0.25, g);
  const arm = new THREE.Group(); arm.position.set(0.5, 1.2, 0.0); g.add(arm);
  box(0.18, 0.18, 0.6, shirt, 0, 0, 0.3, arm);
  cyl(0.04, 0.04, 0.6, 5, M.bark, 0, 0, 0.75, arm).rotation.x = Math.PI / 2;
  box(0.2, 0.3, 0.2, metal, 0, 0, 1.05, arm);
  g.position.set(SMITH_POS.x, 0, SMITH_POS.z); g.rotation.y = -Math.PI / 2; g.userData.faceY = -Math.PI / 2;
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  hs.add(g); smith.group = g; smith.arm = arm;
  houseColliders.push({ x: SMITH_POS.x, z: SMITH_POS.z, r: 0.55 });

  interactables.push(
    { world: 'house', getPos: () => ({ x: SMITH_POS.x, z: SMITH_POS.z }), r: 1.7, label: 'TALK', act: talkToSmith },
    { world: 'house', getPos: () => ANVIL_POS, r: 1.5, label: 'USE ANVIL', act: useAnvil },
    { world: 'house', getPos: () => ({ x: 0, z: 3.5 }), r: 1.4, label: 'LEAVE', act: () => switchWorld('outside') },
  );
}

function updateHouse(dt, t) {
  // chimney smoke
  for (const p of smoke) {
    const u = p.userData; u.t = (u.t + dt * 0.3) % 1;
    p.position.set(-2.0 + Math.sin(u.t * 6 + u.ph) * 0.3 + u.t * 0.9, 5.2 + u.t * 3.2, -1.6 + Math.cos(u.t * 5 + u.ph) * 0.2);
    p.scale.setScalar(0.5 + u.t * 1.3); p.material.opacity = 0.32 * (1 - u.t);
  }
  if (world !== 'house') return;
  for (const f of houseFlames) {
    const k = 1 + Math.sin(t * 9 + f.userData.ph) * 0.18 + Math.sin(t * 17 + f.userData.ph) * 0.1;
    f.scale.set(1, k, 1); f.position.y = f.userData.y + (k - 1) * 0.3;
  }
  // blacksmith hammering (pauses while talking to him)
  const busy = talking && talkNpc === smith.group;
  const ph = t * 5;
  smith.arm.rotation.x = busy ? -0.4 : 0.3 - (0.5 + 0.5 * Math.sin(ph)) * 1.6;
  const k = Math.floor((ph + Math.PI / 2) / (Math.PI * 2));
  if (k !== smith.k) {
    smith.k = k;
    if (!busy) sfx.clang();
    if (!busy) for (let i = 0, n = 0; i < sparks.length && n < 6; i++) {
      const s = sparks[i]; if (s.userData.life > 0) continue;
      s.position.set(ANVIL_POS.x + 0.1, 1.4, ANVIL_POS.z);
      s.userData.v.set((Math.random() - 0.5) * 3, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 3);
      s.userData.life = 0.7; s.visible = true; n++;
    }
  }
  for (const s of sparks) {
    const u = s.userData; if (u.life <= 0) continue;
    u.life -= dt; u.v.y -= 9 * dt;
    s.position.addScaledVector(u.v, dt);
    s.scale.setScalar(Math.max(0.05, u.life / 0.7));
    if (u.life <= 0 || s.position.y < 0) { u.life = 0; s.visible = false; }
  }
}

// world switching with a quick fade
const fadeEl = document.getElementById('fade');
let world = 'outside', activeScene = scene, transitioning = false;
const outPos = new THREE.Vector2();
function switchWorld(to) {
  if (transitioning || talking) return;
  transitioning = true; fadeEl.classList.add('on'); sfx.door();
  setTimeout(() => {
    world = to;
    if (to === 'house') { outPos.copy(pPos); houseScene.add(player); pPos.set(0, 2.9); facing = Math.PI; activeScene = houseScene; }
    else { scene.add(player); pPos.set(HOUSE.x, HOUSE.z + HOUSE.hd + 1.7); facing = 0; activeScene = scene; }
    camera.position.set(pPos.x + CAM_OFFSET.x, CAM_OFFSET.y, pPos.y + CAM_OFFSET.z);
    fadeEl.classList.remove('on');
    setTimeout(() => { transitioning = false; }, 250);
  }, 260);
}

// ---------- the Blighted Hollow (hostile area): gate, fence, decor ----------
const gateDir = new THREE.Vector2(-Math.SQRT1_2, Math.SQRT1_2); // from the hollow's centre toward the rest of the island
const GATE = { x: HOLLOW.x + gateDir.x * HOLLOW.r, z: HOLLOW.z + gateDir.y * HOLLOW.r };
const inHollow = (x, z, pad = 0) => Math.hypot(x - HOLLOW.x, z - HOLLOW.z) < HOLLOW.r + pad;
function hspot(minR = 3) { // a free random spot inside the hollow
  for (let k = 0; k < 300; k++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rr(minR * minR, (HOLLOW.r - 1.5) ** 2));
    const x = HOLLOW.x + Math.cos(a) * d, z = HOLLOW.z + Math.sin(a) * d;
    if (Math.hypot(x - GATE.x, z - GATE.z) < 3.5) continue;
    if (colliders.every(c => Math.hypot(c.x - x, c.z - z) > c.r + 1.2)) return [x, z];
  }
  return [HOLLOW.x + HOLLOW.r * 0.5, HOLLOW.z];
}
{
  const stoneD = mat(0x3a3548), boneC = mat(0xd9d3c0);
  const redGlow = new THREE.MeshBasicMaterial({ color: 0xff3a2a });
  const purpleGlow = mat(0x8a3cff, { emissive: 0x5a1cc0, emissiveIntensity: 1.3 });

  // skull gate
  const gate = new THREE.Group();
  box(0.8, 3.6, 0.8, stoneD, -2, 1.8, 0, gate); box(0.8, 3.6, 0.8, stoneD, 2, 1.8, 0, gate);
  box(5.2, 0.6, 0.9, stoneD, 0, 3.7, 0, gate);
  for (const sx of [-2, 2]) { const sp = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.8, 4), stoneD); sp.position.set(sx, 4.0, 0); gate.add(sp); }
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.38, 6, 5), boneC); skull.position.set(0, 4.4, 0.1); gate.add(skull);
  box(0.12, 0.12, 0.1, redGlow, -0.14, 4.45, 0.42, gate); box(0.12, 0.12, 0.1, redGlow, 0.14, 4.45, 0.42, gate);
  for (const sx of [-1, 1]) {
    cyl(0.06, 0.07, 0.9, 5, woodDark, sx * 1.5, 2.3, 0.3, gate);
    const fl = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.45, 5), new THREE.MeshBasicMaterial({ color: 0xff5522 })); fl.position.set(sx * 1.5, 2.95, 0.3); gate.add(fl);
    const l = new THREE.PointLight(0xff4a2a, 9, 12, 1.4); l.position.set(sx * 1.5, 3.1, 1.0); l.userData.base = 9; flickers.push(l); gate.add(l);
  }
  place(gate, GATE.x, GATE.z, 0);
  gate.rotation.y = Math.atan2(gateDir.x, gateDir.y); // front faces the island
  for (const sgn of [-1, 1]) colliders.push({ x: GATE.x + Math.SQRT1_2 * 2 * sgn, z: GATE.z + Math.SQRT1_2 * 2 * sgn, r: 0.6 });

  // bone fence around the rim, open at the gate
  const a0 = Math.atan2(gateDir.y, gateDir.x), postG = new THREE.BoxGeometry(0.18, 1, 0.18), skG = new THREE.SphereGeometry(0.17, 5, 4);
  for (let i = 0; i < 36; i++) {
    const ang = (i / 36) * Math.PI * 2;
    if (Math.abs(Math.atan2(Math.sin(ang - a0), Math.cos(ang - a0))) < 0.3) continue;
    const x = HOLLOW.x + Math.cos(ang) * HOLLOW.r, z = HOLLOW.z + Math.sin(ang) * HOLLOW.r;
    if (Math.hypot(x, z) > WORLD_R - 2) continue;
    const p = new THREE.Mesh(postG, boneC), h = rr(0.8, 1.4);
    p.scale.y = h; p.position.set(x, heightAt(x, z) + h / 2, z); p.rotation.set(rr(-0.12, 0.12), 0, rr(-0.12, 0.12));
    p.castShadow = true; scene.add(p);
    if (i % 4 === 0) { const s = new THREE.Mesh(skG, boneC); s.position.set(x, heightAt(x, z) + h + 0.12, z); scene.add(s); }
  }

  // cursed brazier in the middle
  const bz = new THREE.Group();
  cyl(0.9, 1.05, 0.5, 8, stoneD, 0, 0.25, 0, bz);
  const f1 = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.3, 5), new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.9 })); f1.position.y = 1.15; bz.add(f1);
  const f2 = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.9, 5), new THREE.MeshBasicMaterial({ color: 0xffa86b })); f2.position.y = 0.95; bz.add(f2);
  const bl = new THREE.PointLight(0xff2a55, 16, 18, 1.3); bl.position.y = 2; bl.userData.base = 16; flickers.push(bl); bz.add(bl);
  place(bz, HOLLOW.x, HOLLOW.z, 1.0);

  // dead trees, crystals, bone piles, skull totems
  for (let i = 0; i < 8; i++) { const [x, z] = hspot(3.5); place(deadTree(), x, z, 0.45); }
  for (let i = 0; i < 6; i++) {
    const [x, z] = hspot(3);
    const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), purpleGlow); c.scale.set(0.7, 2.2, 0.7); c.position.y = 1.0;
    const grp = new THREE.Group(); grp.add(c); grp.rotation.y = rnd() * 6; place(grp, x, z, 0.5);
  }
  for (let i = 0; i < 6; i++) {
    const [x, z] = hspot(3), g = new THREE.Group();
    for (let k = 0; k < 4; k++) { const b = box(0.7, 0.07, 0.07, boneC, rr(-0.3, 0.3), 0.06 + k * 0.03, rr(-0.3, 0.3), g); b.rotation.y = rnd() * 3; }
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.2, 5, 4), boneC); s.position.set(0.2, 0.2, 0.1); g.add(s);
    place(g, x, z, 0);
  }
  for (let i = 0; i < 3; i++) {
    const [x, z] = hspot(3.5), g = new THREE.Group();
    cyl(0.08, 0.1, 2.4, 5, woodDark, 0, 1.2, 0, g);
    for (let k = 0; k < 2; k++) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.22, 5, 4), boneC); s.position.set(0, 1.6 + k * 0.5, 0.1); g.add(s); box(0.07, 0.07, 0.05, redGlow, -0.08, 1.64 + k * 0.5, 0.3, g); box(0.07, 0.07, 0.05, redGlow, 0.08, 1.64 + k * 0.5, 0.3, g); }
    place(g, x, z, 0.4);
  }
}

// ---------- the farm: chicken pen, windmill, wheat field, scarecrow (spooky) ----------
const farm = { blades: null, uTime: { value: 0 }, chickens: [], arm: null, scare: null, mist: [], stareT: rr(30, 55), cluckT: 6, creakT: 4 };
avoid.push({ x: FARM.x + 0.5, z: FARM.z - 1.5, r: 2.5 }, { x: PEN.x, z: PEN.z, r: 5.2 }, { x: FIELD.x, z: FIELD.z, r: 5.6 }, { x: MILL.x, z: MILL.z, r: 3.6 });
{
  const dead = mat(0x4a3a2c), bale = mat(0xb8a14a, { emissive: 0x403410, emissiveIntensity: 0.5 });

  // --- crooked pen fence (a few rails missing) ---
  const fenceG = new THREE.Group();
  function fenceRun(x0, z0, x1, z1) {
    const horiz = Math.abs(x1 - x0) >= Math.abs(z1 - z0), len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len));
    for (let i = 0; i <= n; i++) {
      const px = x0 + (x1 - x0) * i / n, pz = z0 + (z1 - z0) * i / n;
      const post = box(0.14, 1.1, 0.14, woodMid, px, 0.55, pz, fenceG); post.rotation.set(rr(-0.1, 0.1), 0, rr(-0.1, 0.1));
      if (i < n) for (const y of [0.45, 0.85]) {
        if (rnd() < 0.13) continue; // a broken rail
        const cx = px + (x1 - x0) / n / 2, cz = pz + (z1 - z0) / n / 2, l = len / n;
        const rail = box(horiz ? l : 0.07, 0.08, horiz ? 0.07 : l, dead, cx, y + rr(-0.03, 0.03), cz, fenceG);
        rail.rotation.z = horiz ? rr(-0.04, 0.04) : 0; rail.rotation.x = horiz ? 0 : rr(-0.04, 0.04);
      }
    }
    colliders.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hw: horiz ? len / 2 : 0.12, hd: horiz ? 0.12 : len / 2, r: len / 2 + 0.3 });
  }
  const px0 = PEN.x - PEN.hw, px1 = PEN.x + PEN.hw, pz0 = PEN.z - PEN.hd, pz1 = PEN.z + PEN.hd;
  fenceRun(px0, pz0, px1, pz0); fenceRun(px0, pz1, px1, pz1); fenceRun(px0, pz0, px0, pz1);
  fenceRun(px1, pz0, px1, PEN.z - 0.9); fenceRun(px1, PEN.z + 0.9, px1, pz1); // gate gap on the side facing the field
  fenceG.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(fenceG);

  // --- coop, hay, trough ---
  const coop = new THREE.Group(), coopX = PEN.x - 1.8, coopZ = PEN.z - PEN.hd + 1.2;
  box(2.4, 1.4, 1.7, mat(0x5a2f26), 0, 0.7, 0, coop);
  for (const sgn of [-1, 1]) { const r = box(2.7, 0.08, 1.2, mat(0x2d2530), 0, 1.65, sgn * 0.45, coop); r.rotation.x = sgn * -0.5; }
  box(0.5, 0.6, 0.06, mat(0x0a0810), 0.5, 0.45, 0.87, coop); // dark doorway
  box(0.45, 0.06, 0.8, woodMid, 0.5, 0.2, 1.2, coop).rotation.x = 0.35; // ramp
  const win = box(0.3, 0.3, 0.06, new THREE.MeshBasicMaterial({ color: 0xffb347 }), -0.6, 0.9, 0.87, coop); win.name = 'coopWindow';
  coop.position.set(coopX, 0, coopZ); coop.rotation.y = 0.05;
  coop.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(coop);
  colliders.push({ x: coopX, z: coopZ, hw: 1.3, hd: 0.95, r: 1.8 });
  for (const [dx, dz, rot] of [[1.6, 0.4, 0.3], [2.3, 0.9, -0.2]]) {
    const b = cyl(0.4, 0.4, 0.7, 8, bale, PEN.x + dx + 1.4, 0.4, PEN.z - PEN.hd + 1.3 + dz, scene); b.rotation.z = Math.PI / 2; b.rotation.y = rot; b.castShadow = true;
  }
  box(1.3, 0.3, 0.4, woodDark, PEN.x + 1.2, 0.2, PEN.z + PEN.hd - 0.8, scene);

  // --- windmill (leaning a little, blades turn slowly) ---
  const mill = new THREE.Group();
  cyl(1.5, 2.1, 5, 8, mat(0x5c4a3e), 0, 2.5, 0, mill);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.0, 1.8, 8), mat(0x2a2230)); cap.position.y = 5.9; mill.add(cap);
  box(0.9, 1.6, 0.14, mat(0x1e140e), 0, 0.8, 2.0, mill);                       // door
  box(0.5, 0.6, 0.1, new THREE.MeshBasicMaterial({ color: 0xff9a3c }), 0, 3.1, 1.72, mill); // glowing window
  for (const y of [1.4, 2.8, 4.2]) cyl(1.9 - y * 0.12, 1.9 - y * 0.12, 0.1, 8, woodDark, 0, y, 0, mill);
  const hub = new THREE.Group(); hub.position.set(0, 4.9, 2.0); mill.add(hub);
  box(0.4, 0.4, 0.5, woodDark, 0, 0, 0, hub);
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2; hub.add(arm);
    box(0.14, 4.4, 0.08, woodDark, 0, 2.2, 0, arm);
    if (i !== 2) { // one sail is torn off
      const sail = box(0.95, 3.0, 0.04, mat(0x6a5a48), 0.55, 2.5, 0.06, arm);
      for (const y of [-1, -0.3, 0.4, 1.1]) box(0.95, 0.05, 0.06, woodMid, 0.55, 2.5 + y, 0.09, arm);
    } else box(0.5, 1.0, 0.04, mat(0x6a5a48), 0.3, 3.7, 0.06, arm).rotation.z = 0.4;
  }
  mill.position.set(MILL.x, 0, MILL.z); mill.rotation.set(0.02, -0.5, 0.035);
  mill.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(mill); farm.blades = hub;
  colliders.push({ x: MILL.x, z: MILL.z, r: 2.3 });

  // --- scarecrow with a glowing pumpkin head ---
  const sc = new THREE.Group(), burlap = mat(0x8a7348);
  cyl(0.06, 0.08, 2.4, 5, woodDark, 0, 1.2, 0, sc);
  box(0.5, 0.8, 0.3, burlap, 0, 1.3, 0, sc);
  const arms = new THREE.Group(); arms.position.y = 1.65; sc.add(arms);
  box(1.8, 0.09, 0.09, woodDark, 0, 0, 0, arms);
  for (const x of [-0.8, -0.5, 0.5, 0.8]) box(0.06, 0.35, 0.03, burlap, x, -0.22, 0, arms); // tattered strips
  const pump = new THREE.Mesh(new THREE.SphereGeometry(0.3, 7, 5), M.pumpkin); pump.scale.y = 0.85; pump.position.y = 2.15; sc.add(pump);
  const scGlow = new THREE.MeshBasicMaterial({ color: 0xffb347 }); farm.scGlow = scGlow;
  box(0.09, 0.09, 0.05, scGlow, -0.12, 2.2, 0.26, sc); box(0.09, 0.09, 0.05, scGlow, 0.12, 2.2, 0.26, sc); box(0.28, 0.07, 0.05, scGlow, 0, 2.06, 0.27, sc);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 6), mat(0x241c2c)); hat.position.y = 2.65; sc.add(hat);
  cyl(0.4, 0.4, 0.04, 8, mat(0x241c2c), 0, 2.42, 0, sc);
  const sl = new THREE.PointLight(0xff8a2a, 5, 9, 1.6); sl.position.set(0, 2.15, 0.5); sl.userData.base = 0.9; flickers.push(sl); sc.add(sl);
  sc.position.set(FIELD.x, 0, FIELD.z); sc.rotation.set(0.04, 0.3, 0.07);
  sc.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(sc); farm.arm = arms; farm.scare = sc; farm.scLight = sl;
  colliders.push({ x: FIELD.x, z: FIELD.z, r: 0.4 });

  // --- wheat: dim and swaying; the sway is done on the GPU so hundreds of stalks stay cheap ---
  const sway = (m, amp) => {
    m.onBeforeCompile = sh => {
      sh.uniforms.uTime = farm.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>
         float ph = uTime * 1.5 + instanceMatrix[3].x * 0.8 + instanceMatrix[3].z * 0.5;
         transformed.x += sin(ph) * ${amp.toFixed(2)} * position.y;
         transformed.z += cos(ph * 0.8) * ${(amp * 0.5).toFixed(2)} * position.y;`);
    };
    return m;
  };
  const stalkG = new THREE.BoxGeometry(0.04, 1, 0.04); stalkG.translate(0, 0.5, 0);
  const earG = new THREE.ConeGeometry(0.07, 0.34, 4); earG.translate(0, 1.1, 0);
  const cells = [];
  for (let x = FIELD.x - FIELD.hw + 0.3; x < FIELD.x + FIELD.hw - 0.2; x += 0.34) for (let z = FIELD.z - FIELD.hd + 0.3; z < FIELD.z + FIELD.hd - 0.2; z += 0.3) {
    if (Math.hypot(x - FIELD.x, z - FIELD.z) < 0.7) continue;
    cells.push([x + rr(-0.09, 0.09), z + rr(-0.09, 0.09), rr(0.6, 1.15)]);
  }
  const stalks = new THREE.InstancedMesh(stalkG, sway(mat(0x7c6c2a, { emissive: 0x2a2208, emissiveIntensity: 0.6 }), 0.1), cells.length);
  const ears = new THREE.InstancedMesh(earG, sway(mat(0xc2a24a, { emissive: 0x4a3a0c, emissiveIntensity: 0.7 }), 0.1), cells.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc3 = new THREE.Vector3(), pos3 = new THREE.Vector3();
  cells.forEach(([x, z, h], i) => {
    q.setFromEuler(new THREE.Euler(rr(-0.1, 0.1), rnd() * 6, rr(-0.1, 0.1))); sc3.set(1, h, 1); pos3.set(x, 0, z);
    m4.compose(pos3, q, sc3); stalks.setMatrixAt(i, m4); ears.setMatrixAt(i, m4);
  });
  stalks.castShadow = false; ears.castShadow = false; scene.add(stalks, ears);
  const order = cells.map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  farm.wheat = { stalks, ears, n: cells.length, backup: stalks.instanceMatrix.array.slice(), order, dead: 0 }; // lets quests trample the field

  // --- thin mist drifting over the field and pen ---
  for (const [x, z, r] of [[FIELD.x, FIELD.z, 4.2], [FIELD.x - 4, FIELD.z + 1, 3.2], [PEN.x, PEN.z, 3.4]]) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 18), new THREE.MeshBasicMaterial({ color: 0x9fb0c8, transparent: true, opacity: 0.1, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.55, z); m.userData = { x, z, ph: rnd() * 6 }; scene.add(m); farm.mist.push(m);
  }
}

// --- chickens (they live in the pen) ---
function makeChicken(col) {
  const g = new THREE.Group(), fur = mat(col, { emissive: col, emissiveIntensity: 0.25 }), red = mat(0xc22a2a, { emissive: 0x601010, emissiveIntensity: 0.6 });
  const beakM = mat(0xe8a030), legM = mat(0xc9a040), dark = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 7, 5), fur); body.scale.set(1, 0.9, 1.3); body.position.y = 0.3; g.add(body);
  const head = new THREE.Group(); head.position.set(0, 0.52, 0.2); g.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 5), fur));
  box(0.04, 0.08, 0.1, red, 0, 0.12, 0, head); box(0.03, 0.07, 0.03, red, 0, -0.08, 0.08, head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.1, 4), beakM); beak.rotation.x = Math.PI / 2; beak.position.set(0, 0, 0.12); head.add(beak);
  box(0.025, 0.025, 0.02, dark, -0.06, 0.03, 0.07, head); box(0.025, 0.025, 0.02, dark, 0.06, 0.03, 0.07, head);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 4), fur); tail.position.set(0, 0.42, -0.3); tail.rotation.x = -0.9; g.add(tail);
  const wings = [];
  for (const sx of [-1, 1]) { const w = new THREE.Group(); w.position.set(sx * 0.2, 0.36, 0); g.add(w); box(0.04, 0.16, 0.3, fur, 0, -0.07, 0, w); wings.push(w); }
  for (const sx of [-1, 1]) box(0.03, 0.18, 0.03, legM, sx * 0.07, 0.09, 0.03, g);
  g.scale.setScalar(1.25);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { g, head, wings };
}
{
  const cols = [0xf2eee2, 0x9a6a46, 0xf2eee2, 0x2e2a38, 0xb98a5a, 0xe8dcc4];
  const coopBox = { x: PEN.x - 1.8, z: PEN.z - PEN.hd + 1.2, hw: 1.3, hd: 0.95 };
  farm.coopBox = coopBox;
  for (let i = 0; i < 6; i++) {
    let x, z, tries = 0;
    do { x = PEN.x + rr(-PEN.hw + 0.7, PEN.hw - 0.7); z = PEN.z + rr(-PEN.hd + 0.7, PEN.hd - 0.7); tries++; }
    while (tries < 40 && Math.abs(x - coopBox.x) < coopBox.hw + 0.5 && Math.abs(z - coopBox.z) < coopBox.hd + 0.5);
    const c = Object.assign(makeChicken(cols[i]), { x, z, face: rnd() * 6.28, state: 'peck', t: 0, dur: rr(1, 3), tx: x, tz: z, ph: rnd() * 6, flap: 0, hopY: 0 });
    c.g.position.set(x, 0, z); c.g.rotation.y = c.face; scene.add(c.g); farm.chickens.push(c);
  }
}
function updateFarm(dt, t) {
  farm.uTime.value = t;
  farm.blades.rotation.z += dt * 0.4;                                   // slow, ominous
  farm.arm.rotation.z = Math.sin(t * 1.1) * 0.08 + (farm.awake ? 0.25 + Math.sin(t * 4) * 0.1 : 0); farm.scare.rotation.z = 0.07 + Math.sin(t * 0.7) * 0.03;
  for (const m of farm.mist) { const u = m.userData; m.position.x = u.x + Math.sin(t * 0.12 + u.ph) * 1.2; m.position.z = u.z + Math.cos(t * 0.09 + u.ph) * 0.8; m.material.opacity = 0.085 + Math.sin(t * 0.3 + u.ph) * 0.03; }
  if (world !== 'outside') return;
  const dm = Math.hypot(MILL.x - pPos.x, MILL.z - pPos.y);
  if (dm < 22) { farm.creakT -= dt; if (farm.creakT <= 0) { farm.creakT = rr(4.5, 8); sfx.creak(0.1 * (1 - dm / 22)); } }
  const dp = Math.hypot(PEN.x - pPos.x, PEN.z - pPos.y);
  if (dp < 16) { farm.cluckT -= dt; if (farm.cluckT <= 0) { farm.cluckT = rr(4, 10); sfx.cluck(0.09 * (1 - dp / 16)); } }
  farm.stareT -= dt;
  const stare = farm.stareT <= 0 && dp < 11;
  if (farm.stareT <= 0) farm.stareT = rr(35, 70);
  for (const c of farm.chickens) {
    const px = pPos.x - c.x, pz = pPos.y - c.z, pd = Math.hypot(px, pz), g = c.g;
    c.t += dt;
    if (stare && c.state !== 'scatter') { c.state = 'stare'; c.t = 0; c.dur = 3.2; } // all of them turn and stare at once
    if (pd < 2.3 && c.state !== 'scatter' && c.state !== 'stare') { // startled: run, flap, hop
      c.state = 'scatter'; c.t = 0; c.dur = 1.1; const a = Math.atan2(-pz, -px) + rr(-0.8, 0.8); c.tx = c.x + Math.cos(a) * 2.5; c.tz = c.z + Math.sin(a) * 2.5;
      if (pd < 14) sfx.cluck(0.1);
    }
    let moving = false, headX = 0.1;
    if (c.state === 'peck') {
      headX = 0.85 + Math.sin(t * 14 + c.ph) * 0.15;
      if (c.t > c.dur) { c.state = 'walk'; c.t = 0; c.tx = PEN.x + rr(-PEN.hw + 0.7, PEN.hw - 0.7); c.tz = PEN.z + rr(-PEN.hd + 0.7, PEN.hd - 0.7); }
    } else if (c.state === 'walk') {
      const dx = c.tx - c.x, dz = c.tz - c.z, d = Math.hypot(dx, dz);
      if (d < 0.2 || c.t > 6) { c.state = 'peck'; c.t = 0; c.dur = rr(1.5, 4); }
      else { c.x += dx / d * 0.9 * dt; c.z += dz / d * 0.9 * dt; c.face = Math.atan2(dx, dz); moving = true; headX = 0.15 + Math.sin(t * 9 + c.ph) * 0.1; }
    } else if (c.state === 'scatter') {
      const dx = c.tx - c.x, dz = c.tz - c.z, d = Math.hypot(dx, dz);
      if (d > 0.1) { c.x += dx / d * 3.2 * dt; c.z += dz / d * 3.2 * dt; c.face = Math.atan2(dx, dz); }
      moving = true; headX = -0.3;
      if (c.t > c.dur) { c.state = 'peck'; c.t = 0; c.dur = rr(1, 2.5); }
    } else if (c.state === 'stare') {
      c.face = Math.atan2(px, pz); headX = -0.2;
      if (c.t > c.dur) { c.state = 'peck'; c.t = 0; c.dur = rr(1, 2.5); }
    }
    // keep inside the pen, away from the coop
    c.x = Math.min(PEN.x + PEN.hw - 0.5, Math.max(PEN.x - PEN.hw + 0.5, c.x)); c.z = Math.min(PEN.z + PEN.hd - 0.5, Math.max(PEN.z - PEN.hd + 0.5, c.z));
    pushOut(c, farm.coopBox, 0.5);
    for (const o of farm.chickens) { if (o === c) continue; const ox = c.x - o.x, oz = c.z - o.z, od = Math.hypot(ox, oz); if (od < 0.5 && od > 0.001) { c.x += ox / od * (0.5 - od) * 0.5; c.z += oz / od * (0.5 - od) * 0.5; } }
    // pose
    const flapping = c.state === 'scatter';
    g.position.set(c.x, (moving ? Math.abs(Math.sin(t * (flapping ? 16 : 10) + c.ph)) * (flapping ? 0.18 : 0.04) : 0), c.z);
    g.rotation.y += Math.atan2(Math.sin(c.face - g.rotation.y), Math.cos(c.face - g.rotation.y)) * Math.min(1, dt * 10);
    c.head.rotation.x += (headX - c.head.rotation.x) * Math.min(1, dt * 14);
    const wa = flapping ? 0.3 + Math.sin(t * 30 + c.ph) * 0.9 : 0.12;
    c.wings[0].rotation.z = -wa; c.wings[1].rotation.z = wa;
  }
}

// ---------- the Crystal Grove: sharp glowing crystals that light up their surroundings ----------
avoid.push({ x: GROVE.x, z: GROVE.z, r: GROVE.r + 1.5 });
const grove = { mats: [], decals: [], sparks: [], clusters: [], inside: false };
{
  // a faceted, pointed crystal: a 6-sided lathe with a sharp tip
  const crystalG = new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.32, 0.3), new THREE.Vector2(0.27, 1.0), new THREE.Vector2(0, 1.7)], 6);
  const rockG = new THREE.DodecahedronGeometry(0.55, 0), rockM = mat(0x2a2a3a);
  // soft round glow texture used for the light pools on the ground and the sparkles
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const cx = cv.getContext('2d'), gr = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = gr; cx.fillRect(0, 0, 128, 128);
  const glowTex = new THREE.CanvasTexture(cv); grove.glowTex = glowTex;
  grove.mats = CRYSTAL_COLS.map(col => mat(col, { emissive: col, emissiveIntensity: 1.4, roughness: 0.25, metalness: 0.2 }));
  grove.decals = CRYSTAL_COLS.map(col => new THREE.MeshBasicMaterial({ color: col, map: glowTex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  const decalG = new THREE.PlaneGeometry(1, 1);
  const biggest = [...GROVE_CLUSTERS].sort((a, b) => b.h - a.h).slice(0, 3);
  for (const cl of GROVE_CLUSTERS) {
    const y0 = heightAt(cl.x, cl.z), grp = new THREE.Group();
    const rock = new THREE.Mesh(rockG, rockM); rock.scale.set(1.3, 0.5, 1.3); rock.position.y = 0.1; grp.add(rock);
    const n = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const h = i === 0 ? cl.h : cl.h * rr(0.35, 0.7), a = rnd() * Math.PI * 2, off = i === 0 ? 0 : rr(0.4, 1.0), tilt = i === 0 ? rr(-0.08, 0.08) : rr(0.2, 0.55), sw = (0.7 + 0.25 * h) * rr(0.85, 1.2);
      const m = new THREE.Mesh(crystalG, grove.mats[cl.ci]);
      m.scale.set(sw, h / 1.7, sw); m.position.set(Math.cos(a) * off, 0.1, Math.sin(a) * off);
      m.rotation.set(Math.sin(a) * tilt, rnd() * 3, -Math.cos(a) * tilt); grp.add(m);
    }
    grp.position.set(cl.x, y0, cl.z); scene.add(grp);
    const colObj = { x: cl.x, z: cl.z, r: 0.5 + 0.18 * cl.h }; colliders.push(colObj); grp.userData.collider = colObj;
    const sz = 5.5 + cl.h * 1.8, decal = new THREE.Mesh(decalG, grove.decals[cl.ci]);
    decal.scale.set(sz, sz, 1); decal.rotation.x = -Math.PI / 2; decal.position.set(cl.x, y0 + 0.07, cl.z); decal.renderOrder = 2; scene.add(decal); grove.clusters.push({ grp, decal, ci: cl.ci });
    if (biggest.includes(cl)) { // a few clusters also cast real coloured light on the player and nearby objects
      const l = new THREE.PointLight(CRYSTAL_COLS[cl.ci], 9, 12, 1.6); l.position.set(cl.x, y0 + cl.h * 0.6, cl.z); l.userData.base = 9; flickers.push(l); scene.add(l);
    }
  }
  // sparkles drifting up through the grove
  const spG = new THREE.OctahedronGeometry(0.07, 0);
  const spM = CRYSTAL_COLS.map(col => new THREE.MeshBasicMaterial({ color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  for (let i = 0; i < 60; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * (GROVE.r - 1), m = new THREE.Mesh(spG, spM[i % 6]);
    m.userData = { x: GROVE.x + Math.cos(a) * d, z: GROVE.z + Math.sin(a) * d, sp: rr(0.12, 0.3), ph: rnd() * 10 };
    scene.add(m); grove.sparks.push(m);
  }
}
function updateGrove(dt, t) {
  grove.mats.forEach((m, i) => { m.emissiveIntensity = 1.3 + 0.45 * Math.sin(t * 1.4 + i * 1.1); });   // slow pulse, each colour out of step
  grove.decals.forEach((m, i) => { m.opacity = 0.5 + 0.13 * Math.sin(t * 1.4 + i * 1.1); });
  for (const s of grove.sparks) {
    const u = s.userData, f = (t * u.sp + u.ph) % 1;
    s.position.set(u.x + Math.sin(t * 0.7 + u.ph) * 0.5, heightAt(u.x, u.z) + 0.3 + f * 3.8, u.z + Math.cos(t * 0.6 + u.ph) * 0.5);
    s.scale.setScalar(Math.max(0.05, Math.sin(f * Math.PI)));
  }
  if (world !== 'outside') { grove.inside = false; return; }
  const nowIn = Math.hypot(pPos.x - GROVE.x, pPos.y - GROVE.z) < GROVE.r - 1;
  if (nowIn && !grove.inside) toast('The Crystal Grove hums with light...');
  grove.inside = nowIn;
}

// ---------- the stream: solid water that cuts the Crystal Grove off from the rest of the island ----------
const stream = { uTime: { value: 0 }, mist: [], warned: false };
{
  // a flat ribbon of animated water that follows the channel; past the island's rim it curves down like a waterfall
  const pts = STREAM_PTS.filter(p => Math.hypot(p.x, p.z) < WORLD_R + 3);
  const pos = [], uv = [], idx = [];
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
    if (i > 0) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const r = Math.hypot(pts[i].x, pts[i].z), over = Math.max(0, r - (WORLD_R - 1)), y = -0.3 - over * over * 0.7, w = 2.5 * (1 + 0.1 * Math.sin(i * 0.7));
    pos.push(pts[i].x + nx * w, y, pts[i].z + nz * w, pts[i].x - nx * w, y, pts[i].z - nz * w);
    uv.push(0, len / 4, 1, len / 4);
    if (i < pts.length - 1) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  const water = new THREE.ShaderMaterial({
    uniforms: { uTime: stream.uTime }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float uTime;
      void main() {
        float edge = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x);                     // 0 at the banks, 1 mid-stream
        float f1 = sin(vUv.y * 3.0 - uTime * 1.3 + sin(vUv.x * 6.0 + uTime * 0.7) * 1.5) * 0.5 + 0.5;
        float f2 = sin(vUv.y * 7.0 - uTime * 2.2 + vUv.x * 9.0) * 0.5 + 0.5;
        vec3 col = mix(vec3(0.10, 0.27, 0.36), vec3(0.03, 0.09, 0.18), edge * 0.8);
        col += vec3(0.22, 0.38, 0.52) * pow(f1 * f2, 3.0) * 0.8;                                    // moonlit ripples
        col += vec3(0.6, 0.75, 0.82) * (1.0 - edge) * (0.3 + 0.7 * f2) * 0.5;                       // foam along the banks
        gl_FragColor = vec4(col, 0.92);
      }`,
  });
  const mesh = new THREE.Mesh(g, water); mesh.renderOrder = 1; scene.add(mesh);
  // thin mist hanging over the water
  for (let i = 6; i < pts.length - 6; i += 14) {
    if (Math.hypot(pts[i].x, pts[i].z) > WORLD_R - 4) continue;
    const m = new THREE.Mesh(new THREE.CircleGeometry(3.6, 16), new THREE.MeshBasicMaterial({ color: 0x9fb0c8, transparent: true, opacity: 0.08, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(pts[i].x, 0.4, pts[i].z); m.userData = { x: pts[i].x, z: pts[i].z, ph: rnd() * 6 }; scene.add(m); stream.mist.push(m);
  }
  // scenery on the far bank so the cut-off side is not an empty void
  let placed = 0, tries = 0;
  while (placed < 28 && tries++ < 400) {
    const z = rr(-44, 44), x = streamXAt(z) - rr(5, 26);
    if (Math.hypot(x, z) > WORLD_R - 3 || Math.hypot(x - GROVE.x, z - GROVE.z) < GROVE.r - 1 || nearStream(x, z, 4)) continue;
    if (colliders.every(c => Math.hypot(c.x - x, c.z - z) > c.r + 1.4)) { place(deadTree(), x, z, 0.45); placed++; }
  }
}
function updateStream(dt, t) {
  stream.uTime.value = t;
  for (const m of stream.mist) { const u = m.userData; m.position.x = u.x + Math.sin(t * 0.15 + u.ph) * 1.2; m.position.z = u.z + Math.cos(t * 0.11 + u.ph) * 1.0; m.material.opacity = 0.07 + Math.sin(t * 0.3 + u.ph) * 0.025; }
  if (world !== 'outside' || stream.warned || BRIDGE.open) return;
  const n = streamNearest(pPos.x, pPos.y);
  if (n && n.d < STREAM_HW + 1.1) { stream.warned = true; toast('The water is too wide and cold to cross...'); }
}

// ---------- the sawmill (south): broken at first; Bram the sawyer asks you to get it running again ----------
const inv = { logs: 0, planks: 0, iron: 0, nails: 0, shards: 0, owned: {}, seen: {} };
const SAW = {
  title: 'The Silent Sawmill', state: 'none', need: 6,   // none -> wood -> ready -> repair -> done
  dialogue: {
    none: [
      'Hmph. Another wanderer. Mind the saw... not that it bites anymore.',
      'This mill ran day and night until the night the lights went out. Then the blade froze and the carriage jammed.',
      'I can fix her, but I need timber. Six good logs from those dead trees. Swing that sword of yours at them. A few swings drops one.',
      'Bring the logs here and we will see if she sings again.',
    ],
    wood: () => [`Six logs, wanderer. You have ${Math.min(inv.logs, SAW.need)} so far.`, 'Swing your sword at the dead trees. Three good hits fells one.'],
    ready: [
      'Ha! Seasoned wood, even dead as it is.',
      'Give them here... there. The carriage is mended.',
      'Now the lever on the saw bench. Pull it, and tell me what you hear.',
    ],
    repair: ['The lever is on the saw bench. Give it a good pull.'],
    done: [
      'Hear that? She sings like she used to.',
      'Feed logs to the saw bench and you will have planks. And if you find iron, Hob can turn it into nails at his anvil.',
      'They say there is a stream out west that no one can cross. Planks and nails make a fine bridge...',
    ],
  },
};
const BR = {
  title: 'Across the Water', state: 'none', planks: 10, nails: 16,   // none -> gather -> done (given by Old Marrow once his first quest is done)
  dialogue: {
    none: [
      'You brought them back, traveller... I owe you a tale.',
      'Far to the west, past the old graveyard, there is a stream. And beyond it, a grove of crystal that sings in the dark. You can hear it on still nights.',
      'No one has crossed since the old bridge burned. Ten planks and sixteen nails would build a new one.',
      'Bram the sawyer cuts the planks. Hob the smith makes the nails from iron. Bring it all to the bank, and build.',
    ],
    gather: () => [`Ten planks and sixteen nails, traveller. You carry ${Math.min(inv.planks, BR.planks)} planks and ${Math.min(inv.nails, BR.nails)} nails.`, 'The crossing is on the east bank, west of the graveyard. Look for the stakes with orange rags.'],
    done: ['The bridge stands again. I can hear the grove singing louder now...', 'Take care among the crystals. They cut sharper than any sword, and Hob can forge shards into something fine.'],
  },
};
const sawmill = { blade: null, carriage: null, lever: null, light: null, running: false, dustT: 0 };
const sawyer = { group: null, marker: null };
avoid.push({ x: SAWMILL.x, z: SAWMILL.z, r: 8 }, { x: BRIDGE.cx + 6, z: BRIDGE.z, r: 3.5 }, { x: BRIDGE.cx - 6, z: BRIDGE.z, r: 3.5 }); // keep both ends of the bridge clear
{
  const shed = new THREE.Group(), plank = mat(0xb89a68), dark = mat(0x2d2530);
  box(7.6, 0.06, 5.6, woodMid, 0, 0.03, 0, shed);                                   // floor
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const p = box(0.35, 3.2, 0.35, woodDark, sx * 3.4, 1.6, sz * 2.4, shed); p.rotation.z = sx * 0.02; }
  { const r = box(8.2, 0.12, 2.8, dark, 0, 3.35, -1.5, shed); r.rotation.x = -0.18; }                  // a roof over the back half only, so the camera can see the saw
  for (const x of [-3.4, -1.7, 0, 1.7, 3.4]) box(0.14, 0.14, 2.6, woodDark, x, 3.3, 1.4, shed);          // bare rafters over the front
  // the cutting rig: its feed direction (local Z) runs along the world X axis, so the log slides left to right and the camera sees the blade face-on
  const rig = new THREE.Group(); rig.rotation.y = Math.PI / 2; shed.add(rig);
  box(1.6, 0.9, 5.4, woodMid, 0, 0.55, 0, rig);                                      // the saw bench
  for (const sx of [-0.55, 0.55]) box(0.1, 0.1, 5.4, metal, sx, 1.05, 0, rig);      // rails
  // circular blade (appears when the mill is mended). Its disc lies along the log's path, with the top poking up through the bench,
  // so the log is sliced lengthwise as it slides past. It spins around the X axis.
  const blade = new THREE.Group(); blade.position.set(0, 1.3, 0); rig.add(blade);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.04, 22), steel); disc.rotation.z = Math.PI / 2; blade.add(disc);
  for (let i = 0; i < 18; i++) { const a = i / 18 * Math.PI * 2, tooth = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 3), steel); tooth.position.set(0, Math.cos(a) * 0.8, Math.sin(a) * 0.8); tooth.rotation.x = a; blade.add(tooth); }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.12, 8), metal); hub.rotation.z = Math.PI / 2; blade.add(hub);
  blade.visible = false;
  const cutLight = new THREE.PointLight(0xffb060, 6, 9, 1.5); cutLight.position.set(0, 2.8, 0); cutLight.userData.base = 0; flickers.push(cutLight); rig.add(cutLight); sawmill.cutLight = cutLight; // lights the blade while it runs
  // carriage: two boards with a slot between them for the blade. The log rides on it and is split into two fresh boards as it passes the blade.
  const carriage = new THREE.Group(); carriage.position.set(0, 1.16, -1.5); rig.add(carriage);
  box(0.56, 0.12, 2.6, woodDark, -0.33, 0, 0, carriage); box(0.56, 0.12, 2.6, woodDark, 0.33, 0, 0, carriage);
  const logUncut = cyl(0.34, 0.34, 1, 8, mat(0x6a4a30), 0, 0.42, 0, carriage); logUncut.rotation.x = Math.PI / 2;
  const freshM = mat(0xc9a56a), cutA = box(0.3, 0.62, 1, freshM, -0.17, 0.42, 0, carriage), cutB = box(0.3, 0.62, 1, freshM, 0.17, 0.42, 0, carriage);
  // lever
  const lever = new THREE.Group(); lever.position.set(3.0, 1.0, 1.0); shed.add(lever);
  box(0.12, 1.0, 0.12, metal, 0, 0.5, 0, lever); box(0.3, 0.12, 0.12, woodDark, 0, 1.0, 0, lever); lever.rotation.z = -0.8;
  // log pile, plank stack, a lantern on a post, a sign
  for (const [x, y, z] of [[-4.8, 0.35, 1.2], [-4.8, 0.35, 2.0], [-4.8, 0.35, 0.4], [-4.8, 0.95, 1.6], [-4.8, 0.95, 0.8]]) { const l = cyl(0.34, 0.34, 2.4, 8, mat(0x6a4a30), x, y, z, shed); l.rotation.z = Math.PI / 2; }
  for (let i = 0; i < 5; i++) box(1.8, 0.1, 0.5, plank, 4.9, 0.1 + i * 0.12, -1.4 + (i % 2) * 0.05, shed);
  cyl(0.06, 0.07, 2.4, 5, woodDark, -3.8, 1.2, 3.0, shed);
  const lampM = new THREE.MeshBasicMaterial({ color: 0x9affc8 }); sawmill.lampM = lampM;
  box(0.26, 0.34, 0.26, lampM, -3.8, 2.5, 3.0, shed);
  const sl = new THREE.PointLight(0x9affc8, 6, 11, 1.5); sl.position.set(-3.8, 2.5, 3.0); sl.userData.base = 6; flickers.push(sl); shed.add(sl); sawmill.light = sl;
  box(1.8, 0.5, 0.06, woodDark, 0, 3.0, 2.85, shed); const icon = cyl(0.17, 0.17, 0.05, 10, steel, 0, 3.0, 2.9, shed); icon.rotation.x = Math.PI / 2;
  shed.position.set(SAWMILL.x, 0, SAWMILL.z); shed.rotation.y = 0;
  shed.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(shed);
  Object.assign(sawmill, { blade, carriage, lever, logUncut, cutA, cutB, cutting: false });
  colliders.push({ x: SAWMILL.x, z: SAWMILL.z, hw: 2.7, hd: 0.8, r: 3 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) colliders.push({ x: SAWMILL.x + sx * 3.4, z: SAWMILL.z + sz * 2.4, r: 0.35 });
  colliders.push({ x: SAWMILL.x - 4.8, z: SAWMILL.z + 1.2, r: 1.5 }, { x: SAWMILL.x + 4.9, z: SAWMILL.z - 1.4, r: 1.1 });

  // Bram the sawyer
  const g = new THREE.Group(), skin = mat(0xd2a88a), shirt = mat(0xb8a88a), dk = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 7), mat(0x6a4a32)); body.position.y = 0.6; g.add(body);
  box(0.75, 0.8, 0.42, shirt, 0, 1.15, 0, g);
  for (const sx of [-0.2, 0.2]) box(0.08, 0.85, 0.46, mat(0x5a2a2a), sx, 1.12, 0, g);   // suspenders
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 6, 5), skin); head.position.y = 1.7; g.add(head);
  box(0.4, 0.34, 0.2, mat(0x5a4030), 0, 1.5, 0.2, g);                                    // beard
  cyl(0.28, 0.28, 0.1, 8, mat(0x3a4a3a), 0, 1.93, 0, g); box(0.34, 0.04, 0.2, mat(0x3a4a3a), 0, 1.88, 0.3, g); // flat cap
  box(0.06, 0.06, 0.04, dk, -0.09, 1.72, 0.25, g); box(0.06, 0.06, 0.04, dk, 0.09, 1.72, 0.25, g);
  box(0.18, 0.18, 0.5, shirt, -0.5, 1.1, 0.2, g);
  box(0.18, 0.18, 0.5, shirt, 0.5, 1.1, 0.2, g);
  box(0.12, 0.16, 0.8, woodDark, 0.5, 0.95, 0.65, g); box(0.9, 0.22, 0.03, steel, 0.5, 0.95, 1.2, g); // handsaw
  g.position.set(SAWMILL.x - 5.2, 0, SAWMILL.z + 3.2); g.rotation.y = 0.5; g.userData.faceY = 0.5;
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const mk = new THREE.Group(), mm = new THREE.MeshBasicMaterial({ color: 0xffd34d });
  box(0.14, 0.38, 0.14, mm, 0, 0.2, 0, mk); box(0.14, 0.14, 0.14, mm, 0, -0.1, 0, mk); g.add(mk);
  scene.add(g); sawyer.group = g; sawyer.marker = mk;
  colliders.push({ x: g.position.x, z: g.position.z, r: 0.5 });
}
function setSawmillRunning(on) {
  sawmill.running = on; sawmill.blade.visible = on; sawmill.lever.rotation.z = on ? 0.6 : -0.8;
  sawmill.cutLight.userData.base = on ? 7 : 0; sawmill.lampM.color.setHex(on ? 0xffb060 : 0x9affc8); sawmill.light.color.setHex(on ? 0xffb060 : 0x9affc8); sawmill.light.userData.base = on ? 9 : 5;
}
function updateSawmill(dt, t) {
  sawyer.marker.visible = SAW.state === 'none' || SAW.state === 'ready';
  sawyer.marker.position.y = 2.6 + Math.sin(t * 3) * 0.1; sawyer.marker.rotation.y = t * 2;
  if (SAW.state === 'wood' && inv.logs >= SAW.need) { SAW.state = 'ready'; renderQuestHud(); toast('Enough logs! Bring them to Bram'); sfx.soul(); }
  if (!sawmill.running) return;
  sawmill.blade.rotation.x -= dt * 22;
  const T = 7, FWD = 0.82, ph = (t % T) / T;                         // one cycle: a slow cutting pass, then a quick return with an empty carriage
  const pz = ph < FWD ? -1.5 + 3.0 * (ph / FWD) : 1.5 - 3.0 * ((ph - FWD) / (1 - FWD));
  sawmill.carriage.position.z = pz;
  const zb = -pz, uncut = Math.max(0, Math.min(2.4, zb + 1.2)), cut = Math.max(0, Math.min(2.4, 1.2 - zb));   // the blade sits at z = -pz in the carriage's own frame
  const loaded = ph < FWD;
  sawmill.cutting = loaded && uncut > 0.05 && cut > 0.05;
  sawmill.logUncut.visible = loaded && uncut > 0.02; sawmill.logUncut.scale.y = Math.max(uncut, 0.001); sawmill.logUncut.position.z = -1.2 + uncut / 2;
  for (const c of [sawmill.cutA, sawmill.cutB]) { c.visible = loaded && cut > 0.02; c.scale.z = Math.max(cut, 0.001); c.position.z = 1.2 - cut / 2; }
  sawmill.cutA.position.x = -0.17 - 0.03; sawmill.cutB.position.x = 0.17 + 0.03;
  if (world === 'outside' && Math.hypot(SAWMILL.x - pPos.x, SAWMILL.z - pPos.y) < 28) {
    sawmill.dustT -= dt;
    if (sawmill.dustT <= 0 && sawmill.cutting) { sawmill.dustT = 0.12; spawnFx(SAWMILL.x, 1.9, SAWMILL.z, 0xe8d4a0, 2); } // sawdust where the blade bites
  }
}
function talkToSawyer() {
  const st = SAW.state, d = SAW.dialogue[st];
  openDialog('Bram the Sawyer', typeof d === 'function' ? d() : d, () => {
    if (st === 'none') { SAW.state = 'wood'; toast('Quest started: The Silent Sawmill'); }
    else if (st === 'ready') { inv.logs -= SAW.need; renderInv(); SAW.state = 'repair'; }
    renderQuestHud();
  }, sawyer.group);
}
function pullLever() {
  openDialog('Sawmill', ['You grip the rusted lever and pull.', 'The saw shudders... then screams to life!'], () => {
    SAW.state = 'done'; setSawmillRunning(true); sfx.lever();
    inv.planks += 4; inv.seen.planks = true; renderInv();
    toast('Quest complete! +4 Planks'); renderQuestHud();
  }, null);
}
function useSawBench() {
  if (SAW.state === 'done') openCrafting('mill');
  else openDialog('Saw Bench', ['The great saw is rusted solid and the carriage is jammed.', SAW.state === 'none' ? 'The sawyer standing nearby might know how to fix it.' : 'Bram is working on it.'], null, null);
}
interactables.push(
  { world: 'outside', getPos: () => sawyer.group.position, r: 3.2, label: 'TALK', act: talkToSawyer },
  { world: 'outside', getPos: () => ({ x: SAWMILL.x + 3.0, z: SAWMILL.z + 1.0 }), r: 1.8, label: 'PULL LEVER', act: pullLever, enabled: () => SAW.state === 'repair' },
  { world: 'outside', getPos: () => ({ x: SAWMILL.x, z: SAWMILL.z + 1.5 }), r: 1.9, label: 'SAW BENCH', act: useSawBench },
);

// graveyard patch near the middle-ish, trees around, pumpkins scattered
for (let i = 0; i < 16; i++) { // tombstones in a cluster
  const a = rnd() * 6.28, d = Math.sqrt(rr(16, 90));
  const x = -9 + Math.cos(a) * d, z = -8 + Math.sin(a) * d;
  if (Math.hypot(x, z) > 5 && Math.hypot(x, z) < WALK_R - 2 && !isCutOff(x, z) && !nearStream(x, z, 2.5) && colliders.every(c => Math.hypot(c.x - x, c.z - z) > 1.6))
    place(tombstone(), x, z, 0.6);
}
for (let i = 0; i < 75; i++) { const [x, z] = spot(5, WORLD_R - 2); place(deadTree(), x, z, 0.45); }
for (let i = 0; i < 20; i++) { const [x, z] = spot(4, WALK_R - 1); place(pumpkin(), x, z, 0.5); }

// spiky grass tufts (low-poly cones, instanced)
{
  const geo = new THREE.ConeGeometry(0.09, 0.45, 3);
  geo.translate(0, 0.22, 0);
  const n = Math.round(1400 * (WORLD_R / 30) ** 2), inst = new THREE.InstancedMesh(geo, mat(0x4f9a4a), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.28, d = Math.sqrt(rnd()) * (WORLD_R - 2), x = Math.cos(a) * d, z = Math.sin(a) * d;
    pos.set(x, heightAt(x, z), z);
    q.setFromEuler(new THREE.Euler(rr(-0.2, 0.2), rnd() * 6.28, rr(-0.2, 0.2)));
    const inFarm = (Math.abs(x - FIELD.x) < FIELD.hw + 0.5 && Math.abs(z - FIELD.z) < FIELD.hd + 0.5) || (Math.abs(x - PEN.x) < PEN.hw + 0.5 && Math.abs(z - PEN.z) < PEN.hd + 0.5) || Math.hypot(x - GROVE.x, z - GROVE.z) < GROVE.r - 1 || Math.hypot(x - SAWMILL.x, z - SAWMILL.z) < 6;
    s.setScalar(inFarm ? 0.0001 : rr(0.7, 1.6)); // no grass tufts poking through the field or pen
    inst.setMatrixAt(i, m.compose(pos, q, s));
    inst.setColorAt(i, col.setHSL(rr(0.25, 0.36), 0.45, rr(0.2, 0.34)));
  }
  inst.receiveShadow = true;
  scene.add(inst);
}

// ghosts drifting around
const ghosts = [];
for (let i = 0; i < 6; i++) {
  const g = ghost(), a = rnd() * 6.28, d = rr(8, WALK_R - 4);
  g.userData = { cx: Math.cos(a) * d, cz: Math.sin(a) * d, r: rr(2, 5), sp: rr(0.2, 0.5), ph: rnd() * 6.28 };
  const u0 = g.userData; // start on their orbit, not at the world origin (the spawn point)
  g.position.set(u0.cx + Math.cos(u0.ph) * u0.r, 0.5 + heightAt(u0.cx, u0.cz), u0.cz + Math.sin(u0.ph) * u0.r);
  scene.add(g); ghosts.push(g);
}

// wisps / fireflies
const wisps = [];
{
  const geo = new THREE.OctahedronGeometry(0.07, 0);
  for (let i = 0; i < 100; i++) {
    const w = new THREE.Mesh(geo, M.wisp);
    const a = rnd() * 6.28, d = Math.sqrt(rnd()) * (WORLD_R - 3);
    w.userData = { x: Math.cos(a) * d, z: Math.sin(a) * d, y: rr(0.6, 2.8), ph: rnd() * 6.28, sp: rr(0.4, 1.2) };
    scene.add(w); wisps.push(w);
  }
}

// ---------- player ----------
const player = new THREE.Group();
const body = new THREE.Group();
player.add(body);
{
  const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 6), M.cloak); cloak.position.y = 0.6;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 6, 5), M.skin); head.position.y = 1.35;
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.5, 6), M.cloak); hood.position.y = 1.6;
  const eyeG = new THREE.BoxGeometry(0.06, 0.06, 0.04), dk = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const e1 = new THREE.Mesh(eyeG, dk), e2 = new THREE.Mesh(eyeG, dk);
  e1.position.set(-0.1, 1.37, 0.25); e2.position.set(0.1, 1.37, 0.25);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.45), M.cloak); arm.position.set(0.34, 0.9, 0.2);
  const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(0.15, 0), M.lantern); lamp.position.set(0.34, 0.8, 0.5);
  body.add(cloak, head, hood, e1, e2, arm, lamp);
  body.traverse(o => { if (o.isMesh) o.castShadow = true; });
}
const lantern = new THREE.PointLight(0xffb050, 3.2, 14, 1.5);
lantern.position.set(0.34, 1.1, 0.5);
lantern.castShadow = false;
body.add(lantern);
flickers.push(lantern); lantern.userData.base = 3.2;
scene.add(player);

const pPos = new THREE.Vector2(0, 0);
let facing = 0, walkT = 0;
const camTarget = new THREE.Vector3(), camWant = new THREE.Vector3();
camera.position.copy(CAM_OFFSET);
camera.lookAt(0, 0, 0);

// ---------- input ----------
const keys = new Set();
addEventListener('keydown', e => {
  if (menuOpen) { if (['Enter', 'Space', 'NumpadEnter'].includes(e.code)) { e.preventDefault(); startGame(); } return; }
  keys.add(e.code); hideHint();
  if (e.code === 'Escape' && crafting) closeCrafting();
  if (['KeyF', 'KeyJ'].includes(e.code) && !e.repeat) attack();
  if (['KeyQ', 'KeyK'].includes(e.code) && !e.repeat) castSpell();
  if (e.code === 'KeyM' && !e.repeat) { initAudio(); setMuted(!audio.muted); }
  if (e.code === 'Space' && !e.repeat && !talking && !currentInteractable()) attack();
  if (['KeyE', 'Space', 'Enter', 'NumpadEnter'].includes(e.code) && !e.repeat) { e.preventDefault(); interact(); }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const stickEl = document.getElementById('stick'), knobEl = document.getElementById('knob');
const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
const JOY_MAX = 55;
const cv = renderer.domElement;
cv.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (joy.id !== null) return;
  joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY; joy.x = joy.y = 0;
  stickEl.style.display = 'block'; stickEl.style.left = e.clientX + 'px'; stickEl.style.top = e.clientY + 'px';
  knobEl.style.transform = 'translate(0,0)';
  cv.setPointerCapture(e.pointerId); hideHint();
});
cv.addEventListener('pointermove', e => {
  if (e.pointerId !== joy.id) return;
  let dx = e.clientX - joy.ox, dy = e.clientY - joy.oy;
  const l = Math.hypot(dx, dy);
  if (l > JOY_MAX) { dx *= JOY_MAX / l; dy *= JOY_MAX / l; }
  joy.x = dx / JOY_MAX; joy.y = dy / JOY_MAX;
  knobEl.style.transform = `translate(${dx}px,${dy}px)`;
});
const endJoy = e => {
  if (e.pointerId !== joy.id) return;
  joy.id = null; joy.x = joy.y = 0; stickEl.style.display = 'none';
};
cv.addEventListener('pointerup', endJoy);
cv.addEventListener('pointercancel', endJoy);
document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

let hintHidden = false;
function hideHint() { if (hintHidden) return; hintHidden = true; document.getElementById('hint').style.opacity = 0; }

function readInput() {
  if (talking || transitioning || crafting) return [0, 0];
  let x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  let y = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
  if (!x && !y) { x = joy.x; y = joy.y; }
  const l = Math.hypot(x, y);
  if (l > 1) { x /= l; y /= l; }
  else if (l < 0.12) { x = y = 0; }
  return [x, y];
}

// ---------- quests & dialogue ----------
const $ = id => document.getElementById(id);
const ui = { quest: $('quest'), arrow: $('arrow'), talk: $('talk'), dialog: $('dialog'), dname: $('dname'), dtext: $('dtext'), dnext: $('dnext'), toast: $('toast') };
let talking = false, crafting = false;

// Quest data: add more entries here later. state: none -> active -> ready -> done
const QUEST = {
  title: 'The Lost Souls', need: 5, state: 'none', found: 0,
  giver: { name: 'Old Marrow', npc: sitters[0] },
  dialogue: {
    none: [
      'Ah... a living soul. Rare, this far from the village.',
      'Sit, if you like. No, wait. The fire keeps us warm, but it does not keep us whole.',
      'Five souls slipped out of these flames tonight. Pale blue things. They hide among the graves and the dead trees.',
      'Bring them back to me, traveller. Your lantern will make them less shy.',
      'And mind the green lights. Those are not souls. Those are hungry.',
    ],
    active: () => [
      `Five pale lights, traveller. You have found ${QUEST.found} so far.`,
      'Look near the graves and the dead trees. Follow the glow on your lantern.',
    ],
    ready: [
      'You have them. I can hear them humming.',
      'Hold them out to the fire...',
      'There. Now they can rest. Thank you, traveller.',
    ],
    done: [
      'The fire burns brighter, thanks to you.',
      'Stay a while, if you dare. I may have more work for you... another night.',
    ],
  },
};
const souls = [];
{
  const coreGeo = new THREE.IcosahedronGeometry(0.2, 0), haloGeo = new THREE.SphereGeometry(0.55, 8, 6);
  const placed = [];
  for (let i = 0; i < QUEST.need; i++) {
    let x, z, tries = 0;
    do { [x, z] = spot(7, WALK_R - 2); tries++; }
    while (tries < 200 && (Math.hypot(x - FIRE.x, z - FIRE.z) < 9 || placed.some(([a, b]) => Math.hypot(a - x, b - z) < 8)));
    placed.push([x, z]);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xbff4ff })));
    g.add(new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ color: 0x4fd0ff, transparent: true, opacity: 0.28, depthWrite: false })));
    g.userData = { x, z, ph: rnd() * 6.28, got: false, orbit: i / QUEST.need * Math.PI * 2 };
    g.position.set(x, heightAt(x, z) + 1, z);
    g.visible = false;
    scene.add(g); souls.push(g);
  }
}

// "!" marker above the quest giver
const marker = new THREE.Group();
{
  const mm = new THREE.MeshBasicMaterial({ color: 0xffd34d });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.38, 0.14), mm), dot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), mm);
  bar.position.y = 0.2; dot.position.y = -0.1;
  marker.add(bar, dot);
  const npc = QUEST.giver.npc;
  marker.position.set(0, 2.1, 0);
  npc.add(marker);
  // Marrow stands out: pointed hat brim and a staff
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.04, 8), npc.children[3].material);
  brim.position.y = 1.28; npc.add(brim);
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.7, 5), M.bark);
  staff.position.set(0.5, 0.85, 0.3); npc.add(staff);
  npc.userData.faceY = npc.rotation.y;
}

// Second quest, from the blacksmith. state: none -> active -> ready -> done
const SQ = {
  title: 'Iron for the Anvil', need: 4, state: 'none', found: 0,
  dialogue: {
    none: [
      '*clang* *clang*',
      'Hm? A customer. Do not see many of those out here.',
      'Name is Hob. I forge, I mend, and I do not talk much. Mind the sparks.',
      'Trouble is, I am out of iron. Not a scrap left.',
      'Four chunks of rust-red ore lie scattered across the island. Ore likes to hide where nothing grows.',
      'Bring them to me and I will forge you something useful. Your little lantern could use some proper iron.',
    ],
    active: () => [
      `Four chunks of rust-red ore, traveller. You have ${SQ.found} so far.`,
      'Look near the dead trees and out toward the edge of the island. Follow the arrow.',
    ],
    ready: [
      'Now that is good iron.',
      '*clang* *clang* *clang*',
      'There. A lantern frame of true iron. It burns brighter and reaches farther than that tin thing you carried. Take it.',
    ],
    done: [
      'How is the lantern treating you?',
      'The anvil is yours whenever you want it. I may have more orders... later.',
    ],
  },
};
const ores = [];
{
  const geo = new THREE.DodecahedronGeometry(0.34, 0);
  const placed = souls.map(o => [o.userData.x, o.userData.z]);
  for (let i = 0; i < SQ.need; i++) {
    let x, z, tries = 0;
    do { [x, z] = spot(12, WALK_R - 1); tries++; }
    while (tries < 300 && (Math.hypot(x - FIRE.x, z - FIRE.z) < 9 || Math.hypot(x - HOUSE.x, z - HOUSE.z) < 8 || placed.some(([a, b]) => Math.hypot(a - x, b - z) < 7)));
    placed.push([x, z]);
    const g = new THREE.Group();
    const rock = new THREE.Mesh(geo, mat(0xb5532a, { emissive: 0x501800, emissiveIntensity: 0.9 }));
    rock.scale.set(1, 0.8, 1.1); rock.rotation.set(rnd() * 3, rnd() * 3, 0);
    const glint = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), new THREE.MeshBasicMaterial({ color: 0xffb36b }));
    glint.position.set(0.12, 0.28, 0.1);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff7a22, transparent: true, opacity: 0.18, depthWrite: false }));
    g.add(rock, glint, halo);
    g.userData = { x, z, ph: rnd() * 6.28, got: false };
    g.position.set(x, heightAt(x, z) + 0.3, z);
    g.visible = false;
    scene.add(g); ores.push(g);
  }
}
const smithMarker = new THREE.Group();
{
  const mm = new THREE.MeshBasicMaterial({ color: 0xffd34d });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.38, 0.14), mm), dot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), mm);
  bar.position.y = 0.2; dot.position.y = -0.1;
  smithMarker.add(bar, dot); smith.group.add(smithMarker);
}

let toastT = 0;
function toast(msg) { sfxForToast(msg); ui.toast.textContent = msg; ui.toast.classList.add('on'); toastT = 3; }
function renderQuestHud() {
  const parts = [];
  if (QUEST.state !== 'none' && QUEST.state !== 'done') parts.push(`<b>${QUEST.title}</b><br>` + (QUEST.state === 'active' ? `Find the lost souls <span>${QUEST.found}/${QUEST.need}</span>`
    : QUEST.state === 'ready' ? 'Return to Old Marrow by the fire' : 'Complete'));
  if (SQ.state !== 'none' && SQ.state !== 'done') parts.push(`<b>${SQ.title}</b><br>` + (SQ.state === 'active' ? `Find iron ore <span>${SQ.found}/${SQ.need}</span>`
    : SQ.state === 'ready' ? 'Return to Hob in the smithy' : 'Complete'));
  if (SAW.state !== 'none' && SAW.state !== 'done') parts.push(`<b>${SAW.title}</b><br>` + (SAW.state === 'wood' ? `Chop logs from dead trees <span>${Math.min(inv.logs, SAW.need)}/${SAW.need}</span>`
    : SAW.state === 'ready' ? 'Bring the logs to Bram' : SAW.state === 'repair' ? 'Pull the lever on the saw bench' : 'Complete'));
  if (BR.state !== 'none' && BR.state !== 'done') parts.push(`<b>${BR.title}</b><br>` + (BR.state === 'gather' ? `Build the bridge: planks <span>${Math.min(inv.planks, BR.planks)}/${BR.planks}</span>, nails <span>${Math.min(inv.nails, BR.nails)}/${BR.nails}</span>` : 'Complete'));
  if (NIGHT.state !== 'none' && NIGHT.state !== 'done') parts.push(`<b>${NIGHT.title}</b><br>` + (NIGHT.state === 'relight' ? 'Relight the scarecrow in the field'
    : NIGHT.state === 'vigil' ? `Defend the field <span>wave ${Math.max(1, NIGHT.wave)}/${NIGHT.waves.length}</span> &middot; wheat <span>${Math.round(NIGHT.wheat * 100)}%</span>`
    : NIGHT.state === 'ready' ? 'Return to Farmer Oda' : 'Complete'));
  ui.quest.style.display = parts.length ? 'block' : 'none';
  ui.quest.innerHTML = parts.join('<div style="height:6px"></div>');
}

// dialogue runner
let lines = [], lineIdx = 0, shown = 0, onEnd = null, talkNpc = null;
const speed = 45; // characters per second
function openDialog(name, ls, end, npc) {
  lines = ls; lineIdx = 0; shown = 0; onEnd = end || null; talkNpc = npc || null;
  talking = true;
  ui.dname.textContent = name;
  ui.dialog.classList.add('on'); ui.talk.classList.remove('on');
  ui.dtext.textContent = '';
}
function talkToMarrow() {
  if (QUEST.state === 'done') { // once the souls are saved, Marrow tells of the grove and gives the bridge quest
    const bs = BR.state, bd = BR.dialogue[bs];
    openDialog(QUEST.giver.name, typeof bd === 'function' ? bd() : bd, () => { if (bs === 'none') { BR.state = 'gather'; toast('Quest started: Across the Water'); } renderQuestHud(); }, QUEST.giver.npc);
    return;
  }
  const s = QUEST.state, d = QUEST.dialogue[s];
  openDialog(QUEST.giver.name, typeof d === 'function' ? d() : d, () => {
    if (s === 'none') {
      QUEST.state = 'active';
      souls.forEach(o => (o.visible = !o.userData.got));
      toast('Quest started: The Lost Souls');
    } else if (s === 'ready') {
      QUEST.state = 'done'; fireBoost = 1.5;
      souls.forEach(o => (o.visible = true));
      toast('Quest complete!');
    }
    renderQuestHud();
  }, QUEST.giver.npc);
}
function talkToSmith() {
  const st = SQ.state, d = SQ.dialogue[st];
  const l = (typeof d === 'function' ? d() : d).slice();
  if (st === 'done' && QUEST.state === 'done') l.push('Old Marrow\'s fire burning brighter? Aye, I saw the glow from my chimney. Good work, traveller.');
  smith.talked = true;
  openDialog('Hob the Smith', l, () => {
    if (st === 'none') {
      SQ.state = 'active';
      ores.forEach(o => (o.visible = !o.userData.got));
      toast('Quest started: Iron for the Anvil');
    } else if (st === 'ready') {
      SQ.state = 'done';
      lantern.userData.base = 7; lantern.distance = 24; // the reward
      toast('Quest complete! Your lantern burns brighter');
    }
    renderQuestHud();
  }, smith.group);
}
function useAnvil() {
  if (SQ.state === 'done') openCrafting('anvil');
  else openDialog('Anvil', ['A heavy iron anvil, scarred by a thousand hammer blows.', 'It is Hob\'s. He will let you use it once you have helped him.'], null, null);
}
function advance() {
  const line = lines[lineIdx];
  if (shown < line.length) { shown = line.length; return; }
  if (++lineIdx >= lines.length) {
    talking = false; talkNpc = null; ui.dialog.classList.remove('on');
    const f = onEnd; onEnd = null; f && f(); return;
  }
  shown = 0;
}
function currentInteractable() {
  let best = null, bd = 1e9;
  for (const o of interactables) {
    if (o.world !== world || (o.enabled && !o.enabled())) continue;
    const p = o.getPos(), d = Math.hypot(p.x - pPos.x, p.z - pPos.y);
    if (d < o.r && d < bd) { best = o; bd = d; }
  }
  return best;
}
function interact() {
  if (crafting) { closeCrafting(); return; }
  if (talking) advance();
  else if (!transitioning) { const o = currentInteractable(); if (o) o.act(); }
}
interactables.push({ world: 'outside', getPos: () => QUEST.giver.npc.position, r: 3.6, label: 'TALK', act: talkToMarrow });
ui.talk.addEventListener('click', () => { ui.talk.blur(); interact(); });
ui.dialog.addEventListener('click', interact);
['pointerdown', 'pointerup'].forEach(ev => { ui.talk.addEventListener(ev, e => e.stopPropagation()); ui.dialog.addEventListener(ev, e => e.stopPropagation()); });

function updateQuests(dt, t) {
  const npc = QUEST.giver.npc;
  // marker visible when the giver has something new to say
  marker.visible = QUEST.state === 'none' || QUEST.state === 'ready' || (QUEST.state === 'done' && BR.state === 'none');
  marker.position.y = 2.1 + Math.sin(t * 3) * 0.1; marker.rotation.y = t * 2;
  smithMarker.visible = SQ.state === 'none' || SQ.state === 'ready';
  smithMarker.position.y = 2.3 + Math.sin(t * 3) * 0.1; smithMarker.rotation.y = t * 2;
  farmer.marker.visible = NIGHT.state === 'none' || NIGHT.state === 'ready';
  farmer.marker.position.y = 2.5 + Math.sin(t * 3) * 0.1; farmer.marker.rotation.y = t * 2;

  // typewriter
  if (talking) {
    const line = lines[lineIdx];
    const prevShown = Math.floor(shown);
    shown = Math.min(line.length, shown + dt * speed);
    const curShown = Math.floor(shown);
    if (curShown > prevShown && curShown % 2 === 0 && line[curShown - 1] !== ' ') sfx.blip(talkNpc);
    ui.dtext.textContent = line.slice(0, Math.floor(shown));
    ui.dnext.style.visibility = shown >= line.length ? 'visible' : 'hidden';
  }
  for (const n of [npc, smith.group, farmer.group, sawyer.group]) {
    let want = n.userData.faceY;
    if (talking && n === talkNpc) want = Math.atan2(pPos.x - n.position.x, pPos.y - n.position.z);
    const d = Math.atan2(Math.sin(want - n.rotation.y), Math.cos(want - n.rotation.y));
    n.rotation.y += d * Math.min(1, dt * (talking && n === talkNpc ? 6 : 4));
  }
  const it = !talking && !transitioning && !crafting ? currentInteractable() : null;
  ui.talk.classList.toggle('on', !!it);
  if (it) ui.talk.textContent = typeof it.label === 'function' ? it.label() : it.label;

  // souls: float, collect, orbit fire when done
  let nearest = null, nd = 1e9;
  if (world === 'outside') for (const o of souls) {
    const u = o.userData;
    if (QUEST.state === 'done') {
      const a = u.orbit + t * 0.6;
      o.position.set(FIRE.x + Math.cos(a) * 1.8, heightAt(FIRE.x, FIRE.z) + 2.4 + Math.sin(t * 2 + u.ph) * 0.2, FIRE.z + Math.sin(a) * 1.8);
    } else if (u.got) { o.visible = false; continue; }
    else {
      o.position.y = heightAt(u.x, u.z) + 1 + Math.sin(t * 2 + u.ph) * 0.25;
      if (!o.visible) continue;
      const d = Math.hypot(u.x - player.position.x, u.z - player.position.z);
      if (d < nd) { nd = d; nearest = u; }
      if (d < 1.3 && QUEST.state === 'active') {
        u.got = true; o.visible = false; QUEST.found++;
        if (QUEST.found >= QUEST.need) { QUEST.state = 'ready'; toast('All souls found! Return to Old Marrow'); }
        else toast(`Soul collected ${QUEST.found}/${QUEST.need}`);
        renderQuestHud();
      }
    }
    o.children[1].scale.setScalar(1 + Math.sin(t * 4 + u.ph) * 0.15);
  }
  // ore pickups
  let nearestOre = null, od = 1e9;
  if (world === 'outside') for (const o of ores) {
    const u = o.userData;
    if (u.got) { o.visible = false; continue; }
    o.children[1].position.y = 0.28 + Math.sin(t * 3 + u.ph) * 0.06;
    o.children[2].scale.setScalar(1 + Math.sin(t * 4 + u.ph) * 0.15);
    if (!o.visible) continue;
    const d = Math.hypot(u.x - pPos.x, u.z - pPos.y);
    if (d < od) { od = d; nearestOre = u; }
    if (d < 1.3 && SQ.state === 'active') {
      u.got = true; o.visible = false; SQ.found++;
      if (SQ.found >= SQ.need) { SQ.state = 'ready'; toast('All ore found! Return to Hob'); }
      else toast(`Iron ore collected ${SQ.found}/${SQ.need}`);
      renderQuestHud();
    }
  }
  // arrow toward the closest current objective
  const cands = [];
  if (QUEST.state === 'active' && nearest) cands.push([nearest.x, nearest.z]);
  if (QUEST.state === 'ready') cands.push([npc.position.x, npc.position.z]);
  if (SQ.state === 'active' && nearestOre) cands.push([nearestOre.x, nearestOre.z]);
  if (SQ.state === 'ready') cands.push([HOUSE.x, HOUSE.z + HOUSE.hd]);
  if (NIGHT.state === 'relight') cands.push([FIELD.x, FIELD.z]);
  if (NIGHT.state === 'ready') cands.push([FARMER_POS.x, FARMER_POS.z]);
  if (SAW.state === 'ready') cands.push([sawyer.group.position.x, sawyer.group.position.z]);
  if (SAW.state === 'repair') cands.push([SAWMILL.x + 3.0, SAWMILL.z + 1.0]);
  if (BR.state === 'gather' && inv.planks >= BR.planks && inv.nails >= BR.nails) cands.push([BRIDGE.x1 + 1, BRIDGE.z]);
  let target = null, bestD = 1e9;
  for (const c of cands) { const d = Math.hypot(c[0] - pPos.x, c[1] - pPos.y); if (d < bestD) { bestD = d; target = c; } }
  if (target && !talking && world === 'outside') {
    const dx = target[0] - player.position.x, dz = target[1] - player.position.z, dist = Math.hypot(dx, dz);
    ui.arrow.style.opacity = dist > 5 ? 0.85 : 0;
    ui.arrow.style.transform = `rotate(${Math.atan2(dx, -dz)}rad) translateY(-95px)`;
  } else ui.arrow.style.opacity = 0;

  if (toastT > 0 && (toastT -= dt) <= 0) ui.toast.classList.remove('on');
}

// ---------- combat ----------
let HP_MAX = 5, SWORD_DMG = 1;
const combat = { hp: HP_MAX, inv: 0, atkT: 0, cd: 0, hit: false, inside: false, dead: false };
const pk = new THREE.Vector2(); // player knockback velocity
const enemies = [], pickups = [], fxPool = [];
const heartsEl = $('hearts'), hurtEl = $('hurt'), atkBtn = $('attack');
function renderHearts() { heartsEl.innerHTML = Array.from({ length: HP_MAX }, (_, i) => `<span class="${i < combat.hp ? 'on' : ''}">&#9829;</span>`).join(''); }
renderHearts();

// the player's sword (left hand) and its slash arc
let swordBladeMat;
const swordGlow = { on: false, halo: null, sprite: null, aura: null, freeze: null }; // freeze: tests can pin the pulse at 0..1
function enableSwordGlow() { // a cyan halo around the blade plus a soft aura, both pulsing in updateCombat
  if (swordGlow.on) return;
  swordGlow.halo = box(0.22, 0.2, 1.2, new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }), 0, 0, 0.82, swordPivot);
  swordGlow.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: grove.glowTex, color: 0x5ff0ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  swordGlow.sprite.position.set(0, 0, 0.85); swordPivot.add(swordGlow.sprite);
  swordGlow.aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: grove.glowTex, color: 0x35e0ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
  swordGlow.aura.position.set(0, 0, 0.7); swordPivot.add(swordGlow.aura); // a wide, faint glow that lights the air around the sword
  swordBladeMat.emissive.setHex(0x35e0ff); swordGlow.on = true;
}
const swordPivot = new THREE.Group();
swordPivot.position.set(-0.34, 0.95, 0.2);
swordPivot.rotation.set(0.55, -0.25, 0);
body.add(swordPivot);
{
  const blade = swordBladeMat = mat(0xdfe6f5, { metalness: 0.3, roughness: 0.4, emissive: 0x223355, emissiveIntensity: 0.5 });
  box(0.07, 0.05, 0.95, blade, 0, 0, 0.8, swordPivot);
  box(0.32, 0.06, 0.09, metal, 0, 0, 0.3, swordPivot);
  cyl(0.03, 0.03, 0.28, 5, woodDark, 0, 0, 0.15, swordPivot).rotation.x = Math.PI / 2;
  swordPivot.traverse(o => { if (o.isMesh) o.castShadow = true; });
}
const slash = new THREE.Mesh(
  new THREE.RingGeometry(0.7, 2.1, 14, 1, -Math.PI / 2 - 1.3, 2.6),
  new THREE.MeshBasicMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
slash.rotation.x = -Math.PI / 2; slash.position.y = 0.25; body.add(slash);

// particles
function spawnFx(x, y, z, color, n) {
  for (let i = 0; i < n; i++) {
    let m = fxPool.find(f => f.userData.life <= 0);
    if (!m) { if (fxPool.length >= 48) return; m = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), new THREE.MeshBasicMaterial({ color })); m.userData = { v: new THREE.Vector3(), life: 0 }; scene.add(m); fxPool.push(m); }
    m.material.color.setHex(color); m.position.set(x, y, z);
    m.userData.v.set((Math.random() - 0.5) * 4, 1.5 + Math.random() * 3, (Math.random() - 0.5) * 4);
    m.userData.life = 0.6 + Math.random() * 0.3; m.visible = true;
  }
}

// ---- skeletons ----
function makeSkeleton() {
  const g = new THREE.Group(), bone = mat(0xd9d3c0), dark = mat(0x2b2433);
  const red = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
  box(0.12, 0.55, 0.12, bone, -0.14, 0.28, 0, g); box(0.12, 0.55, 0.12, bone, 0.14, 0.28, 0, g);
  box(0.42, 0.15, 0.24, bone, 0, 0.62, 0, g);
  box(0.5, 0.55, 0.28, bone, 0, 1.0, 0, g);
  for (let i = 0; i < 3; i++) box(0.52, 0.05, 0.3, dark, 0, 0.88 + i * 0.14, 0.01, g);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.25, 6, 5), bone); skull.position.y = 1.55; g.add(skull);
  box(0.2, 0.1, 0.2, bone, 0, 1.36, 0.04, g);
  box(0.07, 0.07, 0.05, red, -0.09, 1.58, 0.22, g); box(0.07, 0.07, 0.05, red, 0.09, 1.58, 0.22, g);
  box(0.1, 0.5, 0.1, bone, -0.34, 1.0, 0, g);
  const arm = new THREE.Group(); arm.position.set(0.34, 1.2, 0); g.add(arm);
  box(0.1, 0.1, 0.55, bone, 0, 0, 0.27, arm);
  box(0.06, 0.06, 0.85, mat(0x8a5a3a), 0, 0, 0.85, arm);
  box(0.22, 0.05, 0.06, dark, 0, 0, 0.5, arm);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.08), new THREE.MeshBasicMaterial({ color: 0xff3b5c })); bar.position.y = 2.1; bar.visible = false; g.add(bar);
  g.scale.setScalar(1.1);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { g, bone, arm, bar };
}
for (let i = 0; i < 7; i++) {
  let x, z, tries = 0;
  do { [x, z] = hspot(3.5); tries++; } while (tries < 50 && enemies.some(e => Math.hypot(e.home.x - x, e.home.z - z) < 2.8));
  const s = makeSkeleton();
  const e = { ...s, hp: 3, maxHp: 3, home: { x, z }, x, z, face: rnd() * 6, state: 'idle', t: 0, stun: 0, kx: 0, kz: 0, flash: 0, deadT: 0, respawnT: 0, wt: rr(0, 3), tx: x, tz: z, ph: rnd() * 6 };
  s.g.position.set(x, heightAt(x, z), z); scene.add(s.g); enemies.push(e);
}
function respawn(e) { e.hp = e.maxHp; e.state = 'idle'; e.x = e.home.x; e.z = e.home.z; e.g.visible = true; e.g.scale.setScalar(1.1); e.bar.visible = false; e.stun = 0; e.deadT = 0; }

function spawnHeart(x, z) {
  const g = new THREE.Group();
  const h = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), new THREE.MeshBasicMaterial({ color: 0xff3b5c })); h.scale.y = 1.3;
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3b5c, transparent: true, opacity: 0.2, depthWrite: false }));
  g.add(h, halo); g.position.set(x, heightAt(x, z) + 0.6, z); scene.add(g);
  pickups.push({ g, x, z, life: 25, ph: rnd() * 6 });
}

function damageEnemy(e, dmg, dx, dz) {
  const d = Math.hypot(dx, dz) || 1;
  e.hp -= dmg; sfx.hit(); e.flash = 0.18; e.stun = 0.35; e.kx = dx / d * 7; e.kz = dz / d * 7;
  if (e.state === 'windup') e.state = 'chase';
  spawnFx(e.x, 1.1, e.z, 0xe8e0c8, 6);
  e.bar.visible = true; e.bar.scale.x = Math.max(0.01, e.hp / e.maxHp);
  if (e.hp <= 0) {
    e.state = 'dead'; e.deadT = 0; e.respawnT = e.raider ? 1e9 : 30; sfx.skelDie();
    spawnFx(e.x, 1.0, e.z, 0xe8e0c8, 10); spawnFx(e.x, 1.0, e.z, 0xff3b5c, 4);
    e.bone.emissive.setHex(0x000000);
    if (rnd() < 0.45) spawnHeart(e.x, e.z);
  }
}
function applyHits() {
  const fx_ = Math.sin(facing), fz_ = Math.cos(facing);
  for (const e of enemies) {
    if (e.state === 'dead') continue;
    const dx = e.x - pPos.x, dz = e.z - pPos.y, d = Math.hypot(dx, dz);
    if (d < 2.3 && (dx * fx_ + dz * fz_) / (d || 1) > 0.2) damageEnemy(e, SWORD_DMG, dx, dz);
  }
  hitNodes(fx_, fz_);
}
function attack() {
  if (talking || transitioning || crafting || world !== 'outside' || combat.cd > 0 || combat.dead) return;
  combat.cd = 0.5; combat.atkT = 0.0001; combat.hit = false; sfx.swing();
  let best = null, bd = 3.2; // soft aim at the nearest enemy
  for (const e of enemies) { if (e.state === 'dead') continue; const d = Math.hypot(e.x - pPos.x, e.z - pPos.y); if (d < bd) { bd = d; best = e; } }
  if (best) facing = Math.atan2(best.x - pPos.x, best.z - pPos.y);
}
atkBtn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); attack(); });

function hurtPlayer(n, fx_, fz_) {
  if (combat.inv > 0 || combat.dead || world !== 'outside') return;
  combat.hp = Math.max(0, combat.hp - n); combat.inv = 1.1;
  const dx = pPos.x - fx_, dz = pPos.y - fz_, d = Math.hypot(dx, dz) || 1;
  pk.set(dx / d * 7, dz / d * 7);
  sfx.hurt(); renderHearts(); hurtEl.classList.add('on'); setTimeout(() => hurtEl.classList.remove('on'), 220);
  spawnFx(pPos.x, 1, pPos.y, 0xff3b5c, 6);
  if (combat.hp <= 0) playerDie();
}
function playerDie() {
  combat.dead = true; transitioning = true; fadeEl.classList.add('on'); toast('You were defeated...');
  setTimeout(() => {
    combat.hp = HP_MAX; combat.dead = false; combat.inv = 2; slowT = 0; pPos.set(0, 0); pk.set(0, 0);
    vigilFail(null);
    for (const e of enemies) if (!e.raider && e.state !== 'dead') { e.state = 'idle'; e.hp = e.maxHp; e.x = e.home.x; e.z = e.home.z; e.stun = 0; e.bar.visible = false; }
    renderHearts();
    camera.position.set(pPos.x + CAM_OFFSET.x, CAM_OFFSET.y, pPos.y + CAM_OFFSET.z);
    fadeEl.classList.remove('on');
    setTimeout(() => { transitioning = false; toast('You wake at the start of the island'); }, 250);
  }, 900);
}

function pushOut(e, c, r) { // keep a circle (radius r) at e.x/e.z out of a collider
  if (c.hw) {
    const nx = Math.min(c.x + c.hw, Math.max(c.x - c.hw, e.x)), nz = Math.min(c.z + c.hd, Math.max(c.z - c.hd, e.z));
    const dx = e.x - nx, dz = e.z - nz, d = Math.hypot(dx, dz);
    if (d < r && d > 0.0001) { e.x = nx + dx / d * r; e.z = nz + dz / d * r; }
    return;
  }
  const dx = e.x - c.x, dz = e.z - c.z, min = c.r + r, d = Math.hypot(dx, dz);
  if (d < min && d > 0.0001) { e.x = c.x + dx / d * min; e.z = c.z + dz / d * min; }
}
function stepTo(e, tx, tz, sp, dt) {
  const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz);
  if (d > 0.05) { e.x += dx / d * sp * dt; e.z += dz / d * sp * dt; e.face = Math.atan2(dx, dz); e.moving = true; }
}

function updateCombat(dt, t) {
  const out = world === 'outside';
  atkBtn.classList.toggle('on', out && !talking && !transitioning && !crafting);
  combat.cd = Math.max(0, combat.cd - dt); combat.inv = Math.max(0, combat.inv - dt);
  // sword swing
  if (combat.atkT > 0) {
    combat.atkT += dt;
    const p = Math.min(1, combat.atkT / 0.3), ease = 1 - (1 - p) * (1 - p);
    swordPivot.rotation.set(0.1, -1.4 + 2.8 * ease, 0);
    slash.material.opacity = 0.75 * (1 - p);
    if (!combat.hit && p >= 0.35) { combat.hit = true; applyHits(); }
    if (p >= 1) { combat.atkT = 0; swordPivot.rotation.set(0.55, -0.25, 0); slash.material.opacity = 0; }
  }
  body.visible = combat.inv <= 0 || Math.floor(t * 14) % 2 === 0;
  if (swordGlow.on) { // the upgraded blade breathes: glow swells and fades about every three seconds
    const k = swordGlow.freeze ?? 0.5 + 0.5 * Math.sin(t * 2.1);
    swordBladeMat.emissiveIntensity = 0.5 + 2.4 * k;
    swordGlow.halo.material.opacity = 0.08 + 0.45 * k;
    swordGlow.sprite.material.opacity = 0.15 + 0.75 * k; swordGlow.sprite.scale.setScalar(1.4 + 1.1 * k);
    swordGlow.aura.material.opacity = 0.03 + 0.24 * k; swordGlow.aura.scale.setScalar(2.4 + 1.8 * k);
  }
  // particles
  for (const f of fxPool) {
    const u = f.userData; if (u.life <= 0) continue;
    u.life -= dt; u.v.y -= 9 * dt; f.position.addScaledVector(u.v, dt); f.scale.setScalar(Math.max(0.1, u.life / 0.7));
    if (u.life <= 0) f.visible = false;
  }
  if (!out) return;
  if (pk.lengthSq() > 0.01) { pPos.x += pk.x * dt; pPos.y += pk.y * dt; pk.multiplyScalar(Math.max(0, 1 - dt * 8)); }
  const nowIn = inHollow(pPos.x, pPos.y);
  if (nowIn && !combat.inside) toast('The Blighted Hollow... skeletons rise here');
  combat.inside = nowIn;

  // heart pickups
  for (let i = pickups.length - 1; i >= 0; i--) {
    const k = pickups[i]; k.life -= dt;
    k.g.position.y = heightAt(k.x, k.z) + 0.6 + Math.sin(t * 3 + k.ph) * 0.12; k.g.rotation.y = t * 2;
    const d = Math.hypot(k.x - pPos.x, k.z - pPos.y);
    if (k.life <= 0 || (d < 1.1 && combat.hp < HP_MAX)) {
      if (k.life > 0) { combat.hp++; renderHearts(); toast('+1 heart'); }
      scene.remove(k.g); pickups.splice(i, 1);
    }
  }
  if (talking || transitioning || crafting) return;

  // skeleton AI
  const playerHere = inHollow(pPos.x, pPos.y, 3);
  for (const e of enemies) {
    if (e.state === 'dead') {
      e.deadT += dt; e.g.scale.y = Math.max(0.05, 1.1 - e.deadT * 2.4);
      if (e.deadT > 0.5) e.g.visible = false;
      e.respawnT -= dt;
      if (e.respawnT <= 0 && Math.hypot(e.home.x - pPos.x, e.home.z - pPos.y) > 12) respawn(e);
      continue;
    }
    const dx = pPos.x - e.x, dz = pPos.y - e.z, dist = Math.hypot(dx, dz);
    e.t += dt; e.flash = Math.max(0, e.flash - dt); e.moving = false;
    let armT = 0.2;
    if (e.stun > 0) {
      e.stun -= dt; e.x += e.kx * dt; e.z += e.kz * dt; e.kx *= Math.max(0, 1 - dt * 7); e.kz *= Math.max(0, 1 - dt * 7);
    } else if (e.state === 'raid' || e.state === 'trample') {
      // raiders march on the scarecrow and trample the wheat; they fight back if you get close
      if (combat.hp > 0 && dist < 5.5) e.state = 'chase';
      else {
        const sx = FIELD.x - e.x, sz = FIELD.z - e.z, sd = Math.hypot(sx, sz);
        if (sd > 2.2) { e.state = 'raid'; stepTo(e, FIELD.x, FIELD.z, 2.3, dt); }
        else { e.state = 'trample'; e.face = Math.atan2(sx, sz); armT = 0.5 + Math.sin(t * 9 + e.ph) * 0.6; }
      }
    } else if (e.state === 'idle') {
      if (playerHere && dist < 7.5 && combat.hp > 0) { e.state = 'chase'; }
      else {
        e.wt -= dt;
        if (e.wt <= 0) { e.wt = rr(2, 4); e.tx = e.home.x + rr(-2, 2); e.tz = e.home.z + rr(-2, 2); }
        if (Math.hypot(e.tx - e.x, e.tz - e.z) > 0.3) stepTo(e, e.tx, e.tz, 0.8, dt);
      }
    } else if (e.state === 'chase') {
      if (!(playerHere || e.raider) || dist > 16 || combat.hp <= 0) e.state = e.raider ? 'raid' : 'return';
      else if (dist < 1.35) { e.state = 'windup'; e.t = 0; sfx.rattle(); }
      else stepTo(e, pPos.x, pPos.y, 2.8, dt);
    } else if (e.state === 'windup') {
      e.face = Math.atan2(dx, dz); armT = -1.6;
      if (e.t > 0.55) {
        sfx.skelSwing();
        if (dist < 1.9) hurtPlayer(1, e.x, e.z);
        e.state = 'recover'; e.t = 0;
      }
    } else if (e.state === 'recover') {
      armT = e.t < 0.18 ? 0.7 : 0.2;
      if (e.t > 0.7) e.state = 'chase';
    } else if (e.state === 'return') {
      stepTo(e, e.home.x, e.home.z, 2.4, dt);
      if (Math.hypot(e.home.x - e.x, e.home.z - e.z) < 0.6) { e.state = 'idle'; e.hp = e.maxHp; e.bar.visible = false; }
      else if (playerHere && dist < 6) e.state = 'chase';
    }
    // soft collisions: other skeletons, player, scenery
    for (const o of enemies) { if (o === e || o.state === 'dead') continue; const ox = e.x - o.x, oz = e.z - o.z, od = Math.hypot(ox, oz); if (od < 0.9 && od > 0.001) { e.x += ox / od * (0.9 - od) * 0.5; e.z += oz / od * (0.9 - od) * 0.5; } }
    if (dist < 0.8 && dist > 0.001) { const push = (0.8 - dist) * 0.5; pPos.x += dx / dist * push; pPos.y += dz / dist * push; e.x -= dx / dist * push; e.z -= dz / dist * push; }
    for (const c of colliders) pushOut(e, c, 0.4);
    { const q = streamPush(e.x, e.z, 0.4); e.x = q[0]; e.z = q[1]; }
    const rr_ = Math.hypot(e.x, e.z); if (rr_ > WALK_R) { e.x *= WALK_R / rr_; e.z *= WALK_R / rr_; }
    // visuals
    const g = e.g;
    g.position.set(e.x, groundY(e.x, e.z) + (e.moving ? Math.abs(Math.sin(e.t * 9 + e.ph)) * 0.08 : 0), e.z);
    const dr = Math.atan2(Math.sin(e.face - g.rotation.y), Math.cos(e.face - g.rotation.y));
    g.rotation.y += dr * Math.min(1, dt * 10);
    e.arm.rotation.x += (armT - e.arm.rotation.x) * Math.min(1, dt * 18);
    const warn = e.state === 'windup' ? 0.5 + 0.5 * Math.sin(t * 30) : 0;
    e.bone.emissive.setHex(e.flash > 0 ? 0xff2020 : warn > 0 ? 0xffa000 : 0x000000);
    e.bone.emissiveIntensity = e.flash > 0 ? 1.2 : warn;
  }
}

// ---------- spell: Light Nova (a ring of light bursting out from the player) ----------
const spell = { cd: 0, cdMax: 4, t: -1, x: 0, z: 0, hit: new Set() };
const SPELL_R = 7.5, SPELL_T = 0.85, SPELL_DMG = 2;
const spellBtn = $('spell');
const nova = new THREE.Group(); nova.visible = false; scene.add(nova);
const novaMats = {
  core: new THREE.MeshBasicMaterial({ color: 0xcdeaff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  glow: new THREE.MeshBasicMaterial({ color: 0x6a7bff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  wash: new THREE.MeshBasicMaterial({ color: 0x8fb8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  spark: new THREE.MeshBasicMaterial({ color: 0xe8f6ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
};
const novaCore = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 72), novaMats.core);
const novaGlow = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 72), novaMats.glow);
const novaTrail = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 72), novaMats.glow);
const novaWash = new THREE.Mesh(new THREE.CircleGeometry(1, 48), novaMats.wash);
for (const m of [novaCore, novaGlow, novaTrail, novaWash]) { m.rotation.x = -Math.PI / 2; nova.add(m); }
novaWash.position.y = -0.02;
const novaLight = new THREE.PointLight(0x9fd8ff, 0, 22, 1.4); scene.add(novaLight); // always in the scene (intensity 0 when idle) so the light count never changes
const novaSparks = [];
{
  const g = new THREE.OctahedronGeometry(0.09, 0);
  for (let i = 0; i < 44; i++) { const m = new THREE.Mesh(g, novaMats.spark); m.userData = { a: (i / 44) * Math.PI * 2 + rnd() * 0.1, j: rr(0.9, 1.05), lift: rr(0.2, 1.4), ph: rnd() * 6 }; nova.add(m); novaSparks.push(m); }
}
function castSpell() {
  if (talking || transitioning || crafting || world !== 'outside' || combat.dead || spell.cd > 0 || spell.t >= 0) return;
  spell.cd = spell.cdMax; spell.t = 0; spell.x = pPos.x; spell.z = pPos.y; spell.hit.clear();
  nova.position.set(spell.x, heightAt(spell.x, spell.z) + 0.25, spell.z); nova.visible = true;
  novaLight.position.set(spell.x, heightAt(spell.x, spell.z) + 1.8, spell.z);
  spawnFx(spell.x, 1, spell.z, 0xcdeaff, 8); sfx.nova();
}
spellBtn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); castSpell(); });

function updateSpell(dt, t) {
  const out = world === 'outside';
  spellBtn.classList.toggle('on', out && !talking && !transitioning && !crafting);
  spell.cd = Math.max(0, spell.cd - dt);
  spellBtn.style.setProperty('--cd', (spell.cd / spell.cdMax).toFixed(3));
  spellBtn.classList.toggle('ready', spell.cd <= 0);
  if (spell.t < 0) return;
  spell.t += dt;
  const p = Math.min(1, spell.t / SPELL_T), ease = 1 - Math.pow(1 - p, 3), r = Math.max(0.05, SPELL_R * ease);
  const fade = 1 - p;
  novaCore.scale.setScalar(r); novaGlow.scale.setScalar(r); novaTrail.scale.setScalar(Math.max(0.05, r * 0.82)); novaWash.scale.setScalar(r);
  const hold = 1 - p * p; // stays bright for most of the expansion
  novaMats.core.opacity = hold; novaMats.glow.opacity = 0.85 * hold; novaMats.wash.opacity = 0.3 * fade;
  novaLight.intensity = 70 * fade * fade;
  for (const s of novaSparks) {
    const u = s.userData, rad = r * u.j;
    s.position.set(Math.cos(u.a) * rad, 0.15 + u.lift * p * (0.6 + 0.4 * Math.sin(t * 8 + u.ph)), Math.sin(u.a) * rad);
    s.scale.setScalar(Math.max(0.05, fade * (0.8 + 0.5 * Math.sin(t * 20 + u.ph))));
  }
  nova.position.y = heightAt(spell.x, spell.z) + 0.25;
  // damage whatever the ring front has reached
  for (const e of enemies) {
    if (e.state === 'dead' || spell.hit.has(e)) continue;
    const dx = e.x - spell.x, dz = e.z - spell.z;
    if (Math.hypot(dx, dz) <= r) { spell.hit.add(e); damageEnemy(e, SPELL_DMG, dx, dz); e.stun = 0.7; spawnFx(e.x, 1.2, e.z, 0xcdeaff, 8); }
  }
  if (p >= 1) { spell.t = -1; nova.visible = false; novaLight.intensity = 0; }
}

// ---------- third quest, from the farmer: The Night Watch (relight the scarecrow, hold the field) ----------
// state: none -> relight -> vigil -> ready -> done   (a failed vigil drops back to relight)
const NIGHT = {
  title: 'The Night Watch', state: 'none', wave: 0, waves: [3, 4, 5], nextT: 0, wheat: 1, hudT: 0,
  dialogue: {
    none: [
      'Oh! Thank the stars. A traveller.',
      'That scarecrow is all that keeps the night-things off my wheat. Its light has guttered, and the bones are coming out of the hollow.',
      'Relight it with your lantern. Then hold the field until the last of them falls.',
      'Do not let them trample the wheat. It is all I have.',
    ],
    relight: ['The scarecrow is cold and dark. Hold your lantern to its pumpkin.', 'Hurry. I can hear them rattling.'],
    vigil: ['Hold the field! Do not let them trample the wheat!'],
    ready: [
      'You held the field! I watched from the windmill... and the wheat is still standing.',
      'The scarecrow burns steady now. Take this, a spark of its flame. It will keep you on your feet.',
    ],
    done: ['The scarecrow keeps watch every night now.', 'The skeletons still creep out of the hollow, but they stay away from my wheat. Safe travels.'],
  },
};
const FARMER_POS = { x: FARM.x + 0.5, z: FARM.z - 1.5 };
const farmer = { group: null };
{
  const g = new THREE.Group(), skin = mat(0xd9b99b), shawl = mat(0x5a6a3a), straw = mat(0xb89a50), dk = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.3, 7), shawl); body.position.y = 0.65; g.add(body);
  box(0.7, 0.35, 0.4, mat(0x7a5a3a), 0, 1.15, 0, g);                                  // shoulders / shawl
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 6, 5), skin); head.position.y = 1.55; g.add(head);
  cyl(0.5, 0.5, 0.04, 8, straw, 0, 1.75, 0, g);
  const hatTop = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.4, 7), straw); hatTop.position.y = 1.97; g.add(hatTop);
  box(0.06, 0.06, 0.04, dk, -0.09, 1.58, 0.23, g); box(0.06, 0.06, 0.04, dk, 0.09, 1.58, 0.23, g);
  box(0.18, 0.18, 0.5, shawl, -0.45, 1.0, 0.2, g);
  cyl(0.03, 0.03, 1.9, 5, M.bark, 0.5, 0.95, 0.15, g);                                 // pitchfork
  for (const x of [-0.08, 0, 0.08]) box(0.025, 0.3, 0.025, steel, 0.5 + x, 1.95, 0.15, g);
  box(0.28, 0.025, 0.025, steel, 0.5, 1.82, 0.15, g);
  box(0.16, 0.2, 0.16, M.lantern, -0.45, 0.82, 0.5, g);                                 // her lantern
  g.position.set(FARMER_POS.x, 0, FARMER_POS.z); g.rotation.y = 0.6; g.userData.faceY = 0.6;
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const mk = new THREE.Group(), mm = new THREE.MeshBasicMaterial({ color: 0xffd34d });
  box(0.14, 0.38, 0.14, mm, 0, 0.2, 0, mk); box(0.14, 0.14, 0.14, mm, 0, -0.1, 0, mk); g.add(mk); farmer.marker = mk;
  scene.add(g); farmer.group = g;
  colliders.push({ x: FARMER_POS.x, z: FARMER_POS.z, r: 0.5 });
}

// the scarecrow's flame, and the wheat's health (stalks vanish as it is trampled)
function setScarecrowLit(on, strong) {
  farm.scGlow.color.setHex(on ? 0xffb347 : 0x5a3f1e);
  farm.scLight.userData.base = on ? (strong ? 9 : 7) : 0.9; farm.scLight.distance = on ? (strong ? 15 : 12) : 9;
}
function setWheatHealth(frac) {
  const w = farm.wheat, target = Math.min(w.n, Math.floor((1 - frac) * w.n)), arr = w.stalks.instanceMatrix.array, earArr = w.ears.instanceMatrix.array;
  while (w.dead > target) { const i = w.order[--w.dead]; for (let k = 0; k < 16; k++) { arr[i * 16 + k] = w.backup[i * 16 + k]; earArr[i * 16 + k] = w.backup[i * 16 + k]; } }
  while (w.dead < target) { const i = w.order[w.dead++]; for (let k = 0; k < 16; k++) { arr[i * 16 + k] = 0; earArr[i * 16 + k] = 0; } }
  w.stalks.instanceMatrix.needsUpdate = true; w.ears.instanceMatrix.needsUpdate = true;
}
setScarecrowLit(false);

// raiders: skeletons that march from the hollow side on the scarecrow (they reuse the combat system)
const raiders = [];
{
  for (let i = 0; i < 5; i++) {
    const s = makeSkeleton();
    const e = { ...s, raider: true, hp: 3, maxHp: 3, home: { x: FIELD.x, z: FIELD.z - 15 }, x: FIELD.x, z: FIELD.z - 15, face: 0, state: 'dead', t: 0, stun: 0, kx: 0, kz: 0, flash: 0, deadT: 99, respawnT: 1e9, wt: 0, tx: 0, tz: 0, ph: rnd() * 6 };
    s.g.visible = false; scene.add(s.g); enemies.push(e); raiders.push(e);
  }
}
function spawnWave() {
  NIGHT.wave++;
  const n = NIGHT.waves[NIGHT.wave - 1];
  for (let i = 0; i < n; i++) {
    const e = raiders[i]; respawn(e);
    e.x = FIELD.x - 2 + rr(-3, 3); e.z = FIELD.z - 15 + rr(-2, 2); e.state = 'raid'; e.t = 0; e.respawnT = 1e9;
    e.g.position.set(e.x, heightAt(e.x, e.z), e.z);
  }
  toast(`Wave ${NIGHT.wave} of ${NIGHT.waves.length}!`); sfx.horn(); renderQuestHud();
}
function startVigil() {
  NIGHT.state = 'vigil'; NIGHT.wave = 0; NIGHT.nextT = 3; NIGHT.wheat = 1; farm.awake = true;
  setWheatHealth(1); setScarecrowLit(true); renderQuestHud();
  toast('The scarecrow wakes! Defend the field!');
}
function endVigilReset() { // clear the field and put things back
  for (const e of raiders) { e.state = 'dead'; e.deadT = 99; e.g.visible = false; e.respawnT = 1e9; }
  NIGHT.nextT = 0; farm.awake = false;
}
function vigilFail(msg) {
  if (NIGHT.state !== 'vigil') return;
  endVigilReset(); NIGHT.state = 'relight'; NIGHT.wheat = 1; setWheatHealth(1); setScarecrowLit(false); renderQuestHud();
  if (msg) toast(msg);
}
function vigilWin() {
  endVigilReset(); NIGHT.state = 'ready'; setScarecrowLit(true, true); renderQuestHud();
  toast('The field is saved! Return to the farmer'); sfx.soul();
}
function updateVigil(dt) {
  if (NIGHT.state !== 'vigil' || talking || transitioning || crafting) return;
  if (NIGHT.nextT > 0) { NIGHT.nextT -= dt; if (NIGHT.nextT <= 0) spawnWave(); }
  else {
    let alive = 0, tramplers = 0;
    for (const e of raiders) { if (e.state !== 'dead') alive++; if (e.state === 'trample') tramplers++; }
    if (alive === 0) { if (NIGHT.wave >= NIGHT.waves.length) { vigilWin(); return; } NIGHT.nextT = 4; toast(`Wave ${NIGHT.wave} cleared`); }
    if (tramplers) {
      NIGHT.wheat = Math.max(0, NIGHT.wheat - tramplers * 0.008 * dt); setWheatHealth(NIGHT.wheat);
      NIGHT.hudT -= dt; if (NIGHT.hudT <= 0) { NIGHT.hudT = 0.4; renderQuestHud(); }
      if (NIGHT.wheat <= 0) vigilFail('The wheat is trampled... relight the scarecrow to try again');
    }
  }
}

function talkToFarmer() {
  const st = NIGHT.state, d = NIGHT.dialogue[st];
  openDialog('Farmer Oda', typeof d === 'function' ? d() : d, () => {
    if (st === 'none') { NIGHT.state = 'relight'; toast('Quest started: The Night Watch'); }
    else if (st === 'ready') {
      NIGHT.state = 'done'; HP_MAX = 6; combat.hp = HP_MAX; renderHearts(); setScarecrowLit(true, true);
      toast('Quest complete! +1 max heart');
    }
    renderQuestHud();
  }, farmer.group);
}
function relightScarecrow() {
  openDialog('Scarecrow', ['The pumpkin face is cold and dark.', 'You hold your lantern to it... the wick catches. Two eyes flare open.'], () => startVigil(), null);
}
interactables.push(
  { world: 'outside', getPos: () => farmer.group.position, r: 3.2, label: 'TALK', act: talkToFarmer },
  { world: 'outside', getPos: () => farm.scare.position, r: 2.6, label: 'RELIGHT', act: relightScarecrow, enabled: () => NIGHT.state === 'relight' },
);
renderQuestHud();

// ---------- gathering and crafting: chop dead trees for logs, mine iron veins, a tiny crafting window ----------
const NAMES = { logs: ['Log', 'Logs'], planks: ['Plank', 'Planks'], iron: ['Iron', 'Iron'], nails: ['Nail', 'Nails'], shards: ['Shard', 'Shards'] };
const resources = { hinted: false };
const invEl = $('inv');
function renderInv() {
  const html = Object.keys(NAMES).filter(k => inv[k] > 0 || inv.seen[k]).map(k => `<div class="it ${k}">${NAMES[k][1]} <b>${inv[k]}</b></div>`).join('');
  invEl.innerHTML = html; invEl.style.display = html ? 'block' : 'none';
}
function addItem(k, n) { inv[k] += n; inv.seen[k] = true; renderInv(); renderQuestHud(); if (crafting) renderCraft(); }
renderInv();

// resource nodes: every dead tree, plus a handful of iron veins out in the woods
const nodes = [];
function makeNode(obj, kind, hp) {
  const n = { obj, kind, hp, maxHp: hp, x: obj.position.x, z: obj.position.z, state: 'ok', t: 0, rt: 0, shake: 0, dirx: 0, dirz: 1, q0: obj.quaternion.clone(), s0: obj.scale.x, cr: obj.userData.collider ? obj.userData.collider.r : 0 };
  nodes.push(n); return n;
}
treeObjs.forEach(t => makeNode(t, 'tree', 3));
grove.clusters.forEach(c => { makeNode(c.grp, 'crystal', 3).extra = c; }); // each crystal cluster can be mined for shards once the bridge is built
function makeVein() {
  const g = new THREE.Group(), rockM = mat(0x4a4650), glintM = new THREE.MeshBasicMaterial({ color: 0xff8a3c });
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.DodecahedronGeometry(rr(0.4, 0.6), 0), rockM);
    r.position.set(rr(-0.5, 0.5), 0.3, rr(-0.5, 0.5)); r.scale.y = 0.8; r.rotation.set(rnd() * 3, rnd() * 3, 0); g.add(r);
    box(0.1, 0.1, 0.1, glintM, r.position.x + 0.2, 0.5, r.position.z + 0.15, g);
  }
  return g;
}
for (let i = 0; i < 7; i++) { const [x, z] = spot(10, WALK_R - 3), v = makeVein(); place(v, x, z, 0.9); makeNode(v, 'iron', 3); }

function scareCrowsOff(tree) { // a crow cannot stay on a tree that is being felled
  for (const c of crows) {
    if (c.tree !== tree) continue;
    if (c.state === 'perch') { const a = rnd() * 6.28; c.state = 'flee'; c.t = 0; c.vx = Math.cos(a) * 6.5; c.vz = Math.sin(a) * 6.5; c.tree = null; c.face = Math.atan2(c.vx, c.vz); spawnFx(c.x, c.y + 0.2, c.z, 0x2a2040, 6); }
    else if (c.state === 'land') { c.state = 'gone'; c.gone = 3; c.g.visible = false; c.tree = null; }
  }
}
function breakNode(n) {
  if (n.obj.userData.collider) n.obj.userData.collider.r = -5; // nothing blocks the spot any more
  if (n.kind === 'tree') { n.state = 'falling'; n.t = 0; scareCrowsOff(n.obj); addItem('logs', 2); toast('+2 Logs'); sfx.fell(); }
  else if (n.kind === 'crystal') { n.state = 'gone'; n.rt = 180; n.obj.visible = false; n.extra.decal.visible = false; addItem('shards', 2); toast('+2 Shards'); sfx.glint(); }
  else { n.state = 'gone'; n.rt = 120; n.obj.visible = false; addItem('iron', 1); toast('+1 Iron'); sfx.ore(); }
}
function hitNodes(fx_, fz_) { // called from the sword swing
  for (const n of nodes) {
    if (n.state !== 'ok') continue;
    const dx = n.x - pPos.x, dz = n.z - pPos.y, d = Math.hypot(dx, dz);
    if (d > 2.5 || (dx * fx_ + dz * fz_) / (d || 1) < 0.15) continue;
    if (n.kind === 'iron' && SQ.state !== 'done') { if (!resources.hinted) { resources.hinted = true; toast('Rust-veined rock... Hob might know what to do with iron.'); } continue; }
    n.hp--; n.shake = 0.3; n.dirx = dx / (d || 1); n.dirz = dz / (d || 1);
    if (n.kind === 'crystal') sfx.chip(); else sfx.chop();
    spawnFx(n.x - n.dirx * 0.5, 1.0, n.z - n.dirz * 0.5, n.kind === 'tree' ? 0x8a6a44 : n.kind === 'crystal' ? CRYSTAL_COLS[n.extra.ci] : 0xb5532a, 4);
    if (n.hp <= 0) breakNode(n);
  }
}
const _axis = new THREE.Vector3();
function updateNodes(dt) {
  for (const n of nodes) {
    const o = n.obj;
    if (n.state === 'ok') {
      if (n.shake > 0) {
        n.shake -= dt;
        if (n.kind === 'tree') { o.quaternion.copy(n.q0); o.rotateOnWorldAxis(_axis.set(n.dirz, 0, -n.dirx), Math.sin(n.shake * 50) * 0.05 * Math.max(0, n.shake / 0.3)); }
        else o.scale.setScalar(n.s0 * (1 + Math.sin(n.shake * 50) * 0.06));
        if (n.shake <= 0) { o.quaternion.copy(n.q0); o.scale.setScalar(n.kind !== 'tree' ? n.s0 * (0.4 + 0.6 * n.hp / n.maxHp) : n.s0); } // veins shrink with every hit
      }
    } else if (n.state === 'falling') {
      n.t += dt; const p = Math.min(1, n.t / 0.8);
      o.quaternion.copy(n.q0); o.rotateOnWorldAxis(_axis.set(n.dirz, 0, -n.dirx), p * p * 1.5);
      if (p >= 1) { o.visible = false; n.state = 'gone'; n.rt = 90; }
    } else if (n.state === 'gone') {
      n.rt -= dt;
      if (n.rt <= 0 && Math.hypot(n.x - pPos.x, n.z - pPos.y) > 10) { o.visible = true; if (n.extra) n.extra.decal.visible = true; o.quaternion.copy(n.q0); n.hp = n.maxHp; n.state = 'grow'; n.t = 0; o.scale.setScalar(n.s0 * 0.15); }
    } else if (n.state === 'grow') {
      n.t += dt; const s = Math.min(1, n.t / 1.2); o.scale.setScalar(n.s0 * (0.15 + 0.85 * s));
      if (s >= 1) { n.state = 'ok'; if (o.userData.collider) o.userData.collider.r = n.cr; }
    }
  }
}

// crafting window: very simple, opens at the saw bench and the anvil once their quests are done
const craftEl = $('craft'), ctitle = $('ctitle'), clist = $('clist');
const RECIPES = {
  mill: { title: 'Sawmill', rows: [{ gain: { planks: 2 }, cost: { logs: 1 } }] },
  anvil: { title: 'Anvil', rows: [
    { gain: { nails: 4 }, cost: { iron: 1 } },
    { name: 'Crystal Lantern', note: 'a brighter lantern that reaches farther', cost: { shards: 6, iron: 2 }, once: 'lantern', apply: () => { lantern.userData.base = 10; lantern.distance = 30; } },
    { name: 'Crystal Edge', note: 'the sword hits for double damage', cost: { shards: 8, nails: 4 }, once: 'sword', apply: () => { SWORD_DMG = 2; slash.material.color.setHex(0x7ff4ff); enableSwordGlow(); } },
  ] },
};
const fmt = o => Object.entries(o).map(([k, v]) => `${v} ${NAMES[k][v === 1 ? 0 : 1]}`).join(' + ');
let craftKind = null;
function renderCraft() {
  clist.innerHTML = RECIPES[craftKind].rows.map((r, i) => {
    const owned = r.once && inv.owned[r.once], ok = !owned && Object.entries(r.cost).every(([k, v]) => inv[k] >= v);
    return `<div class="row"><div><b>${r.name || fmt(r.gain)}</b><small>${owned ? 'already forged' : 'costs ' + fmt(r.cost) + (r.note ? ' &middot; ' + r.note : '')}</small></div><button data-i="${i}" ${ok ? '' : 'disabled'}>${owned ? 'Done' : 'Craft'}</button></div>`;
  }).join('');
}
function openCrafting(kind) { craftKind = kind; crafting = true; ctitle.textContent = RECIPES[kind].title; renderCraft(); craftEl.classList.add('on'); }
function closeCrafting() { if (menuOpen) return; crafting = false; craftEl.classList.remove('on'); }
clist.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  const r = RECIPES[craftKind].rows[+b.dataset.i];
  for (const [k, v] of Object.entries(r.cost)) inv[k] -= v;
  if (r.gain) for (const [k, v] of Object.entries(r.gain)) { inv[k] += v; inv.seen[k] = true; }
  if (r.once) { inv.owned[r.once] = true; r.apply(); toast(r.name + ' forged!'); }
  sfx.craft(); renderInv(); renderQuestHud(); renderCraft();
});
$('cclose').addEventListener('click', closeCrafting);
['pointerdown', 'pointerup'].forEach(ev => craftEl.addEventListener(ev, e => e.stopPropagation()));

// ---------- the bridge ("Across the Water"): built from planks and nails on the east bank, then anyone can cross ----------
const bridge = { parts: [], shown: 0, building: false, t: 0, stakes: null, light: null };
{
  const g = new THREE.Group(), plankM = mat(0xb89a68), beamM = mat(0x5a3b24), lampM = new THREE.MeshBasicMaterial({ color: 0xffb060 });
  const len = BRIDGE.x1 - BRIDGE.x0, cx = BRIDGE.cx, z0 = BRIDGE.z, y0 = BRIDGE.y;
  const add = m => { m.visible = false; bridge.parts.push(m); g.add(m); return m; };
  // stage 1: posts along both sides (they reach down into the stream bed)
  const nPosts = 5;
  for (let i = 0; i < nPosts; i++) for (const sd of [-1, 1]) {
    const x = BRIDGE.x0 + 0.4 + i * (len - 0.8) / (nPosts - 1), post = add(box(0.22, 2.3, 0.22, beamM, x, 0.3, z0 + sd * 1.3, g)); post.rotation.z = rr(-0.03, 0.03);
  }
  // stage 2: two beams, then the deck planks one after another across the stream
  for (const sd of [-1, 1]) add(box(len, 0.14, 0.16, beamM, cx, y0 - 0.12, z0 + sd * 1.0, g));
  const nPl = Math.round(len / 0.5);
  for (let i = 0; i < nPl; i++) add(box(0.46, 0.1, 2.7, plankM, BRIDGE.x0 + 0.25 + i * (len - 0.5) / (nPl - 1), y0 + rr(-0.01, 0.01), z0 + rr(-0.04, 0.04), g));
  // stage 3: rails and two lanterns
  for (const sd of [-1, 1]) { add(box(len, 0.08, 0.1, beamM, cx, y0 + 1.0, z0 + sd * 1.3, g)); add(box(len, 0.08, 0.1, beamM, cx, y0 + 0.5, z0 + sd * 1.3, g)); }
  for (const x of [BRIDGE.x0 + 0.4, BRIDGE.x1 - 0.4]) add(box(0.22, 0.28, 0.22, lampM, x, 1.6, z0 + 1.3, g));
  const bl = new THREE.PointLight(0xffb060, 5, 9, 1.5); bl.position.set(cx, 2.2, z0); bl.userData.base = 0; flickers.push(bl); g.add(bl); bridge.light = bl;
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(g);
  // survey stakes with orange rags mark the crossing until the building starts
  const st = new THREE.Group(), rag = new THREE.MeshBasicMaterial({ color: 0xff7a22 });
  for (const [x, zz] of [[BRIDGE.x1 + 0.6, z0 - 1.5], [BRIDGE.x1 + 0.6, z0 + 1.5], [BRIDGE.x0 - 0.6, z0 - 1.5], [BRIDGE.x0 - 0.6, z0 + 1.5]]) {
    cyl(0.04, 0.05, 1.2, 5, woodDark, x, 0.6 + heightAt(x, zz), zz, st); box(0.3, 0.16, 0.03, rag, x + 0.15, 1.1 + heightAt(x, zz), zz, st);
  }
  box(1.1, 0.5, 0.06, woodDark, BRIDGE.x1 + 1.4, 1.0, z0, st); // a small sign on the near bank
  scene.add(st); bridge.stakes = st;
}
const haveBridgeMaterials = () => inv.planks >= BR.planks && inv.nails >= BR.nails;
function startBuild() {
  inv.planks -= BR.planks; inv.nails -= BR.nails; renderInv(); renderQuestHud();
  bridge.building = true; bridge.t = 0; bridge.shown = 0; bridge.stakes.visible = false; toast('Building the bridge...');
}
function finishBridge() {
  bridge.building = false; BRIDGE.open = true; bridge.light.userData.base = 5;
  const half = (BRIDGE.x1 - BRIDGE.x0) / 2 - 1.0; // rails only along the span over the water, so the banks stay open
  for (const sd of [-1, 1]) colliders.push({ x: BRIDGE.cx, z: BRIDGE.z + sd * 1.35, hw: half, hd: 0.1, r: half });
  BR.state = 'done'; renderQuestHud(); toast('Quest complete! The way west is open'); sfx.questDone();
}
function updateBridge(dt) {
  if (!bridge.building) return;
  bridge.t += dt * 9;
  while (bridge.shown < Math.min(bridge.parts.length, Math.floor(bridge.t))) {
    const m = bridge.parts[bridge.shown++]; m.visible = true;
    if (bridge.shown % 2 === 0) { sfx.chop(); spawnFx(m.position.x, 0.6, m.position.z, 0xe0c080, 1); }
  }
  if (bridge.shown >= bridge.parts.length) finishBridge();
}
interactables.push({
  world: 'outside', getPos: () => ({ x: BRIDGE.x1 + 1.0, z: BRIDGE.z }), r: 2.3,
  label: () => (haveBridgeMaterials() ? 'BUILD BRIDGE' : 'BRIDGE SITE'),
  enabled: () => BR.state === 'gather' && !bridge.building,
  act: () => {
    if (haveBridgeMaterials()) startBuild();
    else openDialog('Bridge site', ['This is where the old bridge stood. The stream is far too wide and cold to cross.', `You need ${BR.planks} planks and ${BR.nails} nails to build a new one. You carry ${inv.planks} planks and ${inv.nails} nails.`], null, null);
  },
});

// ---------- bunnies: nibble grass, hop around, scatter when you get close ----------
const bunnies = [];
const BUNNY_SCARE_R = 4.2;
function makeBunny(col) {
  const g = new THREE.Group(), fur = mat(col, { emissive: col, emissiveIntensity: 0.28 }), white = mat(0xf4efe6, { emissive: 0xf4efe6, emissiveIntensity: 0.35 }), dark = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.28, 7, 5), fur); body.scale.set(1, 0.85, 1.3); body.position.y = 0.3; g.add(body);
  const head = new THREE.Group(); head.position.set(0, 0.45, 0.32); g.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 5), fur));
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 4, 3), mat(0xe8a0a0)); nose.position.set(0, -0.02, 0.17); head.add(nose);
  box(0.03, 0.03, 0.02, dark, -0.08, 0.04, 0.14, head); box(0.03, 0.03, 0.02, dark, 0.08, 0.04, 0.14, head);
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.03), fur);
    ear.position.set(sx * 0.07, 0.26, -0.02); ear.rotation.z = -sx * 0.15; head.add(ear); ears.push(ear);
  }
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.09, 5, 4), white); tail.position.set(0, 0.36, -0.36); g.add(tail);
  for (const sx of [-1, 1]) { box(0.1, 0.13, 0.24, fur, sx * 0.17, 0.1, -0.08, g); box(0.06, 0.15, 0.06, fur, sx * 0.1, 0.075, 0.22, g); }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { g, head, ears };
}
{
  const furs = [0xa07c55, 0xc4b09c, 0x8a7058, 0xf0ebe0, 0xb08a60];
  for (let i = 0; i < 12; i++) {
    let x, z, tries = 0;
    do { [x, z] = spot(5, WALK_R - 3); tries++; } while (tries < 60 && (inHollow(x, z, 3) || Math.hypot(x - HOUSE.x, z - HOUSE.z) < 6));
    const b = makeBunny(furs[i % furs.length]);
    Object.assign(b, { x, z, face: rnd() * 6.28, state: 'eat', t: 0, dur: rr(1, 4), hop: null, hopsLeft: 0, ph: rnd() * 6, y: 0 });
    b.g.position.set(x, heightAt(x, z), z); b.g.rotation.y = b.face; scene.add(b.g); bunnies.push(b);
  }
}
function bunnyHop(b, dx, dz, len, dur, h) {
  const d = Math.hypot(dx, dz) || 1; let tx = b.x + dx / d * len, tz = b.z + dz / d * len;
  if (inHollow(tx, tz, 1.5) || Math.hypot(tx, tz) > WALK_R - 0.5) { tx = b.x - dx / d * len; tz = b.z - dz / d * len; } // don't hop into the hollow or off the island
  b.hop = { t: 0, dur, x0: b.x, z0: b.z, x1: tx, z1: tz, h }; b.face = Math.atan2(tx - b.x, tz - b.z);
}
function updateBunnies(dt, t) {
  if (world !== 'outside') return;
  for (const b of bunnies) {
    const px = pPos.x - b.x, pz = pPos.y - b.z, pd = Math.hypot(px, pz);
    const scared = pd < BUNNY_SCARE_R || (spell.t >= 0 && Math.hypot(b.x - spell.x, b.z - spell.z) < 6);
    if (scared && b.state !== 'flee') { b.state = 'flee'; b.t = 0; b.hop = null; }
    b.t += dt;
    if (b.hop) { // mid-hop: arc through the air, stretch on takeoff, squash on landing
      const h = b.hop; h.t += dt; const u = Math.min(1, h.t / h.dur);
      b.x = h.x0 + (h.x1 - h.x0) * u; b.z = h.z0 + (h.z1 - h.z0) * u; b.y = Math.sin(u * Math.PI) * h.h;
      if (u >= 1) { b.hop = null; b.y = 0; if (pd < 9) sfx.hop(0.08 * (1 - pd / 9)); }
    } else if (b.state === 'eat') {
      if (b.t > b.dur) { b.state = 'look'; b.t = 0; }
    } else if (b.state === 'look') {
      if (b.t > 0.6) { b.state = 'hop'; b.t = 0; b.hopsLeft = 1 + Math.floor(rnd() * 3); b.hx = rr(-1, 1); b.hz = rr(-1, 1); }
    } else if (b.state === 'hop') {
      if (b.hopsLeft <= 0) { b.state = 'eat'; b.t = 0; b.dur = rr(2, 5); }
      else { b.hopsLeft--; bunnyHop(b, b.hx + rr(-0.4, 0.4), b.hz + rr(-0.4, 0.4), rr(0.8, 1.4), 0.38, 0.3); }
    } else if (b.state === 'flee') {
      if (!scared && b.t > 0.5) { b.state = 'look'; b.t = 0; }
      else bunnyHop(b, -px + rr(-0.5, 0.5) * pd * 0.2, -pz + rr(-0.5, 0.5) * pd * 0.2, rr(1.5, 2.2), 0.27, 0.34);
    }
    for (const c of colliders) pushOut(b, c, 0.25);
    { const q = streamPush(b.x, b.z, 0.25); b.x = q[0]; b.z = q[1]; }
    const r = Math.hypot(b.x, b.z); if (r > WALK_R) { b.x *= WALK_R / r; b.z *= WALK_R / r; }
    // pose
    const g = b.g, u = b.hop ? b.hop.t / b.hop.dur : 0;
    g.position.set(b.x, groundY(b.x, b.z) + b.y, b.z);
    g.rotation.y += Math.atan2(Math.sin(b.face - g.rotation.y), Math.cos(b.face - g.rotation.y)) * Math.min(1, dt * 14);
    g.rotation.x = b.hop ? (0.5 - u) * 0.7 : 0;
    g.scale.set(1, b.hop ? 1 + 0.12 * Math.sin(u * Math.PI) : 1, 1);
    const eating = !b.hop && b.state === 'eat', alert = !b.hop && (b.state === 'look' || b.state === 'flee');
    const headX = eating ? 0.75 + Math.sin(t * 16 + b.ph) * 0.09 : alert ? -0.2 : 0.1;
    b.head.rotation.x += (headX - b.head.rotation.x) * Math.min(1, dt * 12);
    b.head.position.y += ((eating ? 0.32 : 0.45) - b.head.position.y) * Math.min(1, dt * 10);
    const twitch = Math.sin(t * 7 + b.ph) > 0.93 ? 0.35 : 0;
    b.ears[0].rotation.z = 0.15 - (alert ? 0.12 : 0) + twitch * (eating ? 1 : 0); b.ears[1].rotation.z = -0.15 + (alert ? 0.12 : 0);
  }
}

// ---------- crows: perch on dead trees, fly off when you come close, glide back later ----------
const crows = [];
const CROW_SCARE_R = 3.4;
function makeCrow() {
  const g = new THREE.Group(), feather = mat(0x3a3450, { emissive: 0x5a4a90, emissiveIntensity: 0.9 }), beakM = mat(0x8a8494);
  const red = new THREE.MeshBasicMaterial({ color: 0xff3030 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 5), feather); body.scale.set(0.9, 0.85, 1.5); body.position.y = 0.18; g.add(body);
  const head = new THREE.Group(); head.position.set(0, 0.3, 0.2); g.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 5), feather));
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.2, 4), beakM); beak.rotation.x = Math.PI / 2; beak.position.set(0, -0.01, 0.15); head.add(beak);
  box(0.03, 0.03, 0.02, red, -0.055, 0.03, 0.08, head); box(0.03, 0.03, 0.02, red, 0.055, 0.03, 0.08, head);
  const tail = box(0.14, 0.03, 0.3, feather, 0, 0.14, -0.34, g); tail.rotation.x = 0.25;
  const wings = [];
  for (const sx of [-1, 1]) {
    const w = new THREE.Group(); w.position.set(sx * 0.12, 0.22, 0.02); g.add(w);
    box(0.5, 0.03, 0.26, feather, sx * 0.25, 0, 0, w); wings.push(w);
  }
  g.scale.setScalar(1.5); // chunky enough to read from the top-down camera
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { g, head, wings };
}
function crowPose(c, a) { c.wings[0].rotation.z = -a; c.wings[1].rotation.z = a; } // a>0 raises the wing tips
function crowTreeTop(tr) { return { x: tr.position.x, y: tr.position.y + tr.userData.topY + 0.1, z: tr.position.z }; }
function freeTree(minPlayerDist) {
  const taken = new Set(crows.map(c => c.tree));
  const pool = treeObjs.filter(t => t.visible && !taken.has(t) && Math.hypot(t.position.x - pPos.x, t.position.z - pPos.y) > minPlayerDist && Math.hypot(t.position.x, t.position.z) > 6);
  return pool.length ? pool[Math.floor(rnd() * pool.length)] : null;
}
function perchCrow(c, tr) {
  c.tree = tr; const p = crowTreeTop(tr); c.x = p.x; c.y = p.y; c.z = p.z; c.state = 'perch'; c.t = 0; c.g.visible = true;
}
for (let i = 0; i < 8; i++) {
  const tr = freeTree(0); if (!tr) break;
  const k = makeCrow();
  const c = Object.assign(k, { tree: null, x: 0, y: 0, z: 0, state: 'perch', t: 0, face: rnd() * 6.28, ph: rnd() * 6, gone: 0, cawT: rr(8, 25) });
  perchCrow(c, tr); c.g.position.set(c.x, c.y, c.z); c.g.rotation.y = c.face; scene.add(c.g); crows.push(c);
}
function updateCrows(dt, t) {
  if (world !== 'outside') return;
  for (const c of crows) {
    const px = pPos.x - c.x, pz = pPos.y - c.z, pd = Math.hypot(px, pz), g = c.g;
    c.t += dt;
    if (c.state === 'perch') {
      const scared = pd < CROW_SCARE_R || (spell.t >= 0 && Math.hypot(c.x - spell.x, c.z - spell.z) < 8) || (combat.atkT > 0 && pd < 5);
      if (scared) { // burst into flight, away from the threat
        const d = pd || 1, a = Math.atan2(-pz, -px) + rr(-0.5, 0.5);
        c.state = 'flee'; c.t = 0; c.vx = Math.cos(a) * 6.5; c.vz = Math.sin(a) * 6.5; c.tree = null; c.face = Math.atan2(c.vx, c.vz);
        spawnFx(c.x, c.y + 0.2, c.z, 0x2a2040, 6); if (pd < 22) sfx.caw(0.12 * (1 - pd / 22));
      } else {
        c.cawT -= dt; if (c.cawT <= 0) { c.cawT = rr(12, 30); if (pd < 22) sfx.caw(0.09 * (1 - pd / 22)); }
        if (pd < 11) c.face = Math.atan2(px, pz); else c.face += Math.sin(t * 0.3 + c.ph) * dt * 0.4; // watch the player
        crowPose(c, -1.35 + Math.sin(t * 1.2 + c.ph) * 0.03);
        g.rotation.x += (-0.55 - g.rotation.x) * Math.min(1, dt * 10);
        c.head.rotation.y = Math.sin(t * 0.7 + c.ph) * 0.5 * (pd < 11 ? 0.3 : 1); c.head.rotation.x = Math.sin(t * 0.5 + c.ph * 2) > 0.8 ? 0.3 : 0;
      }
    } else if (c.state === 'flee') {
      const lat = Math.sin(c.t * 2.2 + c.ph) * 1.3;
      c.x += c.vx * dt - c.vz * 0.15 * lat * dt; c.z += c.vz * dt + c.vx * 0.15 * lat * dt;
      c.y += (c.t < 0.7 ? 4 : 2.4) * dt;
      c.face = Math.atan2(c.vx, c.vz) + lat * 0.08;
      crowPose(c, 0.15 + Math.sin(t * 28 + c.ph) * 0.95);
      g.rotation.x += (0.35 - g.rotation.x) * Math.min(1, dt * 6); c.head.rotation.set(0, 0, 0);
      if (c.t > 5.5 || Math.hypot(c.x, c.z) > WALK_R + 16) { c.state = 'gone'; c.gone = rr(25, 50); g.visible = false; }
    } else if (c.state === 'gone') {
      c.gone -= dt;
      if (c.gone <= 0) {
        const tr = freeTree(14);
        if (tr) { // come back in from a random direction and glide onto the tree
          const p = crowTreeTop(tr), a = rnd() * Math.PI * 2;
          c.tree = tr; c.sx = p.x + Math.cos(a) * 22; c.sz = p.z + Math.sin(a) * 22; c.sy = p.y + 10; c.px = p.x; c.py = p.y; c.pz = p.z;
          c.state = 'land'; c.t = 0; c.dur = 3.4; c.x = c.sx; c.y = c.sy; c.z = c.sz; g.visible = true;
        } else c.gone = 5;
      }
    } else if (c.state === 'land') {
      const u = Math.min(1, c.t / c.dur), e = u * u * (3 - 2 * u), nx = c.sx + (c.px - c.sx) * e, nz = c.sz + (c.pz - c.sz) * e;
      c.face = Math.atan2(nx - c.x, nz - c.z) || c.face; c.x = nx; c.z = nz; c.y = c.sy + (c.py - c.sy) * e;
      crowPose(c, u < 0.78 ? 0.25 + Math.sin(t * 6 + c.ph) * 0.2 : 0.2 + Math.sin(t * 26 + c.ph) * 0.95); // glide, then flare with fast wingbeats
      g.rotation.x += ((u < 0.78 ? 0.2 : -0.5) - g.rotation.x) * Math.min(1, dt * 6);
      if (u >= 1) perchCrow(c, c.tree);
    }
    g.position.set(c.x, c.y, c.z);
    g.rotation.y += Math.atan2(Math.sin(c.face - g.rotation.y), Math.cos(c.face - g.rotation.y)) * Math.min(1, dt * 8);
  }
}

// ---------- audio: procedural music + sound effects (Web Audio, no asset files) ----------
const audio = { ctx: null, muted: false, mood: '', chordIdx: 0, t: { chord: 0, bell: 3, crackle: 0, chime: 2 } };
try { audio.muted = localStorage.getItem('spookie-muted') === '1'; } catch (e) { /* storage unavailable */ }
const soundBtn = $('sound');
function renderSoundBtn() { soundBtn.classList.toggle('muted', audio.muted); soundBtn.title = audio.muted ? 'Sound off (M)' : 'Sound on (M)'; }
renderSoundBtn();
function setMuted(m) {
  audio.muted = m;
  try { localStorage.setItem('spookie-muted', m ? '1' : '0'); } catch (e) { /* ignore */ }
  if (audio.master) audio.master.gain.setTargetAtTime(m ? 0 : 0.6, audio.ctx.currentTime, 0.05);
  renderSoundBtn();
}
soundBtn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); initAudio(); setMuted(!audio.muted); });

const MOODS = {
  out:    { chords: [[110, 130.81, 164.81], [87.31, 130.81, 174.61], [130.81, 164.81, 196], [82.41, 123.47, 164.81]], bells: [440, 523.25, 587.33, 659.25, 783.99, 880, 466.16] },
  hollow: { chords: [[110, 116.54, 164.81], [98, 146.83, 155.56], [110, 138.59, 185]], bells: [440, 466.16, 622.25, 659.25, 830.61, 311.13] },
  house:  { chords: [[110, 138.59, 164.81], [146.83, 185, 220], [164.81, 207.65, 246.94], [110, 164.81, 220]], bells: [440, 554.37, 659.25, 739.99, 880, 987.77, 220] },
};

function initAudio() {
  if (audio.ctx) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  let ctx; // 'playback' = bigger audio buffer: far fewer crackles/dropouts on phones that are busy drawing 3D
  try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return; } }
  audio.ctx = ctx;
  const master = ctx.createGain(); master.gain.value = audio.muted ? 0 : 0.6; master.connect(ctx.destination); audio.master = master;
  const comp = ctx.createDynamicsCompressor(); comp.connect(master);
  // reverb: four feedback delay lines (cheap) smeared by two all-pass filters
  const rev = ctx.createGain(), revMix = ctx.createGain(); revMix.gain.value = 0.07;
  for (const [dt, fb] of [[0.043, 0.74], [0.057, 0.72], [0.071, 0.7], [0.089, 0.68]]) {
    const dl = ctx.createDelay(0.2); dl.delayTime.value = dt;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    const fg = ctx.createGain(); fg.gain.value = fb;
    rev.connect(dl); dl.connect(lp); lp.connect(fg); fg.connect(dl); dl.connect(revMix);
  }
  let tail = revMix;
  for (const f of [700, 1900]) { const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.frequency.value = f; tail.connect(ap); tail = ap; }
  tail.connect(comp);
  // shared noise buffer
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  audio.noise = nb;
  audio.sfx = ctx.createGain(); audio.sfx.gain.value = 0.9; audio.sfx.connect(comp);
  audio.jb = ctx.createGain(); audio.jb.gain.value = 0.9; audio.jb.connect(comp); audio.jb.connect(rev); // jingle bus
  const L = audio.L = {};
  const mk = () => { const g = ctx.createGain(); g.gain.value = 0; g.connect(comp); return g; };
  // drone: two detuned saws + sub, slowly breathing low-pass
  L.drone = mk();
  const dl = ctx.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 220; dl.connect(L.drone);
  for (const [f, type, v] of [[55, 'sawtooth', 0.5], [55.4, 'sawtooth', 0.5], [27.5, 'sine', 0.9]]) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.value = v * 0.35; o.connect(g); g.connect(dl); o.start();
  }
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07; const lg = ctx.createGain(); lg.gain.value = 90; lfo.connect(lg); lg.connect(dl.frequency); lfo.start();
  // pad: three triangles gliding between chords
  L.pad = mk();
  const pf = ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 900; pf.connect(L.pad);
  audio.padOsc = [0, 1, 2].map(() => { const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 110; const g = ctx.createGain(); g.gain.value = 0.25; o.connect(g); g.connect(pf); o.start(); return o; });
  // tension: throbbing low square + tritone
  L.tension = mk();
  const tf = ctx.createBiquadFilter(); tf.type = 'lowpass'; tf.frequency.value = 300; tf.connect(L.tension);
  const pg = ctx.createGain(); pg.gain.value = 0.5; pg.connect(tf);
  const po = ctx.createOscillator(); po.type = 'square'; po.frequency.value = 55; po.connect(pg); po.start();
  const pl = ctx.createOscillator(); pl.frequency.value = 1.3; const plg = ctx.createGain(); plg.gain.value = 0.5; pl.connect(plg); plg.connect(pg.gain); pl.start();
  for (const f of [311.13, 440]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; const g = ctx.createGain(); g.gain.value = 0.04; o.connect(g); g.connect(L.tension); o.start(); }
  // wind: just the howl, a narrow resonance drifting slowly up and down, swelling in gusts
  const bn = 8 * ctx.sampleRate, ov = Math.floor(0.6 * ctx.sampleRate), raw = new Float32Array(bn + ov);
  for (let i = 0, last = 0; i < raw.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; raw[i] = last * 3.5; }
  const brown = ctx.createBuffer(1, bn, ctx.sampleRate), bd = brown.getChannelData(0);
  for (let i = 0; i < bn; i++) bd[i] = i < ov ? raw[i] * (i / ov) + raw[bn + i] * (1 - i / ov) : raw[i]; // seamless loop
  L.wind = mk();
  const lfoTo = (hz, depth, param) => { const o = ctx.createOscillator(); o.frequency.value = hz; const g = ctx.createGain(); g.gain.value = depth; o.connect(g); g.connect(param); o.start(); };
  const hs = ctx.createBufferSource(); hs.buffer = brown; hs.loop = true;
  const hf = ctx.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 650; hf.Q.value = 9;
  const hg = ctx.createGain(); hg.gain.value = 1.5;
  lfoTo(0.043, 220, hf.frequency); lfoTo(0.097, 110, hf.frequency);
  lfoTo(0.067, 1.0, hg.gain); lfoTo(0.113, 0.7, hg.gain);
  hs.connect(hf); hf.connect(hg); hg.connect(L.wind); hs.start(0, 3.1);
  // fire bus: a soft continuous roar + hiss; its volume follows distance to the nearest fire
  audio.fireG = ctx.createGain(); audio.fireG.gain.value = 0; audio.fireG.connect(comp);
  const fs = ctx.createBufferSource(); fs.buffer = brown; fs.loop = true;
  const ff = ctx.createBiquadFilter(); ff.type = 'lowpass'; ff.frequency.value = 450;
  const fg = ctx.createGain(); fg.gain.value = 0.55; lfoTo(0.8, 0.18, fg.gain); lfoTo(2.3, 0.1, fg.gain);
  fs.connect(ff); ff.connect(fg); fg.connect(audio.fireG); fs.start(0, 1.7);
  const hs2 = ctx.createBufferSource(); hs2.buffer = nb; hs2.loop = true;
  const hf2 = ctx.createBiquadFilter(); hf2.type = 'bandpass'; hf2.frequency.value = 3200; hf2.Q.value = 0.6;
  const hg2 = ctx.createGain(); hg2.gain.value = 0.05; lfoTo(1.7, 0.025, hg2.gain); lfoTo(3.1, 0.015, hg2.gain);
  hs2.connect(hf2); hf2.connect(hg2); hg2.connect(audio.fireG); hs2.start(0, 0.4);
  // ghost hum: two close sines with vibrato
  L.ghost = mk();
  const gf = ctx.createBiquadFilter(); gf.type = 'lowpass'; gf.frequency.value = 600; gf.connect(L.ghost);
  const gl = ctx.createOscillator(); gl.frequency.value = 5; const glg = ctx.createGain(); glg.gain.value = 4; gl.connect(glg); gl.start();
  for (const f of [196, 198]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; glg.connect(o.frequency); const g = ctx.createGain(); g.gain.value = 0.5; o.connect(g); g.connect(gf); o.start(); }
  // crystal hum: two shimmering sines that fade in as you approach the grove
  L.crystal = mk();
  const cf = ctx.createBiquadFilter(); cf.type = 'lowpass'; cf.frequency.value = 1800; cf.connect(L.crystal);
  const ctrem = ctx.createGain(); ctrem.gain.value = 0.6; ctrem.connect(cf); lfoTo(0.35, 0.3, ctrem.gain);
  for (const f of [659.25, 661, 987.77]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; const g = ctx.createGain(); g.gain.value = 0.33; o.connect(g); g.connect(ctrem); o.start(); }
  // stream: a gentle babble made of two moving noise bands
  L.stream = mk();
  const sns = ctx.createBufferSource(); sns.buffer = nb; sns.loop = true;
  const sb1 = ctx.createBiquadFilter(); sb1.type = 'bandpass'; sb1.frequency.value = 900; sb1.Q.value = 1.1;
  const sb2 = ctx.createBiquadFilter(); sb2.type = 'bandpass'; sb2.frequency.value = 2300; sb2.Q.value = 2;
  const sg2 = ctx.createGain(); sg2.gain.value = 0.35;
  lfoTo(0.6, 350, sb1.frequency); lfoTo(1.1, 700, sb2.frequency); lfoTo(0.35, 0.2, sg2.gain);
  sns.connect(sb1); sb1.connect(L.stream); sns.connect(sb2); sb2.connect(sg2); sg2.connect(L.stream); sns.start(0, 0.9);
  // sawmill: a whining blade with a cutting rhythm (only audible once the mill is running)
  L.saw = mk();
  const swf = ctx.createBiquadFilter(); swf.type = 'lowpass'; swf.frequency.value = 1100; swf.connect(L.saw);
  const swt = ctx.createGain(); swt.gain.value = 0.55; swt.connect(swf); lfoTo(7, 0.35, swt.gain);
  for (const f of [150, 153]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; const g = ctx.createGain(); g.gain.value = 0.4; o.connect(g); g.connect(swt); o.start(); }
  const swn = ctx.createBufferSource(); swn.buffer = nb; swn.loop = true; const swb = ctx.createBiquadFilter(); swb.type = 'bandpass'; swb.frequency.value = 2600; swb.Q.value = 3;
  const swg = ctx.createGain(); swg.gain.value = 0.2; swn.connect(swb); swb.connect(swg); swg.connect(L.saw); swn.start(0, 1.3);
  // music-box bells bus
  L.bell = mk(); L.bell.connect(rev);
  audio.mood = ''; audio.t.chord = 0;
  document.addEventListener('visibilitychange', () => { if (!audio.ctx) return; if (document.hidden) audio.ctx.suspend(); else audio.ctx.resume(); });
}
['pointerdown', 'keydown'].forEach(ev => addEventListener(ev, initAudio, { passive: true }));

// --- sound building blocks ---
function tone(f, dur, type = 'sine', vol = 0.2, f2 = null, delay = 0, dest = null) {
  const ctx = audio.ctx, t0 = ctx.currentTime + delay;
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(dest || audio.sfx); o.start(t0); o.stop(t0 + dur + 0.05);
}
function noise(dur, type, f1, f2, vol, delay = 0, q = 1, dest = null) {
  const ctx = audio.ctx, t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource(); src.buffer = audio.noise;
  const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f1, t0); fl.Q.value = q;
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.01, dur / 3)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(fl); fl.connect(g); g.connect(dest || audio.sfx); src.start(t0, Math.random() * 1.5, dur + 0.05);
}
function bell(f, vol = 0.2, delay = 0, bus = null) {
  const ctx = audio.ctx, t0 = ctx.currentTime + delay, out = bus || audio.L.bell;
  for (const [m, a, d] of [[1, 1, 2.4], [2.01, 0.35, 1.4], [3.0, 0.12, 0.8]]) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * m;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol * a, t0 + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + d + 0.05);
  }
}
const sfxImpl = {
  step(w) {
    if (w === 'house') { tone(95, 0.08, 'sine', 0.08, 60); noise(0.05, 'bandpass', 300, null, 0.05); }
    else noise(0.07, 'lowpass', 500 + Math.random() * 200, 250, 0.06);
  },
  swing() { noise(0.18, 'bandpass', 800, 2600, 0.22, 0, 1.5); },
  caw(v = 0.1) { for (const [d, f] of [[0, 520], [0.24, 450]]) { tone(f, 0.17, 'sawtooth', v, f * 0.62, d); noise(0.16, 'bandpass', 1300, 700, v * 0.9, d, 3); } },
  cluck(v = 0.08) { tone(720, 0.05, 'square', v, 520); tone(640, 0.07, 'square', v * 0.9, 420, 0.07); noise(0.05, 'bandpass', 1500, 900, v * 0.5, 0, 2); },
  creak(v = 0.08) { tone(70, 0.7, 'sawtooth', v, 120); tone(105, 0.6, 'sawtooth', v * 0.6, 170, 0.1); noise(0.6, 'bandpass', 260, 520, v * 0.9, 0, 5); },
  glint() { [1318.5, 1760, 2093].forEach((f, i) => bell(f, 0.12, i * 0.08, audio.jb)); },
  chop() { noise(0.08, 'lowpass', 1400, null, 0.25); tone(220, 0.08, 'square', 0.1, 110); },
  fell() { tone(90, 0.5, 'sine', 0.25, 40); noise(0.5, 'bandpass', 500, 150, 0.2); },
  lever() { tone(120, 0.12, 'square', 0.2, 70); tone(80, 0.2, 'sawtooth', 0.15, 50, 0.1); },
  craft() { tone(880, 0.08, 'triangle', 0.2); tone(1318.5, 0.15, 'triangle', 0.18, null, 0.08); noise(0.04, 'highpass', 4000, null, 0.1); },
  chip() { tone(1800, 0.06, 'triangle', 0.15, 1200); noise(0.05, 'highpass', 4500, null, 0.14); },
  hop(v = 0.06) { tone(150, 0.07, 'sine', v, 80); noise(0.04, 'lowpass', 500, null, v * 0.6); },
  hit() { noise(0.1, 'lowpass', 1600, null, 0.28); tone(150, 0.12, 'square', 0.16, 60); },
  skelDie() { for (let i = 0; i < 6; i++) noise(0.04, 'highpass', 1800 + Math.random() * 1500, null, 0.18, i * 0.045); tone(90, 0.3, 'sine', 0.2, 45, 0.05); },
  hurt() { tone(190, 0.3, 'sawtooth', 0.28, 70); noise(0.2, 'lowpass', 500, null, 0.25); },
  rattle() { for (let i = 0; i < 6; i++) noise(0.03, 'highpass', 2200, null, 0.1, i * 0.07); },
  skelSwing() { noise(0.15, 'bandpass', 600, 1800, 0.14, 0, 1.2); },
  nova() {
    tone(300, 0.75, 'sine', 0.22, 1900); tone(450, 0.75, 'triangle', 0.1, 2400);
    noise(0.7, 'highpass', 600, 5000, 0.14);
    for (const [f, d] of [[880, 0.05], [1318.5, 0.12], [1760, 0.2]]) bell(f, 0.14, d, audio.jb);
  },
  soul() { [659.25, 880, 1318.5].forEach((f, i) => bell(f, 0.2, i * 0.09, audio.jb)); },
  ore() { tone(1400, 0.18, 'triangle', 0.18); tone(2100, 0.14, 'triangle', 0.1, null, 0.07); noise(0.04, 'highpass', 4000, null, 0.1); },
  heart() { tone(520, 0.12, 'sine', 0.18, 660); tone(780, 0.2, 'sine', 0.18, 980, 0.1); },
  questStart() { [440, 523.25, 659.25].forEach((f, i) => bell(f, 0.22, i * 0.14, audio.jb)); },
  questDone() { [659.25, 880, 1046.5, 1318.5].forEach((f, i) => bell(f, 0.24, i * 0.13, audio.jb)); tone(110, 1.2, 'triangle', 0.14, null, 0.1); },
  door() { tone(80, 0.5, 'sawtooth', 0.1, 150); noise(0.45, 'bandpass', 250, 500, 0.08, 0, 4); tone(70, 0.12, 'sine', 0.2, 45, 0.45); },
  clang() { for (const [f, v] of [[700, 0.12], [1130, 0.1], [1800, 0.07], [2900, 0.05]]) tone(f, 0.45, 'sine', v); noise(0.03, 'highpass', 3000, null, 0.12); },
  blip(npc) { const base = npc === smith.group ? 105 : npc ? 170 : 140; tone(base * (0.9 + Math.random() * 0.4), 0.05, 'square', 0.045); },
  chill() { noise(0.6, 'lowpass', 1200, 200, 0.14); tone(600, 0.5, 'sine', 0.09, 200); },
  defeat() { [330, 247, 185, 139].forEach((f, i) => tone(f, 0.5, 'triangle', 0.18, null, i * 0.2)); },
  horn() { tone(73, 1.4, 'sawtooth', 0.14, 69); tone(110, 1.4, 'sawtooth', 0.07, 104); },
};
const sfx = {};
for (const k of Object.keys(sfxImpl)) sfx[k] = (...a) => { if (audio.ctx && !audio.muted && audio.ctx.state === 'running') { try { sfxImpl[k](...a); } catch (e) { /* never break the game over audio */ } } };
function sfxForToast(m) { // play a matching sound for a toast message
  if (m.startsWith('Quest started')) sfx.questStart();
  else if (m.startsWith('Quest complete')) sfx.questDone();
  else if (m.startsWith('Soul collected') || m.startsWith('All souls')) sfx.soul();
  else if (m.startsWith('Iron ore') || m.startsWith('All ore')) sfx.ore();
  else if (m === '+1 heart') sfx.heart();
  else if (m.startsWith('A cold chill')) sfx.chill();
  else if (m.startsWith('You were defeated')) sfx.defeat();
  else if (m.startsWith('The Blighted')) sfx.horn();
  else if (m.startsWith('The Crystal')) sfx.glint();
}

function crackle() { // wood snaps and pops: uneven loudness, sometimes in quick bursts
  const n = Math.random() < 0.3 ? 2 + Math.floor(Math.random() * 3) : 1;
  for (let i = 0; i < n; i++) {
    const loud = Math.pow(Math.random(), 2.5), d = i * (0.02 + Math.random() * 0.04);
    noise(0.012 + Math.random() * 0.03, 'bandpass', 1500 + Math.random() * 4500, null, 0.04 + loud * 0.35, d, 1 + Math.random() * 2, audio.fireG);
    if (Math.random() < 0.18) tone(180 + Math.random() * 260, 0.04, 'sine', 0.04 + loud * 0.2, 90, d, audio.fireG);
  }
}

function updateAudio(dt) {
  const ctx = audio.ctx;
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime, L = audio.L, out = world === 'outside', house = world === 'house', inH = out && combat.inside;
  const mood = house ? 'house' : inH ? 'hollow' : 'out';
  let chasing = 0;
  if (out) for (const e of enemies) if (e.state === 'chase' || e.state === 'windup') chasing++;
  const set = (g, v, tc = 0.8) => { // skip no-op updates: calling this every frame floods the audio thread with events
    if (g._v !== undefined && (Math.abs(g._v - v) < 0.005 || now - g._at < 0.1)) return;
    g._v = v; g._at = now; g.gain.setTargetAtTime(v, now, tc);
  };
  set(L.drone, house ? 0.2 : inH ? 0.5 : 0.36);
  set(L.pad, house ? 0.16 : inH ? 0.05 : 0.13);
  set(L.bell, house ? 0.5 : inH ? 0.2 : 0.42);
  set(L.tension, inH ? Math.min(0.7, 0.3 + chasing * 0.1) : 0, 0.6);
  set(L.wind, house ? 0.04 : inH ? 0.3 : 0.4);
  let gd = 99; if (out) for (const g of ghosts) gd = Math.min(gd, Math.hypot(g.position.x - pPos.x, g.position.z - pPos.y));
  set(L.ghost, out ? Math.max(0, 1 - gd / 9) * 0.12 : 0, 0.3);
  const snr = out ? streamNearest(pPos.x, pPos.y) : null, sdist = snr ? snr.d - 2.5 : 99;
  set(L.stream, Math.pow(Math.max(0, 1 - sdist / 14), 1.5) * 0.13, 0.3);
  const dsw = out ? Math.hypot(SAWMILL.x - pPos.x, SAWMILL.z - pPos.y) : 99;
  set(L.saw, SAW.state === 'done' ? Math.pow(Math.max(0, 1 - dsw / 24), 1.5) * 0.1 : 0, 0.3);
  const dgr = out ? Math.hypot(GROVE.x - pPos.x, GROVE.z - pPos.y) : 99;
  set(L.crystal, Math.pow(Math.max(0, 1 - dgr / 22), 1.5) * 0.08, 0.4);
  if (dgr < 16) { // glassy chimes that get louder the closer you are
    audio.t.chime -= dt;
    if (audio.t.chime <= 0) { audio.t.chime = 2.5 + Math.random() * 3; bell([1046.5, 1318.5, 1568, 1760, 2093][Math.floor(Math.random() * 5)], 0.03 + 0.12 * (1 - dgr / 16), 0, audio.jb); }
  }
  if (mood !== audio.mood) { audio.mood = mood; audio.t.chord = 0; audio.t.bell = 1.2; }
  const M_ = MOODS[mood];
  audio.t.chord -= dt;
  if (audio.t.chord <= 0) {
    audio.t.chord = 11; audio.chordIdx = (audio.chordIdx + 1) % M_.chords.length;
    audio.padOsc.forEach((o, i) => o.frequency.setTargetAtTime(M_.chords[audio.chordIdx][i], now, 1.8));
  }
  audio.t.bell -= dt;
  if (audio.t.bell <= 0) {
    audio.t.bell = (house ? 3 : 2.2) + Math.random() * 3.5;
    const f = M_.bells[Math.floor(Math.random() * M_.bells.length)];
    bell(f, 0.2); if (Math.random() < 0.35) bell(M_.bells[Math.floor(Math.random() * M_.bells.length)], 0.15, 0.35);
  }
  // fire: volume follows distance, but the crackle rate stays constant
  let cv = 0;
  if (house) cv = 0.6;
  else if (out) {
    const d1 = Math.hypot(FIRE.x - pPos.x, FIRE.z - pPos.y), d2 = Math.hypot(HOLLOW.x - pPos.x, HOLLOW.z - pPos.y);
    cv = Math.max(Math.pow(Math.max(0, 1 - d1 / 16), 2) * 0.9, Math.pow(Math.max(0, 1 - d2 / 12), 2) * 0.5);
  }
  set(audio.fireG, cv, 0.25);
  if (cv > 0.03) {
    audio.t.crackle -= dt;
    if (audio.t.crackle <= 0) { crackle(); audio.t.crackle = -Math.log(1 - Math.random()) * 0.11 + 0.02; }
  }
}


// ---------- light pooling ----------
// Every real point light costs work for every lit pixel on screen, near or far. So only a small pool of real lights exists:
// it is moved onto whichever light sources are closest to the player. The original lights stay in the scene, hidden, and keep
// flickering and moving; the pool copies their position, colour and brightness, fading lights in and out so nothing pops.
const LIGHT_POOL = 10;
const lightSrc = [], lightPool = [];
function initLightPool() {
  scene.updateMatrixWorld(true);
  scene.traverse(o => { if (o.isPointLight && o !== lantern && o !== novaLight) { lightSrc.push(o); o.visible = false; } });
  for (let i = 0; i < LIGHT_POOL; i++) { const l = new THREE.PointLight(0xffffff, 0, 10, 1.5); l.userData = { src: null, fade: 0 }; scene.add(l); lightPool.push(l); }
}
function updateLightPool(dt) {
  if (world !== 'outside') return;
  const px = pPos.x, pz = pPos.y, cand = [];
  for (const s of lightSrc) {
    const e = s.matrixWorld.elements, d = Math.hypot(e[12] - px, e[14] - pz), range = s.distance || 10;
    if (d < range * 1.6 + 6) cand.push([s, d / Math.max(4, range)]); // bigger lights matter from farther away
  }
  cand.sort((a, b) => a[1] - b[1]);
  const want = new Set(cand.slice(0, LIGHT_POOL).map(c => c[0])), have = new Set();
  for (const l of lightPool) {
    const u = l.userData;
    if (u.src && !want.has(u.src)) { u.fade -= dt * 4; if (u.fade <= 0) { u.src = null; u.fade = 0; } } // no longer among the closest: fade out
    else if (u.src) have.add(u.src);
  }
  for (const l of lightPool) {
    const u = l.userData;
    if (!u.src) for (const s of want) if (!have.has(s)) { u.src = s; u.fade = 0; have.add(s); break; } // free light: take a new source
  }
  for (const l of lightPool) {
    const u = l.userData, s = u.src;
    if (!s) { l.intensity = 0; continue; }
    if (want.has(s)) u.fade = Math.min(1, u.fade + dt * 4);
    const e = s.matrixWorld.elements;
    l.position.set(e[12], e[13], e[14]); l.color.copy(s.color); l.distance = s.distance; l.decay = s.decay; l.intensity = s.intensity * u.fade;
  }
}
initLightPool();

// ---------- start menu ----------
const menuEl = $('menu');
let menuOpen = !window.__skipMenu; // tests can skip the menu with window.__skipMenu = true
const hintEl = $('hint');
if (menuOpen) { crafting = true; hintEl.style.opacity = 0; } else menuEl.style.display = 'none'; // the control hint appears when the game starts
function startGame() {
  if (!menuOpen || menuEl.classList.contains('leaving')) return;
  initAudio(); menuEl.classList.add('leaving'); fadeEl.classList.add('on');
  setTimeout(() => { menuOpen = false; crafting = false; menuEl.classList.add('gone'); fadeEl.classList.remove('on'); hintEl.style.opacity = ''; }, 350);
}
$('newgame').addEventListener('click', startGame);

window.__spookie = { swordGlow, swordIntensity: () => swordBladeMat.emissiveIntensity, startGame, menuState: () => ({ menuOpen, crafting }), colliders, SQ, BR, BRIDGE, bridge, groundY, startBuild, setSawmillRunning, inv, SAW, nodes, addItem, openCrafting, closeCrafting, setFacing: a => { facing = a; }, SAWMILL, sawyer, sawmill, streamNearest, streamPush, isCutOff, STREAM_HW, STREAM_PTS, renderer, camera, scene, lightPool, lightSrc, GROVE, grove, NIGHT, raiders, damageEnemy, startVigil, vigilFail, setWheatHealth, farmer, farm, FARM, PEN, FIELD, MILL, crows, treeObjs, bunnies, updateAudio, sfx, audio, castSpell, spell, enemies, combat, attack, hurtPlayer, HOLLOW, GATE, ghosts, get slowT() { return slowT; }, pPos, QUEST, SQ, ores, souls, interact, HOUSE, switchWorld, get world() { return world; } }; // debug/test hook

// ---------- loop ----------
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = innerWidth < innerHeight ? 62 : 50; // wider view in portrait (phones)
  camera.updateProjectionMatrix();
});
dispatchEvent(new Event('resize'));

const clock = new THREE.Clock();
const SPEED = 6;
const GHOST_SLOW = 0.4, GHOST_SLOW_TIME = 2, GHOST_HIT_R = 0.9; // walking through a ghost slows you for 2s
let slowT = 0, lastStep = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;

  // movement (screen-up = world -z)
  if (world === 'outside') for (const g of ghosts) {
    if (Math.hypot(g.position.x - pPos.x, g.position.z - pPos.y) < GHOST_HIT_R) {
      if (slowT <= 0) toast('A cold chill... you are slowed!');
      slowT = GHOST_SLOW_TIME;
    }
  }
  const slowed = slowT > 0;
  if (slowed) slowT -= dt;
  M.cloak.emissive.setHex(slowed ? 0x3a6bff : 0x000000); M.cloak.emissiveIntensity = slowed ? 0.7 : 0;
  const speed = SPEED * (slowed ? GHOST_SLOW : 1);
  const [ix, iy] = readInput(), mag = Math.hypot(ix, iy);
  if (mag > 0) {
    pPos.x += ix * speed * dt;
    pPos.y += iy * speed * dt;
    const target = Math.atan2(ix, iy);
    let d = target - facing; d = Math.atan2(Math.sin(d), Math.cos(d));
    facing += d * Math.min(1, dt * 14);
    walkT += dt * 11 * mag * (slowed ? GHOST_SLOW : 1);
    const stepIdx = Math.floor(walkT / Math.PI);
    if (stepIdx !== lastStep) { lastStep = stepIdx; sfx.step(world); }
  }
  // collisions
  for (const c of world === 'house' ? houseColliders : colliders) {
    if (c.hw) { // box collider: push out from the nearest point on the box
      const nx = Math.min(c.x + c.hw, Math.max(c.x - c.hw, pPos.x)), nz = Math.min(c.z + c.hd, Math.max(c.z - c.hd, pPos.y));
      const dx = pPos.x - nx, dz = pPos.y - nz, dist = Math.hypot(dx, dz);
      if (dist < 0.35 && dist > 0.0001) { pPos.x = nx + dx / dist * 0.35; pPos.y = nz + dz / dist * 0.35; }
      else if (dist <= 0.0001) { // inside the box: exit through the closest side
        const ox = c.hw - Math.abs(pPos.x - c.x), oz = c.hd - Math.abs(pPos.y - c.z);
        if (ox < oz) pPos.x = c.x + Math.sign(pPos.x - c.x || 1) * (c.hw + 0.35); else pPos.y = c.z + Math.sign(pPos.y - c.z || 1) * (c.hd + 0.35);
      }
      continue;
    }
    const dx = pPos.x - c.x, dz = pPos.y - c.z, min = c.r + 0.35, dist = Math.hypot(dx, dz);
    if (dist < min && dist > 0.0001) { pPos.x = c.x + dx / dist * min; pPos.y = c.z + dz / dist * min; }
  }
  if (world === 'outside') { const q = streamPush(pPos.x, pPos.y, 0.38); pPos.x = q[0]; pPos.y = q[1]; } // the water is solid
  if (world === 'house') {
    pPos.x = Math.min(HOUSE_BOUNDS.x1, Math.max(HOUSE_BOUNDS.x0, pPos.x));
    pPos.y = Math.min(HOUSE_BOUNDS.z1, Math.max(HOUSE_BOUNDS.z0, pPos.y));
  } else {
    const r = pPos.length();
    if (r > WALK_R) pPos.multiplyScalar(WALK_R / r);
  }

  const gy = world === 'house' ? 0 : groundY(pPos.x, pPos.y);
  player.position.set(pPos.x, gy, pPos.y);
  body.rotation.y = facing;
  body.position.y = Math.abs(Math.sin(walkT)) * 0.12 * (mag > 0 ? 1 : 0);
  body.rotation.z = Math.sin(walkT) * 0.07 * (mag > 0 ? 1 : 0);

  // flicker
  for (const l of flickers) l.intensity = l.userData.base * (0.85 + Math.sin(t * 11 + l.id) * 0.07 + Math.sin(t * 23 + l.id * 3) * 0.06);

  // fire animation
  for (const f of flames) {
    const u = f.userData, k = fireBoost * (1 +Math.sin(t * 9 + u.ph) * 0.12 + Math.sin(t * 17 + u.ph) * 0.08);
    f.scale.set(1 + Math.sin(t * 7 + u.ph) * 0.08, k, 1 + Math.cos(t * 8 + u.ph) * 0.08);
    f.rotation.y = t * (1 + u.i);
  }
  for (const e of embers) {
    const u = e.userData; u.t += dt * u.sp;
    if (u.t > 2.5) { u.t = 0; u.a = rnd() * 6.28; }
    e.position.set(Math.cos(u.a + u.t) * (u.r + u.t * 0.15), 0.5 + u.t * 1.1, Math.sin(u.a + u.t) * (u.r + u.t * 0.15));
    e.scale.setScalar(Math.max(0.1, 1 - u.t / 2.5));
  }
  for (const p of sitters) p.children[3].rotation.z = Math.sin(t * 0.8 + p.userData.ph) * 0.05;

  // ghosts + wisps
  for (const g of ghosts) {
    const u = g.userData, a = t * u.sp + u.ph;
    g.position.set(u.cx + Math.cos(a) * u.r, 0.5 + heightAt(u.cx, u.cz) + Math.sin(t * 1.6 + u.ph) * 0.25, u.cz + Math.sin(a) * u.r);
    g.rotation.y = -a;
  }
  for (const w of wisps) {
    const u = w.userData;
    w.position.set(u.x + Math.sin(t * u.sp + u.ph) * 0.8, heightAt(u.x, u.z) + u.y + Math.sin(t * 1.3 + u.ph) * 0.3, u.z + Math.cos(t * u.sp * 0.8 + u.ph) * 0.8);
    w.rotation.y = t;
  }

  updateQuests(dt, t);
  updateHouse(dt, t);
  updateCombat(dt, t);
  updateBunnies(dt, t);
  updateCrows(dt, t);
  updateFarm(dt, t);
  updateVigil(dt);
  updateGrove(dt, t);
  updateStream(dt, t);
  updateSawmill(dt, t);
  updateNodes(dt);
  updateBridge(dt);
  updateLightPool(dt);
  updateSpell(dt, t);
  updateAudio(dt);

  // follow camera
  camTarget.set(player.position.x, player.position.y, player.position.z);
  const want = camWant.copy(camTarget).add(CAM_OFFSET);
  camera.position.lerp(want, 1 - Math.exp(-dt * 6));
  camera.lookAt(camera.position.x - CAM_OFFSET.x, camTarget.y, camera.position.z - CAM_OFFSET.z);

  // keep moon shadow centered on player
  moon.position.set(player.position.x - 14, 22, player.position.z - 10);
  moon.target.position.copy(player.position);

  renderer.render(activeScene, camera);
  requestAnimationFrame(tick);
}
tick();
