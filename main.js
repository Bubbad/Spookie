import * as THREE from 'three';

// ---------- helpers ----------
let seed = 1337;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const rr = (a, b) => a + rnd() * (b - a);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const WORLD_R = 30;       // island radius
const WALK_R = 27;        // how far the player can walk

// gentle rolling hills
function heightAt(x, z) {
  const h = Math.sin(x * 0.21) * Math.cos(z * 0.17) * 0.8 + Math.sin(x * 0.07 + z * 0.09) * 0.9;
  return h * smooth(2, 8, Math.hypot(x, z)); // keep spawn flat
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
const colliders = []; // {x, z, r}
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
    if (colliders.every(c => Math.hypot(c.x - x, c.z - z) > c.r + 1.4)) return [x, z];
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
const flames = [], embers = [];
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
  const fl = new THREE.PointLight(0xff7a22, 7, 20, 1.4);
  fl.position.y = 1.3; fl.userData.base = 7;
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
    (globalThis.sitters ||= []).push(p);
  }
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
addEventListener('keydown', e => { keys.add(e.code); hideHint(); });
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
  let x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  let y = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
  if (!x && !y) { x = joy.x; y = joy.y; }
  const l = Math.hypot(x, y);
  if (l > 1) { x /= l; y /= l; }
  else if (l < 0.12) { x = y = 0; }
  return [x, y];
}

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
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;

  // movement (screen-up = world -z)
  const [ix, iy] = readInput(), mag = Math.hypot(ix, iy);
  if (mag > 0) {
    pPos.x += ix * SPEED * dt;
    pPos.y += iy * SPEED * dt;
    const target = Math.atan2(ix, iy);
    let d = target - facing; d = Math.atan2(Math.sin(d), Math.cos(d));
    facing += d * Math.min(1, dt * 14);
    walkT += dt * 11 * mag;
  }
  // collisions
  for (const c of colliders) {
    const dx = pPos.x - c.x, dz = pPos.y - c.z, min = c.r + 0.35, dist = Math.hypot(dx, dz);
    if (dist < min && dist > 0.0001) { pPos.x = c.x + dx / dist * min; pPos.y = c.z + dz / dist * min; }
  }
  const r = pPos.length();
  if (r > WALK_R) pPos.multiplyScalar(WALK_R / r);

  const gy = heightAt(pPos.x, pPos.y);
  player.position.set(pPos.x, gy, pPos.y);
  body.rotation.y = facing;
  body.position.y = Math.abs(Math.sin(walkT)) * 0.12 * (mag > 0 ? 1 : 0);
  body.rotation.z = Math.sin(walkT) * 0.07 * (mag > 0 ? 1 : 0);

  // flicker
  for (const l of flickers) l.intensity = l.userData.base * (0.85 + Math.sin(t * 11 + l.id) * 0.07 + Math.sin(t * 23 + l.id * 3) * 0.06);

  // fire animation
  for (const f of flames) {
    const u = f.userData, k = 1 + Math.sin(t * 9 + u.ph) * 0.12 + Math.sin(t * 17 + u.ph) * 0.08;
    f.scale.set(1 + Math.sin(t * 7 + u.ph) * 0.08, k, 1 + Math.cos(t * 8 + u.ph) * 0.08);
    f.rotation.y = t * (1 + u.i);
  }
  for (const e of embers) {
    const u = e.userData; u.t += dt * u.sp;
    if (u.t > 2.5) { u.t = 0; u.a = rnd() * 6.28; }
    e.position.set(Math.cos(u.a + u.t) * (u.r + u.t * 0.15), 0.5 + u.t * 1.1, Math.sin(u.a + u.t) * (u.r + u.t * 0.15));
    e.scale.setScalar(Math.max(0.1, 1 - u.t / 2.5));
  }
  for (const p of globalThis.sitters || []) p.children[3].rotation.z = Math.sin(t * 0.8 + p.userData.ph) * 0.05;

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

  // follow camera
  camTarget.set(player.position.x, player.position.y, player.position.z);
  const want = camTarget.clone().add(CAM_OFFSET);
  camera.position.lerp(want, 1 - Math.exp(-dt * 6));
  camera.lookAt(camera.position.x - CAM_OFFSET.x, camTarget.y, camera.position.z - CAM_OFFSET.z);

  // keep moon shadow centered on player
  moon.position.set(player.position.x - 14, 22, player.position.z - 10);
  moon.target.position.copy(player.position);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
