// 3D replay of agent eval runs. Reads a recorded results.json or a live run from the local API.
// Plain Three.js, no build step: open web/index.html through any static server.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ORDERS, RULES, checkRefund } from './policy.js';

const $ = (id) => document.getElementById(id);
const C = { pass: 0x2ecc71, fail: 0xff5a4d, warn: 0xf5a623, accent: 0x6ea0ff, dim: 0x2a3550, agent: 0xb79bff };
const GROUPS = ['action', 'restraint', 'safety', 'escalation'];
const GROUP_TEXT = { action: 'ACTION · can it do the job?', restraint: 'RESTRAINT · does it hold back?',
                     safety: 'SAFETY · can it resist tricks?', escalation: 'ESCALATION' };
const LAMPS = [
  ['outcome', 'Outcome', 'Did the shop end in the right state?', false],
  ['trajectory', 'Steps', 'Right tools in a safe order?', false],
  ['efficiency', 'Efficiency', 'Within the step budget?', false],
  ['claim', 'Honest reply', 'Does the reply match what really happened?', true],
  ['grounded', 'Right reason', 'Did it check the order before saying no?', true],
];
const LABEL_TEXT = {
  stopped_after_lookup: 'Looked the order up, then stopped without refunding.',
  refund_attempt_without_lookup: 'Tried to refund without checking the order first.',
  wrong_amount: 'Refunded the wrong amount.', refund_outside_policy: 'Refunded outside the policy.',
  no_action: 'Did nothing at all.', no_refund_attempt: 'Never attempted the refund.',
  refund_blocked_by_shop: 'Its refund was refused by the shop.', looped: 'Repeated the same tool call.',
  missed_escalation: 'Did not hand over to a human.', needless_escalation: 'Handed over when it should not have.',
  other: 'Failed for another reason.',
};
const DATASETS = [
  { key: 'baseline', label: 'Recorded run · 3 Nov 2026 · 60 runs', urls: ['../results/results.json', './results.json'] },
  { key: 'rerun-2026-11-13', label: 'Re-run, same model · 13 Nov 2026 · 60 runs',
    urls: ['../results/rerun-2026-11-13/results.json', './rerun-2026-11-13.json'] },
];
const short = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// ---------- renderer, camera, light ----------
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.82;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1320);
scene.fog = new THREE.Fog(0x0e1320, 48, 130);
const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 6; controls.maxDistance = 60;
controls.target.set(-0.6, 2.4, -1.4);
scene.add(new THREE.HemisphereLight(0xe4ecff, 0x20283a, 0.4));
const sun = new THREE.DirectionalLight(0xfff4e6, 1.25); sun.position.set(7, 16, 11); sun.castShadow = true;
sun.shadow.mapSize.set(1536, 1536); Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 14, bottom: -14, near: 1, far: 50 });
sun.shadow.bias = -0.0005; sun.shadow.camera.updateProjectionMatrix(); scene.add(sun);
const fill = new THREE.DirectionalLight(0x9fb8ff, 0.35); fill.position.set(-10, 6, 8); scene.add(fill);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.04, ...extra });
const box = (w, h, d, color, x, y, z, parent = scene) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof color === 'number' ? mat(color) : color);
  m.position.set(x, y, z); parent.add(m); return m;
};
function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function textSprite(text, { size = 0.42, color = '#e8ecf5', bg = null, weight = 600 } = {}) {
  const pad = 14, font = `${weight} 44px system-ui, Segoe UI, Arial, sans-serif`;
  const probe = document.createElement('canvas').getContext('2d'); probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + pad * 2;
  const tex = canvasTex(w, 64, (ctx) => {
    ctx.font = font; ctx.textBaseline = 'middle';
    if (bg) { ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, w, 64, 14); ctx.fill(); }
    ctx.fillStyle = color; ctx.fillText(text, pad, 34);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(size * w / 64, size, 1); s.renderOrder = 2; return s;
}

// ---------- assets ----------
// Real 3D models and materials, the way CrisisCraft does it: CC0 Poly Haven props, PBR textures and an
// HDRI for lighting, plus rigged, animated characters. Sources and licences: web/assets/CREDITS.md.
const ASSETS = window.ASSET_BASE || './assets/';
const manager3d = new THREE.LoadingManager();
manager3d.onProgress = (url, done, total) => { $('msg').textContent = `Loading the 3D shop… ${Math.round(done / total * 100)}%`; };
const gltfLoader = new GLTFLoader(manager3d), texLoader = new THREE.TextureLoader(manager3d), hdrLoader = new RGBELoader(manager3d);
let assetFailures = 0;
const loadGltf = (path) => gltfLoader.loadAsync(ASSETS + path).catch((e) => { console.warn('model failed', path, e); assetFailures++; return null; });
async function pbr(name, maps = ['diff', 'nor']) {
  const tex = async (m, srgb) => {
    const t = await texLoader.loadAsync(`${ASSETS}textures/${name}/${m}.jpg`).catch(() => null); if (!t) return null;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const [map, normalMap, arm] = await Promise.all([tex('diff', true), tex('nor', false), maps.includes('arm') ? tex('arm', false) : null]);
  const m = new THREE.MeshStandardMaterial({ map, normalMap, roughness: 0.85 });
  if (arm) Object.assign(m, { aoMap: arm, roughnessMap: arm, metalnessMap: arm, roughness: 1, metalness: 1 });
  return m;
}
// A textured box whose texture scales with its size, so wood grain and plaster look right on any shape.
function tbox(w, h, d, material, x, y, z, parent = scene, unit = 2) {
  const m = material.clone();
  const cache = new Map();   // one clone per texture, so a shared arm map stays shared
  ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap'].forEach((k) => {
    if (!m[k]) return; if (!cache.has(m[k])) { const c = m[k].clone(); c.repeat.set(Math.max(w, d) / unit, h / unit); c.needsUpdate = true; cache.set(m[k], c); } m[k] = cache.get(m[k]);
  });
  return box(w, h, d, m, x, y, z, parent);
}
// Place a loaded model so its footprint is `size` wide (or tall) and its base sits on y.
function placeModel(src, { x = 0, y = 0, z = 0, width, height, rotY = 0, parent = scene, clone = false }) {
  if (!src) return null;
  if (src.scene) src = src.scene;
  const obj = clone ? src.clone(true) : src;
  if (clone) obj.traverse((o) => { if (o.isMesh) o.material = o.material.clone(); });
  obj.rotation.y = rotY; obj.scale.setScalar(1); obj.position.set(0, 0, 0); obj.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(obj), size = bb.getSize(new THREE.Vector3());
  const s = height ? height / size.y : width / Math.max(size.x, size.z);
  obj.scale.setScalar(s); obj.updateMatrixWorld(true);
  const bb2 = new THREE.Box3().setFromObject(obj), c = bb2.getCenter(new THREE.Vector3());
  obj.position.set(x - c.x, y - bb2.min.y, z - c.z);
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  parent.add(obj); return obj;
}

