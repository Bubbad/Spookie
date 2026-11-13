import * as THREE from 'three';

// ---------- helpers ----------
let seed = 1337;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const rr = (a, b) => a + rnd() * (b - a);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const WORLD_R = 30;       // island radius
const WALK_R = 27;        // how far the player can walk
const HOUSE = { x: -11, z: 10, hw: 3, hd: 2.5 }; // blacksmith house (door faces +z)

// gentle rolling hills
function heightAt(x, z) {
  const h = Math.sin(x * 0.21) * Math.cos(z * 0.17) * 0.8 + Math.sin(x * 0.07 + z * 0.09) * 0.9;
  return h * smooth(2, 8, Math.hypot(x, z)) * smooth(5, 9, Math.hypot(x - HOUSE.x, z - HOUSE.z)); // keep spawn + house flat
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
  const size = WORLD_R * 2 + 4, seg = 44;
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
  const grassA = new THREE.Color(0x2f6b3a), grassB = new THREE.Color(0x3f7f3c), dirt = new THREE.Color(0x3a2c24), c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3, cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    c.copy(grassA).lerp(grassB, rnd()).multiplyScalar(0.7 + rnd() * 0.3);
    if (cy < -0.5 || Math.hypot(cx, cz) > WORLD_R - 1.5) c.copy(dirt).multiplyScalar(0.8 + rnd() * 0.4);
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
const interactables = []; // {world, getPos, r, label, act}
const avoid = [{ x: HOUSE.x, z: HOUSE.z + HOUSE.hd + 3, r: 3.2 }]; // keep props off the porch
const flickers = [];  // lights that flicker
const bobbers = [];   // floating things

function place(obj, x, z, r) {
  obj.position.set(x, heightAt(x, z), z);
  obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(obj);
  if (r) colliders.push({ x, z, r });
}
const spot = (minR = 4, maxR = WORLD_R - 3) => {
  for (;;) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rr(minR * minR, maxR * maxR));
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (colliders.every(c => Math.hypot(c.x - x, c.z - z) > c.r + 1.4) && avoid.every(c => Math.hypot(c.x - x, c.z - z) > c.r)) return [x, z];
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
  transitioning = true; fadeEl.classList.add('on');
  setTimeout(() => {
    world = to;
    if (to === 'house') { outPos.copy(pPos); houseScene.add(player); pPos.set(0, 2.9); facing = Math.PI; activeScene = houseScene; }
    else { scene.add(player); pPos.set(HOUSE.x, HOUSE.z + HOUSE.hd + 1.7); facing = 0; activeScene = scene; }
    camera.position.set(pPos.x + CAM_OFFSET.x, CAM_OFFSET.y, pPos.y + CAM_OFFSET.z);
    fadeEl.classList.remove('on');
    setTimeout(() => { transitioning = false; }, 250);
  }, 260);
}

// graveyard patch near the middle-ish, trees around, pumpkins scattered
for (let i = 0; i < 16; i++) { // tombstones in a cluster
  const a = rnd() * 6.28, d = Math.sqrt(rr(16, 90));
  const x = -9 + Math.cos(a) * d, z = -8 + Math.sin(a) * d;
  if (Math.hypot(x, z) > 5 && Math.hypot(x, z) < WALK_R - 2 && colliders.every(c => Math.hypot(c.x - x, c.z - z) > 1.6))
    place(tombstone(), x, z, 0.6);
}
for (let i = 0; i < 34; i++) { const [x, z] = spot(5, WORLD_R - 2); place(deadTree(), x, z, 0.45); }
for (let i = 0; i < 10; i++) { const [x, z] = spot(4, WALK_R - 1); place(pumpkin(), x, z, 0.5); }

// spiky grass tufts (low-poly cones, instanced)
{
  const geo = new THREE.ConeGeometry(0.09, 0.45, 3);
  geo.translate(0, 0.22, 0);
  const n = 1400, inst = new THREE.InstancedMesh(geo, mat(0x4f9a4a), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.28, d = Math.sqrt(rnd()) * (WORLD_R - 2), x = Math.cos(a) * d, z = Math.sin(a) * d;
    pos.set(x, heightAt(x, z), z);
    q.setFromEuler(new THREE.Euler(rr(-0.2, 0.2), rnd() * 6.28, rr(-0.2, 0.2)));
    s.setScalar(rr(0.7, 1.6));
    inst.setMatrixAt(i, m.compose(pos, q, s));
    inst.setColorAt(i, col.setHSL(rr(0.25, 0.36), 0.45, rr(0.2, 0.34)));
  }
  inst.receiveShadow = true;
  scene.add(inst);
}