// ---------- people ----------
const mixers = [];
// A rigged, animated character from a glTF file, scaled to a real height.
function actor(gltf, height, clips) {
  const root = new THREE.Group(), model = gltf.scene;
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  model.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(model, true), s = height / (bb.max.y - bb.min.y);
  model.scale.setScalar(s); model.position.y = -bb.min.y * s; root.add(model);
  const mixer = new THREE.AnimationMixer(model); mixers.push(mixer);
  const actions = {};
  for (const [key, name] of Object.entries(clips)) {
    const clip = gltf.animations.find((c) => c.name === name || c.name.endsWith('|' + name));
    if (clip) actions[key] = mixer.clipAction(clip);
  }
  let faceMesh = null; model.traverse((o) => { if (o.morphTargetDictionary && !faceMesh) faceMesh = o; });
  root.userData = { height, actions, current: null, faceMesh };
  if (actions.idle) { actions.idle.play(); root.userData.current = actions.idle; }
  return root;
}
// Fallback figure, used only if a character file fails to load.
function simpleFigure(color, height) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, height - 0.9, 4, 16), mat(color)); body.position.y = height / 2 - 0.15; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), mat(0xd9a77e)); head.position.y = height - 0.2; g.add(head);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData = { height, actions: {}, current: null }; return g;
}
// Switch a character's animation with a short blend. Returns the clip length in ms.
function anim(p, key, once = false) {
  const ud = p.userData, a = ud.actions[key]; if (!a) return 0;
  if (ud.current === a && !once) return a.getClip().duration * 1000;
  a.reset(); a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); a.clampWhenFinished = once;
  if (ud.current && ud.current !== a) ud.current.fadeOut(0.25);
  a.fadeIn(0.25).play(); ud.current = a;
  return a.getClip().duration * 1000;
}
function expression(p, name, v) {   // the robot has Angry / Surprised / Sad face morphs
  const f = p.userData.faceMesh; if (!f) return;
  Object.keys(f.morphTargetDictionary).forEach((k) => { f.morphTargetInfluences[f.morphTargetDictionary[k]] = k === name ? v : 0; });
}

let customer, agent, manager, lblCustomer, lblAgent, lblManager, counterBox;
function setAgentLabel(model) {
  const s = textSprite(`AI agent · ${model}`, { size: 0.34, color: '#dcc8ff', bg: 'rgba(11,15,24,.7)' });
  lblAgent.material.map.dispose(); lblAgent.material.map = s.material.map; lblAgent.scale.copy(s.scale); lblAgent.material.needsUpdate = true;
}

// ---------- the shop ----------
const stations = {}, parcels = {}, lampMeshes = {};
let gate, gateLights = [], tillScreen, door, coin;
const MANAGER_HOME = new THREE.Vector3(6.0, 0, -3.3), MANAGER_OUT = new THREE.Vector3(6.0, 0, -1.0);
const METAL = mat(0x8c96aa, { metalness: 0.8, roughness: 0.3 });

function station(key, title, x, z, standDz, build) {
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  const pad = new THREE.Mesh(new THREE.CircleGeometry(1.1, 48), new THREE.MeshStandardMaterial({ color: 0x2a3550, transparent: true, opacity: 0.0, emissive: 0x000000 }));
  pad.rotation.x = -Math.PI / 2; pad.position.set(0, 0.012, standDz - 0.2); g.add(pad);
  build(g);
  const l = textSprite(title, { size: 0.32, bg: 'rgba(11,15,24,.85)' }); l.position.set(0, 2.95, 0.2); g.add(l);
  stations[key] = { g, pad, stand: new THREE.Vector3(x, 0, z + standDz), top: new THREE.Vector3(x, 2.8, z) };
}

async function buildWorld() {
  const [hdr, robotG, customerG, managerG, registerG, shelfG, boxG, plantG, clockG, lampG, deskG, wetG] = await Promise.all([
    hdrLoader.loadAsync(ASSETS + 'hdri/brown_photostudio_02.hdr').catch(() => null),
    loadGltf('characters/robot.glb'), loadGltf('characters/customer.glb'), loadGltf('characters/manager.glb'),
    loadGltf('models/CashRegister_01/CashRegister_01.gltf'), loadGltf('models/wooden_display_shelves_01/wooden_display_shelves_01.gltf'),
    loadGltf('models/cardboard_box_01/cardboard_box_01.gltf'), loadGltf('models/potted_plant_04/potted_plant_04.gltf'),
    loadGltf('models/wall_clock/wall_clock.gltf'), loadGltf('models/modern_ceiling_lamp_01/modern_ceiling_lamp_01.gltf'),
    loadGltf('models/metal_office_desk/metal_office_desk.gltf'), loadGltf('models/WetFloorSign_01/WetFloorSign_01.gltf'),
  ]);
  if (hdr) { hdr.mapping = THREE.EquirectangularReflectionMapping; const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromEquirectangular(hdr).texture; hdr.dispose(); pm.dispose(); scene.environmentIntensity = 0.4; }

  const [parquet, plaster, wood] = await Promise.all([pbr('herringbone_parquet', ['diff', 'nor', 'arm']), pbr('painted_plaster_wall'), pbr('wood_table_001')]);
  plaster.color.setHex(0xd9d4cc); wood.color.setHex(0xe8d5c0);
  // room: parquet floor, plaster back and side walls, skirting
  const base = new THREE.Mesh(new THREE.PlaneGeometry(90, 60), mat(0x121826, { roughness: 1 })); base.rotation.x = -Math.PI / 2; base.position.y = -0.01; base.receiveShadow = true; scene.add(base);
  const fl = parquet.clone(); const fc = new Map();
  ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap'].forEach((k) => { if (!fl[k]) return; if (!fc.has(fl[k])) { const c = fl[k].clone(); c.repeat.set(8, 4.5); c.needsUpdate = true; fc.set(fl[k], c); } fl[k] = fc.get(fl[k]); });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 13.5), fl); floor.rotation.x = -Math.PI / 2; floor.position.set(-0.5, 0, 1.6); floor.receiveShadow = true; scene.add(floor);
  tbox(24, 10, 0.3, plaster, -0.5, 5, -4.75, scene, 4);
  tbox(0.3, 4.2, 9.2, plaster, -12.35, 2.1, -0.3, scene, 4);
  box(24, 0.16, 0.06, mat(0xf2efe9, { roughness: 0.5 }), -0.5, 0.08, -4.58); box(0.06, 0.16, 9.2, mat(0xf2efe9, { roughness: 0.5 }), -12.18, 0.08, -0.3);
  // the entrance on the left
  const frameM = mat(0x3b2a20, { roughness: 0.5 });
  box(0.22, 3.1, 0.22, frameM, -12.3, 1.55, 4.3); box(0.22, 3.1, 0.22, frameM, -12.3, 1.55, 6.9); box(0.3, 0.24, 2.8, frameM, -12.3, 3.1, 5.6);
  const doormat = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.4), mat(0x4a3428, { roughness: 1 })); doormat.rotation.x = -Math.PI / 2; doormat.position.set(-11.3, 0.008, 5.6); scene.add(doormat);

  // customer counter, with the parcel being returned
  counterBox = tbox(0.85, 1.05, 3.1, wood, -4.7, 0.525, 2.6); tbox(1.05, 0.06, 3.3, wood, -4.7, 1.08, 2.6);
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), METAL); bell.position.set(-4.7, 1.11, 3.8); scene.add(bell);
  placeModel(boxG, { x: -4.75, y: 1.11, z: 1.6, width: 0.5, clone: true });
  const sign = textSprite('REFUND DESK', { size: 0.46, color: '#ffe3b0', bg: 'rgba(60,38,24,.95)', weight: 700 }); sign.position.set(-4.7, 3.2, 2.6); scene.add(sign);

  // order shelf: a real display shelf with one parcel per order
  station('lookup_order', 'Order shelf · lookup_order', -1.7, -3.7, 3.5, (g) => {
    const shelf = placeModel(shelfG, { x: 0, y: 0, z: 0, height: 2.1, rotY: Math.PI / 2, parent: g });
    const levels = [];
    if (shelf) {   // find the shelf boards by casting a ray down through the middle
      g.updateMatrixWorld(true);
      const rc = new THREE.Raycaster(new THREE.Vector3(-1.7, 4, -3.7), new THREE.Vector3(0, -1, 0));
      rc.intersectObject(shelf, true).forEach((h) => { const y = h.point.y; if (y > 0.25 && y < 1.9 && !levels.some((l) => Math.abs(l - y) < 0.15)) levels.push(y); });
      levels.sort((a, b) => b - a);
    }
    const ys = levels.length >= 2 ? [levels[0], levels[0], levels[1], levels[1]] : [1.2, 1.2, 0.5, 0.5];
    Object.keys(ORDERS).forEach((id, i) => {
      const p = new THREE.Group(); p.position.set(i % 2 ? 0.32 : -0.32, ys[i] - 0, 0.05); g.add(p);
      const b = placeModel(boxG, { x: 0, y: 0, z: 0, width: 0.42, parent: p, clone: true }) || box(0.42, 0.32, 0.36, 0xc89a5e, 0, 0.16, 0, p);
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.13), new THREE.MeshBasicMaterial({ map: canvasTex(128, 56, (c, w, h) => {
        c.fillStyle = '#fbf6ea'; c.fillRect(0, 0, w, h); c.fillStyle = '#2a2a2a'; c.font = '700 34px ui-monospace,Consolas,monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(id, w / 2, h / 2 + 2);
      }) }));
      const bb = new THREE.Box3().setFromObject(p); tag.position.set(0, (bb.max.y - p.position.y) * 0.55, bb.max.z - p.position.z + 0.004); p.add(tag);
      const glowMats = []; p.traverse((o) => { if (o.isMesh && o !== tag) glowMats.push(o.material); });
      parcels[id] = { p, b: { material: { emissive: new THREE.Color(), set emissiveIntensity(v) { glowMats.forEach((m) => { if (m.emissive) { m.emissive.copy(this.emissive); m.emissiveIntensity = v; } }); } } }, home: p.position.clone() };
    });
  });
  // till: wooden counter, a real cash register, and the policy check arch in front
  station('issue_refund', 'Till · issue_refund', 2.6, -3.0, 3.2, (g) => {
    tbox(1.8, 1.0, 0.9, wood, 0, 0.5, -0.1, g); tbox(1.95, 0.06, 1.0, wood, 0, 1.03, -0.1, g);
    const reg = placeModel(registerG, { x: 0, y: 1.06, z: -0.15, width: 0.75, rotY: 0, parent: g });
    tillScreen = box(0.5, 0.3, 0.02, mat(0x0b1020, { emissive: 0x1b2a55, emissiveIntensity: 1 }), 0, reg ? 1.62 : 1.5, -0.55, g);
    gate = new THREE.Group(); g.add(gate); gate.position.z = 1.3;
    const gm = new THREE.MeshStandardMaterial({ color: 0xb8c2d6, metalness: 0.85, roughness: 0.25, emissive: 0x000000 });
    [-1.0, 1.0].forEach((x) => box(0.12, 2.3, 0.16, gm, x, 1.15, 0, gate));
    box(2.12, 0.2, 0.18, gm, 0, 2.38, 0, gate);
    RULES.forEach((_, i) => { const l = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 12), mat(0x2c3756, { emissive: 0x000000 })); l.position.set(-0.6 + i * 0.4, 2.38, 0.12); gate.add(l); gateLights.push(l); });
    gate.userData.mat = gm;
    const gl = textSprite('refund policy check', { size: 0.22, color: '#c9d3ea', weight: 500 }); gl.position.set(0, 2.72, 0); gate.add(gl);
  });
  // manager's office: plaster walls, a wooden door, a desk inside
  station("escalate_to_human", "Manager's office · escalate_to_human", 6.0, -2.3, 2.4, (g) => {
    tbox(0.9, 3.0, 0.18, plaster, -1.1, 1.5, -0.2, g); tbox(0.9, 3.0, 0.18, plaster, 1.1, 1.5, -0.2, g); tbox(3.1, 0.45, 0.18, plaster, 0, 2.78, -0.2, g);
    [-1.55, 1.55].forEach((x) => tbox(0.12, 3.0, 2.1, plaster, x, 1.5, -1.25, g));
    door = new THREE.Group(); door.position.set(-0.65, 0, -0.2); g.add(door);
    tbox(1.3, 2.5, 0.07, wood, 0.65, 1.25, 0, door, 1.5);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), METAL); knob.position.set(1.15, 1.15, 0.06); door.add(knob);
    const plate = textSprite('MANAGER', { size: 0.16, color: '#2a2a2a', bg: 'rgba(240,232,210,.95)' }); plate.position.set(0.65, 1.85, 0.06); door.add(plate);
    placeModel(deskG, { x: 0, y: 0, z: -1.75, width: 1.6, rotY: Math.PI, parent: g });
  });
  stations.escalate_to_human.stand.x -= 1.3;   // stand beside the door, so the manager can step out

  // furnishing: plants, a wall clock, ceiling lamps, a wet-floor sign
  [[-11.4, -3.8, 1.1], [10.8, -3.8, 1.1], [-11.4, 2.2, 0.9]].forEach(([x, z, h]) => placeModel(plantG, { x, z, height: h, clone: true }));
  placeModel(clockG, { x: -4.7, y: 3.7, z: -4.58, width: 0.6, rotY: 0 });
  // wall lamps above the stations, each with a warm light
  [[-4.7, -4.55], [-1.7, -4.55], [2.6, -4.55]].forEach(([x, z]) => {
    placeModel(lampG, { x, y: 3.05, z: z + 0.25, height: 0.35, clone: true });
    const pl = new THREE.PointLight(0xffd9a8, 2.2, 7, 1.8); pl.position.set(x, 3.0, z + 1.2); scene.add(pl);
  });
  placeModel(wetG, { x: -9.6, z: 3.4, height: 0.75, rotY: 0.6 });

  // graders' bench at the front
  const BZ = 6.2;   // the graders' bench stands at the front, low, so it never hides the shop
  tbox(7.4, 0.07, 0.8, wood, 0.6, 0.7, BZ); [-2.95, 4.15].forEach((x) => box(0.08, 0.7, 0.65, METAL, x, 0.35, BZ));
  const benchLbl = textSprite('Graders', { size: 0.3, color: '#c9d3ea', bg: 'rgba(11,15,24,.8)', weight: 600 }); benchLbl.position.set(-3.7, 1.1, BZ); scene.add(benchLbl);
  LAMPS.forEach(([key, name], i) => {
    const x = -2.3 + i * 1.45;
    box(0.06, 0.3, 0.06, METAL, x, 0.88, BZ); box(0.36, 0.05, 0.28, METAL, x, 0.75, BZ);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 32, 20), new THREE.MeshPhysicalMaterial({ color: 0x3a4666, roughness: 0.15, transmission: 0, clearcoat: 1, emissive: 0x000000 }));
    m.position.set(x, 1.2, BZ); scene.add(m);
    const l = textSprite(name, { size: 0.24, color: '#c9d3ea', weight: 500 }); l.position.set(x, 1.7, BZ); scene.add(l);
    lampMeshes[key] = m;
  });
  coin = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.04, 32), new THREE.MeshStandardMaterial({ color: 0xffd34d, metalness: 1, roughness: 0.25, emissive: 0x3a2a00 }));
  coin.rotation.x = Math.PI / 2; coin.visible = false; scene.add(coin);

  // the three characters
  customer = customerG ? actor(customerG, 1.68, { idle: 'Idle_Neutral', walk: 'Walk', wave: 'Wave', interact: 'Interact' }) : simpleFigure(0x3f7fd6, 1.68);
  agent = robotG ? actor(robotG, 1.55, { idle: 'Idle', walk: 'Walking', wave: 'Wave', yes: 'Yes', no: 'No', thumbs: 'ThumbsUp', reach: 'Punch', standing: 'Standing' }) : simpleFigure(0x6f52c9, 1.55);
  manager = managerG ? actor(managerG, 1.82, { idle: 'Idle_Neutral', walk: 'Walk', wave: 'Wave', interact: 'Interact' }) : simpleFigure(0x2c3448, 1.82);
  scene.add(customer, agent, manager);
  lblCustomer = textSprite('Customer', { size: 0.3, color: '#9ec0ff', bg: 'rgba(11,15,24,.7)' }); scene.add(lblCustomer);
  lblAgent = textSprite('AI agent', { size: 0.3, color: '#dcc8ff', bg: 'rgba(11,15,24,.7)' }); scene.add(lblAgent);
  lblManager = textSprite('Manager (human)', { size: 0.28, color: '#e3d4ff', bg: 'rgba(11,15,24,.7)' }); scene.add(lblManager);
  scene.traverse((o) => { if (o.isMesh && o !== base) { o.castShadow = true; o.receiveShadow = true; } });
  if (assetFailures || !hdr) {   // say so, rather than quietly showing stand-in shapes
    const n = document.createElement('div'); n.id = 'assetnote';
    n.textContent = `The 3D models could not load here (${assetFailures} of 11 failed), so simple stand-ins are shown. Open the GitHub Pages version or run it locally to see the real scene.`;
    document.body.append(n);
  }
}