// ghosts drifting around
const ghosts = [];
for (let i = 0; i < 4; i++) {
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
  for (let i = 0; i < 45; i++) {
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
const camTarget = new THREE.Vector3();
camera.position.copy(CAM_OFFSET);
camera.lookAt(0, 0, 0);

// ---------- input ----------
const keys = new Set();
addEventListener('keydown', e => {
  keys.add(e.code); hideHint();
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
  if (talking || transitioning) return [0, 0];
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
let talking = false;

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
function toast(msg) { ui.toast.textContent = msg; ui.toast.classList.add('on'); toastT = 3; }
function renderQuestHud() {
  const parts = [];
  if (QUEST.state !== 'none') parts.push(`<b>${QUEST.title}</b><br>` + (QUEST.state === 'active' ? `Find the lost souls <span>${QUEST.found}/${QUEST.need}</span>`
    : QUEST.state === 'ready' ? 'Return to Old Marrow by the fire' : 'Complete'));
  if (SQ.state !== 'none') parts.push(`<b>${SQ.title}</b><br>` + (SQ.state === 'active' ? `Find iron ore <span>${SQ.found}/${SQ.need}</span>`
    : SQ.state === 'ready' ? 'Return to Hob in the smithy' : 'Complete'));
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
  openDialog('Anvil', ['A heavy iron anvil, scarred by a thousand hammer blows.', 'It is still warm. Forging will be available soon.'], null, null);
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
    if (o.world !== world) continue;
    const p = o.getPos(), d = Math.hypot(p.x - pPos.x, p.z - pPos.y);
    if (d < o.r && d < bd) { best = o; bd = d; }
  }
  return best;
}
function interact() {
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
  marker.visible = QUEST.state === 'none' || QUEST.state === 'ready';
  marker.position.y = 2.1 + Math.sin(t * 3) * 0.1; marker.rotation.y = t * 2;
  smithMarker.visible = SQ.state === 'none' || SQ.state === 'ready';
  smithMarker.position.y = 2.3 + Math.sin(t * 3) * 0.1; smithMarker.rotation.y = t * 2;

  // typewriter
  if (talking) {
    const line = lines[lineIdx];
    shown = Math.min(line.length, shown + dt * speed);
    ui.dtext.textContent = line.slice(0, Math.floor(shown));
    ui.dnext.style.visibility = shown >= line.length ? 'visible' : 'hidden';
  }
  for (const n of [npc, smith.group]) {
    let want = n.userData.faceY;
    if (talking && n === talkNpc) want = Math.atan2(pPos.x - n.position.x, pPos.y - n.position.z);
    const d = Math.atan2(Math.sin(want - n.rotation.y), Math.cos(want - n.rotation.y));
    n.rotation.y += d * Math.min(1, dt * (talking && n === talkNpc ? 6 : 4));
  }
  const it = !talking && !transitioning ? currentInteractable() : null;
  ui.talk.classList.toggle('on', !!it);
  if (it) ui.talk.textContent = it.label;

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
  let target = null, bestD = 1e9;
  for (const c of cands) { const d = Math.hypot(c[0] - pPos.x, c[1] - pPos.y); if (d < bestD) { bestD = d; target = c; } }
  if (target && !talking && world === 'outside') {
    const dx = target[0] - player.position.x, dz = target[1] - player.position.z, dist = Math.hypot(dx, dz);
    ui.arrow.style.opacity = dist > 5 ? 0.85 : 0;
    ui.arrow.style.transform = `rotate(${Math.atan2(dx, -dz)}rad) translateY(-95px)`;
  } else ui.arrow.style.opacity = 0;

  if (toastT > 0 && (toastT -= dt) <= 0) ui.toast.classList.remove('on');
}
renderQuestHud();
window.__spookie = { ghosts, get slowT() { return slowT; }, pPos, QUEST, SQ, ores, souls, interact, HOUSE, switchWorld, get world() { return world; } }; // debug/test hook

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
let slowT = 0;
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
  if (world === 'house') {
    pPos.x = Math.min(HOUSE_BOUNDS.x1, Math.max(HOUSE_BOUNDS.x0, pPos.x));
    pPos.y = Math.min(HOUSE_BOUNDS.z1, Math.max(HOUSE_BOUNDS.z0, pPos.y));
  } else {
    const r = pPos.length();
    if (r > WALK_R) pPos.multiplyScalar(WALK_R / r);
  }

  const gy = world === 'house' ? 0 : heightAt(pPos.x, pPos.y);
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

  // follow camera
  camTarget.set(player.position.x, player.position.y, player.position.z);
  const want = camTarget.clone().add(CAM_OFFSET);
  camera.position.lerp(want, 1 - Math.exp(-dt * 6));
  camera.lookAt(camera.position.x - CAM_OFFSET.x, camTarget.y, camera.position.z - CAM_OFFSET.z);

  // keep moon shadow centered on player
  moon.position.set(player.position.x - 14, 22, player.position.z - 10);
  moon.target.position.copy(player.position);

  renderer.render(activeScene, camera);
  requestAnimationFrame(tick);
}
tick();