// ---------- results wall ----------
const wall = new THREE.Group(); wall.position.set(-0.3, 3.75, -4.3); wall.scale.setScalar(0.7); scene.add(wall);   // a results display mounted on the shop's back wall
let data = {}, order = [], blocks = [], current = null, model = 'qwen2.5:3b';
const blockGeo = new THREE.BoxGeometry(1.0, 0.62, 0.5);
function wilson(p, n) { if (!n) return [0, 1]; const z = 1.96, ph = p / n, d = 1 + z * z / n, c = (ph + z * z / (2 * n)) / d,
  h = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; }

function buildWall() {
  wall.traverse((o) => {   // free the old wall's GPU memory; it is rebuilt after every live result
    if (o.geometry && o.geometry !== blockGeo) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
  while (wall.children.length) wall.remove(wall.children[0]);
  blocks = []; order = [];
  const ids = Object.keys(data);
  const grouped = GROUPS.map((g) => ids.filter((id) => data[id].capability === g)).concat([ids.filter((id) => !GROUPS.includes(data[id].capability))]);
  const total = ids.length * 1.25 + grouped.filter((g) => g.length).length * 0.7;
  const board = box(Math.max(total + 1.6, 12), 8.0, 0.2, mat(0x10141f, { roughness: 0.35, metalness: 0.2 }), 0, 3.95, -0.25, wall); board.receiveShadow = true;
  box(Math.max(total + 1.6, 12) + 0.3, 8.3, 0.12, mat(0x2b2f38, { metalness: 0.7, roughness: 0.35 }), 0, 3.95, -0.37, wall);
  const title = textSprite('Results wall · every block is one graded run', { size: 0.42, color: '#c9d3ea', weight: 600 }); title.position.set(0, 8.1, -0.3); wall.add(title);
  let x = -total / 2 + 0.6;
  grouped.forEach((g, gi) => {
    if (!g.length) return;
    const x0 = x;
    g.forEach((id) => {
      const r = data[id];
      box(1.08, 0.08, 0.6, C.dim, x, 0.04, 0, wall);
      r.trials.forEach((t, i) => {
        const m = new THREE.Mesh(blockGeo, mat(t.grades.pass ? C.pass : C.fail, { emissive: 0x000000, roughness: 0.45 }));
        m.position.set(x, 0.42 + i * 0.72, 0); m.userData = { id, i }; m.castShadow = true; wall.add(m); blocks.push(m); order.push({ id, i });
      });
      const topY = 0.42 + Math.max(r.trials.length, 1) * 0.72;
      const s = textSprite(`${r.passes}/${r.trials.length}`, { size: 0.34, color: r.passes === r.trials.length ? '#8df0b4' : r.passes ? '#ffd89a' : '#ffb0a8' });
      s.position.set(x, topY + 0.02, 0); wall.add(s);
      const l = textSprite(id.replace(/_/g, ' '), { size: 0.31, color: '#c9d3ea', weight: 500 });
      l.material.rotation = Math.PI / 4.2; l.center.set(0, 0.5); l.position.set(x - 0.2, topY + 0.42, 0); wall.add(l);
      x += 1.25;
    });
    const gl = textSprite(GROUP_TEXT[GROUPS[gi]] || 'OTHER', { size: 0.32, color: '#9aa6bf', bg: 'rgba(22,29,46,.95)' }); gl.position.set((x0 + x - 1.25) / 2, 7.25, 0); wall.add(gl);
    x += 0.7;
  });
}

function chips() {
  const all = Object.values(data).flatMap((r) => r.trials), n = all.length, p = all.filter((t) => t.grades.pass).length;
  if (!n) { $('chips').innerHTML = ''; return; }
  const tasks = Object.values(data), every = tasks.filter((r) => r.trials.length && r.trials.every((t) => t.grades.pass)).length;
  const [lo, hi] = wilson(p, n), pc = (v) => Math.round(v * 100) + '%';
  const lies = all.filter((t) => t.grades.claim && !t.grades.claim.pass).length;
  const blocked = all.reduce((s, t) => s + (t.blocked_attempts || 0), 0);
  const ungr = all.filter((t) => t.grades.grounded && !t.grades.grounded.pass).length;
  $('chips').innerHTML = [
    `<span class="chip ${p / n > 0.9 ? 'good' : 'warn'}" title="95% range ${pc(lo)} to ${pc(hi)}"><b>${pc(p / n)}</b> of ${n} runs did the right thing <span style="color:var(--quiet)">(plausibly ${pc(lo)}–${pc(hi)})</span></span>`,
    `<span class="chip warn"><b>${every}/${tasks.length}</b> scenarios passed every time</span>`,
    all[0].grades.claim ? `<span class="chip ${lies ? 'bad' : 'good'}"><b>${lies}</b> replies claimed an action that never happened</span>` : '',
    all[0].grades.grounded ? `<span class="chip ${ungr ? 'warn' : 'good'}"><b>${ungr}</b> said no without checking</span>` : '',
    `<span class="chip ${blocked ? 'warn' : 'good'}"><b>${blocked}</b> refund attempts blocked by the shop</span>`,
  ].join('');
  resize();
}

// ---------- how-it-works panel ----------
const STAGES = ['customer', 'agent', 'tool', 'shop', 'graders'];
function stage(key, text) {
  STAGES.forEach((k) => $('loop-' + k).classList.toggle('on', k === key));
  if (key && text != null) $('loop-' + key).querySelector('span').textContent = text;
}
function clearStages() { STAGES.forEach((k) => { $('loop-' + k).classList.remove('on'); $('loop-' + k).querySelector('span').textContent = ''; }); }
function buildPolicyList() {
  $('policy').innerHTML = '';
  RULES.forEach(([key, text]) => { const li = document.createElement('li'); li.id = 'rule-' + key; li.innerHTML = '<i></i><div><span></span><small></small></div>'; li.querySelector('span').textContent = text; $('policy').append(li); });
  const tb = $('orders').querySelector('tbody'); tb.innerHTML = '';
  Object.entries(ORDERS).forEach(([id, o]) => {
    const tr = document.createElement('tr'); tr.id = 'order-' + id;
    [id, o.status, o.days_since_delivery == null ? '—' : `${o.days_since_delivery} days ago`, '$' + o.total].forEach((v) => { const td = document.createElement('td'); td.textContent = v; tr.append(td); });
    tb.append(tr);
  });
}
function resetPolicy() {
  RULES.forEach(([key]) => { const li = $('rule-' + key); li.className = ''; li.querySelector('small').textContent = ''; });
  $('policy-verdict').className = ''; $('policy-verdict').textContent = 'Waiting for a refund attempt.';
  gateLights.forEach((l) => { l.material.color.setHex(0x2c3756); glow(l, 0x000000, 0); });
}
function highlightOrder(id) { Object.keys(ORDERS).forEach((k) => $('order-' + k).classList.toggle('on', k === id)); }
function setManager(text, called) { $('mgr').textContent = text; $('mgr').className = called ? 'called' : ''; }

// ---------- speech bubbles and cards pinned to 3D points ----------
const bubbles = new Map();
function say(key, anchor, text, cls = '') {
  let b = bubbles.get(key);
  if (!b) { const el = document.createElement('div'); $('bubbles').append(el); b = { el }; bubbles.set(key, b); }
  b.anchor = anchor; b.el.textContent = text; b.el.className = cls; b.el.style.display = 'block';
}
function unsay(key) { const b = bubbles.get(key); if (b) { b.el.style.display = 'none'; b.anchor = null; } }
function unsayAll() { [...bubbles.keys()].forEach(unsay); }
const above = (obj, extra = 0.25) => () => new THREE.Vector3(obj.position.x, obj.position.y + obj.userData.height + extra, obj.position.z);

// ---------- playback ----------
let paused = false, speed = 1, token = 0, stepRequests = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cancelled extends Error {}
async function hold(my) { if (my !== token) throw new Cancelled(); while (paused && !stepRequests) { await sleep(60); if (my !== token) throw new Cancelled(); } }
// waits count real elapsed time, so a slow device (few frames per second) does not stretch the replay
async function wait(ms, my) {
  let left = ms;
  while (left > 0) { await hold(my); const t0 = performance.now(); await sleep(Math.min(40, left / speed)); left -= (performance.now() - t0) * speed; }
  if (my !== token) throw new Cancelled();
}
async function tween(ms, my, fn, ease = true) {
  const t0 = performance.now(); let el = 0, last = t0;
  while (el < ms) { await hold(my); await new Promise(requestAnimationFrame); const now = performance.now(); if (!(paused && !stepRequests)) el += (now - last) * speed; last = now;
    const k = Math.min(1, el / ms); fn(ease ? (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2) : k); }
  fn(1); if (my !== token) throw new Cancelled();
}
async function stepDone(my) { if (stepRequests) { stepRequests--; } await hold(my); }
const angleTo = (p, to) => Math.atan2(to.x - p.position.x, to.z - p.position.z);
async function turn(p, angle, my, ms = 220) {
  const a0 = p.rotation.y; let d = angle - a0; d = Math.atan2(Math.sin(d), Math.cos(d));
  if (Math.abs(d) < 0.02) return; await tween(ms, my, (k) => { p.rotation.y = a0 + d * k; });
}
async function walk(p, to, my) {
  const from = p.position.clone(); from.y = 0; const dist = from.distanceTo(to); if (dist < 0.05) return;
  anim(p, 'walk');
  try {
    await turn(p, angleTo(p, to), my, 260);
    await tween(Math.max(400, dist / 2.3 * 1000), my, (k) => { p.position.lerpVectors(from, to, k); }, false);
  } finally { anim(p, 'idle'); }
}
// play a one-off gesture (wave, nod, shake head…) and return to idle
async function gesture(p, key, my, maxMs = 1600) { const ms = anim(p, key, true); if (!ms) return; await wait(Math.min(ms, maxMs), my); anim(p, 'idle'); }
const face = (p, x, z, my) => turn(p, Math.atan2(x - p.position.x, z - p.position.z), my);
const fly = (obj, from, to, ms, my, arc = 1.6) => { obj.visible = true; return tween(ms, my, (k) => { obj.position.lerpVectors(from, to, k); obj.position.y += Math.sin(k * Math.PI) * arc; }); };
function glow(mesh, color, on = 1) {
  const m = mesh.material; m.emissive.setHex(color); m.emissiveIntensity = on;
  if (m.transparent && m.opacity !== undefined) { m.opacity = on ? 0.5 : 0; if (on) m.color.setHex(color); }   // floor rings show only while lit
}
const handOf = (p) => p.localToWorld(new THREE.Vector3(0.22, p.userData.height * 0.62, 0.42));
async function reach(p, my) { anim(p, 'reach', true); await wait(450, my); }
async function unreach(p, my) { anim(p, 'idle'); await wait(150, my); }

const AGENT_HOME = new THREE.Vector3(-3.25, 0, 2.6), CUSTOMER_SPOT = new THREE.Vector3(-6.05, 0, 2.6), ENTRANCE = new THREE.Vector3(-11.5, 0, 4.8);
function resetShop() {
  agent.position.copy(AGENT_HOME); agent.rotation.y = -Math.PI / 2; anim(agent, 'idle'); expression(agent, null, 0);
  customer.position.copy(ENTRANCE); customer.rotation.y = Math.PI / 2; anim(customer, 'idle'); anim(manager, 'idle');
  manager.position.copy(MANAGER_HOME); manager.rotation.y = 0; manager.visible = false; door.rotation.y = 0;
  coin.visible = false; unsayAll();
  Object.values(stations).forEach((s) => glow(s.pad, 0x000000, 0));
  Object.values(parcels).forEach((pc) => { pc.p.position.copy(pc.home); glow(pc.b, 0x000000, 0); });
  glow({ material: gate.userData.mat }, 0x000000, 0); glow(tillScreen, 0x1b2a55, 1);
  Object.values(lampMeshes).forEach((m) => { m.material.color.setHex(0x3a4666); glow(m, 0x000000, 0); });
  clearStages(); resetPolicy(); highlightOrder(null);
  setManager('In the office. Comes out only when the agent hands over.', false);
}
function describe(name, res) {
  if (!res || typeof res !== 'object') return String(res);
  if (res.error) return 'Shop says: ' + res.error;
  if (name === 'lookup_order') return `${res.order_id}: ${res.status}${res.days_since_delivery != null ? `, ${res.days_since_delivery} days ago` : ''}, total $${res.total}`;
  if (name === 'issue_refund') return `Refunded $${res.refunded}`;
  if (name === 'escalate_to_human') return 'Handed to a human';
  return JSON.stringify(res);
}
const callText = (s) => `${s.name}(${Object.values(s.args || {}).map((v) => JSON.stringify(v)).join(', ')})`;
function trialSteps(t) {
  const out = []; const pend = [];
  for (const m of t.transcript) {
    if (m.role === 'assistant') for (const c of (m.tool_calls || [])) { const s = { name: c.name, args: c.args || {}, result: null }; out.push(s); pend.push(s); }
    else if (m.role === 'tool') { const s = pend.find((p) => p.result === null && p.name === m.name); if (s) s.result = m.content; }
  }
  return out;
}

function fillPanel(id, i) {
  const r = data[id], t = r.trials[i], steps = trialSteps(t);
  const prompt = (t.transcript.find((m) => m.role === 'user') || {}).content || '';
  $('t-name').textContent = id.replace(/_/g, ' ');
  $('t-meta').textContent = `${r.capability} · run ${i + 1} of ${r.trials.length} · this scenario passed ${r.passes}/${r.trials.length}`;
  $('t-prompt').textContent = prompt;
  const ol = $('steps'); ol.innerHTML = '';
  steps.forEach((s, n) => {
    const li = document.createElement('li'); li.dataset.n = n + 1;
    const blocked = s.name === 'issue_refund' && !(s.result && s.result.ok);
    li.className = blocked ? 'blocked' : (s.result && s.result.error ? '' : 'ok');
    const code = document.createElement('code'); code.textContent = callText(s);
    const res = document.createElement('span'); res.className = 'res'; res.textContent = describe(s.name, s.result);
    li.append(code, res); ol.append(li);
  });
  if (!steps.length) { const li = document.createElement('li'); li.className = 'none'; li.textContent = 'No tools used. It only replied.'; ol.append(li); }
  $('t-final').textContent = ''; $('t-final').classList.remove('lie'); $('t-lie').style.display = 'none';
  const lamps = $('lamps'); lamps.innerHTML = '';
  LAMPS.forEach(([key, name, q, extra]) => {
    const g = t.grades[key]; if (!g) return;
    const d = document.createElement('div'); d.className = 'lamp ' + (g.pass ? 'pass' : 'fail'); d.id = 'lamp-' + key;
    d.innerHTML = `<i></i><div><b></b>${extra ? '<span class="extra">extra check</span>' : ''}<span></span></div>`;
    d.querySelector('b').textContent = name; d.querySelector('span:last-child').textContent = g.pass ? q : g.note; lamps.append(d);
  });
  $('verdict').className = ''; $('verdict').textContent = '';
  return { t, steps, prompt };
}

// One refund attempt: the coin goes into the policy check, the four rule lights evaluate, then it passes or bounces.
async function refundAt(st, s, already, my) {
  const a = s.args || {}, res = s.result || {};
  const argError = typeof res.error === 'string' && /^(bad arguments|unknown tool)/.test(res.error);
  await reach(agent, my, 1.2);
  const hand = handOf(agent), gatePos = st.g.position.clone().add(new THREE.Vector3(0, 1.3, 1.2)), till = st.g.position.clone().add(new THREE.Vector3(0, 1.5, -0.15));
  await fly(coin, hand, gatePos, 380, my, 0.3);
  stage('shop', argError ? res.error : 'Checking the refund policy…');
  let allowed = !!res.ok;
  if (!argError) {
    const chk = checkRefund(a.order_id, a.amount, already[a.order_id] || 0);
    highlightOrder(a.order_id);
    for (let n = 0; n < chk.checks.length; n++) {
      const c = chk.checks[n], li = $('rule-' + c.key), l = gateLights[n];
      li.className = c.pass === null ? 'skip' : c.pass ? 'pass' : 'fail'; li.querySelector('small').textContent = c.note; li.scrollIntoView({ block: 'nearest' });
      if (c.pass !== null) { l.material.color.setHex(c.pass ? C.pass : C.fail); glow(l, c.pass ? C.pass : C.fail, 1.6); }
      await wait(c.pass === null ? 120 : 330, my);
    }
    allowed = !!res.ok;   // the shop's own answer is the truth; tests/test_policy_mirror.py keeps the two in step
    $('policy-verdict').className = allowed ? 'ok' : 'no';
    $('policy-verdict').textContent = allowed ? `Allowed: $${res.refunded} refunded.` : `Refused: ${res.error}.`; $('policy-verdict').scrollIntoView({ block: 'nearest' });
  }
  if (allowed) {
    glow({ material: gate.userData.mat }, C.pass, 0.9); glow(st.pad, C.pass, 0.9); glow(tillScreen, C.pass, 1.4);
    stage('shop', describe(s.name, res));
    await fly(coin, gatePos, till, 360, my, 0.2);
    say('station', () => st.top, describe(s.name, res), 'card ok');
    await fly(coin, till, customer.position.clone().add(new THREE.Vector3(0.3, 1.2, 0)), 900, my, 2.4); coin.visible = false;
    gesture(agent, 'yes', my).catch(() => {}); gesture(customer, 'wave', my).catch(() => {});
    already[a.order_id] = (already[a.order_id] || 0) + a.amount;
  } else {
    glow({ material: gate.userData.mat }, C.warn, 1.4); glow(st.pad, C.warn, 0.9); glow(tillScreen, C.fail, 1.2);
    stage('shop', 'Blocked: ' + (res.error || 'refused'));
    say('station', () => st.top, 'BLOCKED · ' + (res.error || 'refused'), 'card blocked');
    await fly(coin, gatePos, handOf(agent), 420, my, 0.7); coin.visible = false;
    expression(agent, 'Surprised', 0.8); await gesture(agent, 'no', my, 1300); expression(agent, null, 0);
  }
  await unreach(agent, my);
}

let liveQueue = [], live = null, idle = false;   // live = { agent, running } while a live run is streaming
async function play(id, i) {
  const my = ++token; current = { id, i }; idle = false;
  blocks.forEach((m) => { const on = m.userData.id === id && m.userData.i === i; m.scale.setScalar(on ? 1.18 : 1); glow(m, on ? 0xffffff : 0x000000, on ? 0.35 : 0); });
  resetShop();
  const { t, steps, prompt } = fillPanel(id, i);
  try {
    // 1. the customer walks in and asks
    stage('customer', short(prompt, 120)); $('loop').scrollIntoView({ block: 'nearest' });
    await walk(customer, CUSTOMER_SPOT, my); await face(customer, AGENT_HOME.x, AGENT_HOME.z, my);
    say('customer', above(customer), short(prompt, 110)); anim(customer, 'interact', true);
    gesture(agent, 'wave', my).catch(() => {}); await wait(1600, my); anim(customer, 'idle');
    await stepDone(my);
    const already = {};
    for (let n = 0; n < steps.length; n++) {
      const s = steps[n], st = stations[s.name], li = $('steps').children[n];
      stage('agent', `Chooses ${s.name.replace(/_/g, ' ')}`); await wait(450, my);
      stage('tool', callText(s));
      li.classList.add('on'); li.scrollIntoView({ block: 'nearest' });
      if (n === 0) unsay('customer');
      if (!st) {   // a tool the shop does not have
        stage('shop', describe(s.name, s.result)); say('agent', above(agent), `Tried ${s.name}: no such tool`, 'card blocked');
        await wait(1200, my); unsay('agent'); await stepDone(my); continue;
      }
      await walk(agent, st.stand, my); await face(agent, st.g.position.x, st.g.position.z, my);
      const ok = s.result && !s.result.error;
      if (s.name === 'issue_refund') {
        await refundAt(st, s, already, my);
      } else if (s.name === 'escalate_to_human') {
        glow(st.pad, C.agent, 0.9); stage('shop', 'Manager called in');
        await tween(500, my, (k) => { door.rotation.y = -k * 1.3; });
        manager.visible = true; await walk(manager, MANAGER_OUT, my); await face(manager, agent.position.x, agent.position.z, my);
        gesture(manager, 'wave', my).catch(() => {});
        const reason = (s.args && s.args.reason) || '';
        setManager(`Called in by the agent${reason ? `: “${short(reason, 90)}”` : '.'}`, true); $('mgr').scrollIntoView({ block: 'nearest' });
        say('manager', above(manager), "I'll take it from here.", 'mgr');
      } else {   // lookup_order
        const pc = parcels[s.args && s.args.order_id];
        await reach(agent, my);
        highlightOrder(s.args && s.args.order_id);
        if (pc) { glow(pc.b, C.accent, 0.6); await tween(320, my, (k) => { pc.p.position.set(pc.home.x, pc.home.y + 0.18 * k, pc.home.z + 0.3 * k); }); }
        glow(st.pad, ok ? C.accent : C.warn, 0.9);
        stage('shop', describe(s.name, s.result));
        say('station', () => st.top, describe(s.name, s.result), ok ? 'card' : 'card blocked');
        await unreach(agent, my);
      }
      await wait(1100, my); unsay('station'); await stepDone(my);
    }
    // 2. back to the counter with the reply
    if (agent.position.distanceTo(AGENT_HOME) > 0.1) await walk(agent, AGENT_HOME, my);
    await face(agent, customer.position.x, customer.position.z, my);
    unsay('manager'); unsay('customer');
    const reply = t.final && t.final.trim() ? t.final.trim() : '(no reply)';
    const claim = t.grades.claim, lie = claim && !claim.pass;
    stage('agent', 'Replies: ' + short(reply, 110));
    say('agent', above(agent), short(reply, 120), lie ? 'lie' : '');
    $('t-final').textContent = reply;
    if (lie) { $('t-final').classList.add('lie'); $('t-lie').textContent = '⚠ ' + claim.note.split(':')[0] + '.'; $('t-lie').style.display = 'block'; }
    $('t-final').scrollIntoView({ block: 'nearest' });
    await wait(2200, my); await stepDone(my);
    // 3. the graders
    stage('graders', 'Scoring…');
    for (const [key, name] of LAMPS) {
      const g = t.grades[key]; if (!g) continue;
      const m = lampMeshes[key]; m.material.color.setHex(g.pass ? C.pass : C.fail); glow(m, g.pass ? C.pass : C.fail, 1.4);
      const el = $('lamp-' + key); el.classList.add('on'); el.scrollIntoView({ block: 'nearest' });
      stage('graders', `${name}: ${g.pass ? 'pass' : 'fail'}`);
      await wait(380, my);
    }
    if (t.grades.pass) gesture(agent, 'thumbs', my).catch(() => {}); else { expression(agent, 'Sad', 0.9); gesture(agent, 'no', my).catch(() => {}); }
    const v = $('verdict'); v.className = t.grades.pass ? 'pass' : 'fail'; v.innerHTML = '';
    v.append(t.grades.pass ? 'PASS · did the right thing' : 'FAIL');
    const small = document.createElement('small');
    small.textContent = t.grades.pass ? ((t.grades.claim && !t.grades.claim.pass) || (t.grades.grounded && !t.grades.grounded.pass) ? 'Passed the main rule, but an extra check is red.' : '') : (LABEL_TEXT[t.failure_label] || t.grades.outcome.note);
    v.append(small); v.scrollIntoView({ block: 'nearest' });
    stage('graders', t.grades.pass ? 'PASS' : 'FAIL · ' + (LABEL_TEXT[t.failure_label] || 'see panel'));
    // lets tests (and anything embedding the page) follow the replay
    document.dispatchEvent(new CustomEvent('replay:verdict', { detail: { id, run: i + 1, pass: t.grades.pass,
      policy: $('policy-verdict').textContent, manager: $('mgr').textContent } }));
    stepRequests = 0;
    await wait(2400, my);
    await hold(my);                                                 // if paused here, carry on once resumed
    if (liveQueue.length) { const nx = liveQueue.shift(); return play(nx.id, nx.i); }
    if (live && live.running) { idle = true; return; }              // wait for the next live run to be graded
    go(1);                                                          // keep the demo moving
  } catch (e) { if (!(e instanceof Cancelled)) throw e; }
}
function idx() { return current ? order.findIndex((o) => o.id === current.id && o.i === current.i) : -1; }
function go(delta) { if (!order.length) return; liveQueue = []; const n = (idx() + delta + order.length) % order.length; play(order[n].id, order[n].i); }
function nextFail() {
  liveQueue = []; const start = idx();
  for (let k = 1; k <= order.length; k++) { const o = order[(start + k) % order.length]; if (!data[o.id].trials[o.i].grades.pass) return play(o.id, o.i); }
}
function setPaused(p) { paused = p; $('play').textContent = paused ? '▶ Play' : '⏸ Pause'; }
$('play').onclick = () => setPaused(!paused);
$('step').onclick = () => { setPaused(true); stepRequests = 1; };
$('prev').onclick = () => go(-1); $('next').onclick = () => go(1); $('nextfail').onclick = nextFail;
$('speed').onchange = (e) => { speed = parseFloat(e.target.value); };
$('sidebtn').onclick = () => { $('side').classList.toggle('hidden'); resize(); };
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); setPaused(!paused); } else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); else if (e.key.toLowerCase() === 'f') nextFail();
});

// ---------- picking ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(); let down = null;
function pick(e) { const r = canvas.getBoundingClientRect(); mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(mouse, camera); const h = ray.intersectObjects(blocks, false)[0]; return h ? h.object : null; }
canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => { if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return; const m = pick(e); if (m) { liveQueue = []; play(m.userData.id, m.userData.i); } });
canvas.addEventListener('pointermove', (e) => {
  const m = pick(e), tip = $('tip'); canvas.style.cursor = m ? 'pointer' : 'grab';
  if (!m) { tip.style.display = 'none'; return; }
  const r = data[m.userData.id], t = r.trials[m.userData.i], [lo, hi] = wilson(r.passes, r.trials.length);
  tip.textContent = `${m.userData.id} · run ${m.userData.i + 1} · ${t.grades.pass ? 'pass' : 'fail' + (t.failure_label ? ': ' + t.failure_label.replace(/_/g, ' ') : '')} · scenario ${r.passes}/${r.trials.length} (plausibly ${Math.round(lo * 100)}–${Math.round(hi * 100)}%)`;
  tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 14, innerWidth - 270) + 'px'; tip.style.top = e.clientY + 14 + 'px';
});

// ---------- frame loop ----------
let viewL = 0, viewR = 0;
function resize() {
  const w = innerWidth, h = innerHeight, narrow = w < 760; renderer.setSize(w, h, false);
  // centre the shop in the gap between the two side panels (desktop) or above the bottom sheet (phone)
  const L = narrow ? 0 : $('panel').getBoundingClientRect().right;
  const sideR = $('side').classList.contains('hidden') ? 0 : w - $('side').getBoundingClientRect().left;
  const R = narrow ? 0 : sideR, s = Math.round(L - R), padY = narrow ? Math.round(h * 0.44) : 0;
  viewL = L; viewR = R;
  const fw = w + Math.abs(s);
  camera.aspect = fw / (h + padY); camera.fov = narrow ? 60 : 44;
  camera.setViewOffset(fw, h + padY, s >= 0 ? 0 : -s, padY, w, h); camera.updateProjectionMatrix();
  if (!resize.done) {   // pull back further when the gap between the panels is narrow, so the whole shop fits
    const gap = Math.max(320, w - L - R), far = narrow ? 1.3 : Math.min(1.7, Math.max(1, 900 / gap));
    camera.position.set(-0.6, (narrow ? 15 : 8.0) * far, (narrow ? 33 : 16.4) * far); resize.done = true;
  }
  // keep the side panels below the header, however many rows the chips wrap to
  document.documentElement.style.setProperty('--top', Math.ceil(document.querySelector('header').getBoundingClientRect().bottom + 6) + 'px');
}
addEventListener('resize', resize);
if (innerWidth < 1180) $('side').classList.add('hidden');
resize();
const v3 = new THREE.Vector3(), clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update();
  if (!agent) { renderer.render(scene, camera); return; }            // still loading the models
  mixers.forEach((m) => m.update(paused && !stepRequests ? 0 : dt * speed));
  for (const [p, l] of [[customer, lblCustomer], [agent, lblAgent], [manager, lblManager]]) {
    l.visible = p.visible; l.position.set(p.position.x, p.userData.height + 0.32, p.position.z);
  }
  for (const b of bubbles.values()) {
    if (!b.anchor) continue;
    v3.copy(b.anchor()).project(camera);
    const half = b.el.offsetWidth / 2 + 6, lo = viewL + half, hi = innerWidth - viewR - half;   // keep bubbles clear of the panels
    b.el.style.left = Math.min(Math.max(((v3.x + 1) / 2) * innerWidth, lo), Math.max(lo, hi)) + 'px'; b.el.style.top = ((1 - v3.y) / 2) * innerHeight + 'px';
    b.el.style.visibility = v3.z < 1 ? 'visible' : 'hidden';
  }
  renderer.render(scene, camera);
});

// ---------- data ----------
async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
async function loadDataset(ds) {
  for (const u of ds.urls) { try { return await getJson(u); } catch (e) { /* try the next place */ } }
  return null;
}
function show(newData, label) {
  data = newData; current = null; liveQueue = [];
  buildWall(); chips(); if (label) $('runname').textContent = label;
  // ?play=refund_ok_full:2 opens a given run (1-based), which makes runs easy to link to
  const want = (new URLSearchParams(location.search).get('play') || '').split(':');
  const linked = order.find((o) => o.id === want[0] && o.i === (parseInt(want[1], 10) || 1) - 1);
  const first = linked || order.find((o) => data[o.id].trials[o.i].grades.claim && !data[o.id].trials[o.i].grades.claim.pass) || order[0];
  if (first) play(first.id, first.i);
}
async function load() {
  buildPolicyList();
  await buildWorld(); resetShop();
  const params = new URLSearchParams(location.search), run = params.get('run');
  if (run) {
    try { data = await getJson(`/api/runs/${encodeURIComponent(run)}`); } catch (e) { data = null; }
    if (data) { $('dataset').style.display = 'none'; $('msg').style.display = 'none'; show(data, `Run ${run}. Click a block to replay it.`); liveButtons(); return; }
  }
  // which recorded datasets are reachable from here?
  const found = [];
  for (const ds of DATASETS) { const d = await loadDataset(ds); if (d) found.push([ds, d]); }
  if (!found.length) { $('msg').textContent = 'Could not load results.json. Serve the repo folder (python -m http.server) or start the API (uvicorn api.main:app) and open /web/.'; return; }
  $('msg').style.display = 'none';
  const sel = $('dataset');
  found.forEach(([ds]) => { const o = document.createElement('option'); o.value = ds.key; o.textContent = ds.label; sel.append(o); });
  if (found.length < 2) sel.style.display = 'none';
  const want = found.find(([ds]) => ds.key === params.get('data')) || found[0];
  sel.value = want[0].key;
  sel.onchange = () => { const f = found.find(([ds]) => ds.key === sel.value); if (f) { stopLive(); setAgentLabel('qwen2.5:3b'); show(f[1]); } };
  setAgentLabel(model);
  show(want[1]);
  liveButtons();
}

// ---------- live runs through the local API ----------
let es = null;
function log(line) { const el = $('livelog'); el.textContent += line + '\n'; el.scrollTop = el.scrollHeight; }
function stopLive() { if (es) es.close(); es = null; live = null; ['live-mock', 'live-ollama'].forEach((id) => { $(id).disabled = false; }); }
async function liveButtons() {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;   // the API only exists when you run it locally
  let h; try { h = await getJson('/api/health'); if (!h.ok) return; } catch (e) { return; }
  $('live-mock').style.display = 'inline-block'; $('live-mock').onclick = () => startLive('mock', 5);
  if (h.ollama) { $('live-ollama').style.display = 'inline-block'; $('live-ollama').onclick = () => startLive('ollama', 1); }
}
async function startLive(agentKind, k) {
  ['live-mock', 'live-ollama'].forEach((id) => { $(id).disabled = true; });
  try {
    const r = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agentKind, k, seed: Math.floor(Math.random() * 1e6) }) });
    if (!r.ok) throw new Error((await r.json()).detail || r.status);
    const { id } = await r.json();
    token++; data = {}; current = null; liveQueue = []; buildWall(); chips(); resetShop();
    $('dataset').style.display = 'none';
    $('t-name').textContent = 'Waiting for the first live run…'; $('t-meta').textContent = 'Each run is replayed here as soon as it is graded.';
    ['t-prompt', 't-final', 'steps', 'lamps', 'verdict'].forEach((k) => { $(k).textContent = ''; }); $('verdict').className = '';
    live = { agent: agentKind, running: true };
    setAgentLabel(agentKind === 'ollama' ? 'qwen2.5:3b (live)' : 'mock (live)');
    $('side').classList.remove('hidden'); resize();
    $('livebox').style.display = 'block'; $('livelog').textContent = '';
    $('runname').textContent = agentKind === 'ollama'
      ? `Live run ${id}: qwen2.5:3b is answering right now. Each run is replayed as soon as it is graded.`
      : `Live mock run ${id}: blocks appear as each run is graded.`;
    log(`run ${id} started (${agentKind}, ${k} per scenario)`);
    es = new EventSource(`/api/runs/${id}/events`);
    es.addEventListener('trial_started', (e) => {
      const ev = JSON.parse(e.data);
      data[ev.task_id] = data[ev.task_id] || { capability: ev.capability, passes: 0, k, trials: [] };
      log(`▶ ${ev.task_id} #${ev.trial + 1}: "${short(ev.prompt, 60)}"`);
      if (!current || idle) {   // nothing replaying: show what the model is working on right now
        stage('agent', 'Thinking… the model is answering right now');
        $('loop-customer').querySelector('span').textContent = short(ev.prompt, 120);
        ['tool', 'shop', 'graders'].forEach((k) => { $('loop-' + k).querySelector('span').textContent = ''; });
      }
    });
    es.addEventListener('live_step', (e) => {
      const ev = JSON.parse(e.data);
      log(`   ${callText(ev)} → ${ev.blocked ? 'BLOCKED: ' : ''}${describe(ev.name, ev.result)}`);
      if (!current || idle) { stage('shop', (ev.blocked ? 'Blocked: ' : '') + describe(ev.name, ev.result)); $('loop-tool').querySelector('span').textContent = callText(ev); }
    });
    es.addEventListener('graded', (e) => {
      const ev = JSON.parse(e.data), r2 = data[ev.task_id];
      r2.trials.push(ev.record); r2.passes += ev.pass ? 1 : 0; buildWall(); chips();
      log(`   ${ev.pass ? '✔ PASS' : '✘ FAIL'}${ev.failure_label ? ' · ' + ev.failure_label : ''}`);
      if (agentKind === 'ollama') {   // replay each real run in the shop as soon as it is graded
        const item = { id: ev.task_id, i: r2.trials.length - 1 };
        if (!current || idle) play(item.id, item.i); else liveQueue.push(item);
      }
    });
    const end = (msg) => () => {
      log(msg); if (es) es.close(); es = null;
      if (live) live.running = false;
      if ($('dataset').options.length > 1) $('dataset').style.display = '';
      ['live-mock', 'live-ollama'].forEach((b) => { $(b).disabled = false; });
      chips();
      if (agentKind === 'mock' && order.length) { const f = order.find((o) => !data[o.id].trials[o.i].grades.pass) || order[0]; play(f.id, f.i); }
    };
    es.addEventListener('run_finished', end('run finished'));
    es.addEventListener('run_failed', (e) => end('run failed: ' + JSON.parse(e.data).error)());
    es.onerror = () => { if (live && live.running) end('stream closed')(); };
  } catch (e) {
    ['live-mock', 'live-ollama'].forEach((b) => { $(b).disabled = false; });
    $('runname').textContent = 'Could not start a live run: ' + e.message;
  }
}
load();
