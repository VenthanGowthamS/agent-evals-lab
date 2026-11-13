// 3D replay of agent eval runs. Reads a recorded results.json or a live run from the local API.
// Plain Three.js, no build step: open web/index.html through any static server.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1320);
scene.fog = new THREE.Fog(0x0e1320, 48, 130);
const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 6; controls.maxDistance = 60;
controls.target.set(0.5, 2.6, -3.6);
scene.add(new THREE.HemisphereLight(0xe4ecff, 0x20283a, 0.95));
const sun = new THREE.DirectionalLight(0xfff4e6, 1.6); sun.position.set(7, 16, 11); sun.castShadow = true;
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

// ---------- people ----------
// A simple jointed figure: legs and arms swing from hip and shoulder pivots so it can walk and reach.
function human({ skin, shirt, pants, hair, shoes = 0x1c2130, hairStyle = 'short', scale = 0.9 }) {
  const g = new THREE.Group(), rig = {};
  const skinM = mat(skin, { roughness: 0.6 }), shirtM = mat(shirt), pantsM = mat(pants), shoeM = mat(shoes, { roughness: 0.5 });
  const limb = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 12);
  const leg = (x) => {
    const p = new THREE.Group(); p.position.set(x, 0.95, 0);
    const l = new THREE.Mesh(limb(0.115, 0.6), pantsM); l.position.y = -0.42;
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.34), shoeM); s.position.set(0, -0.89, 0.05);
    p.add(l, s); g.add(p); return p;
  };
  rig.legL = leg(-0.14); rig.legR = leg(0.14);
  box(0.46, 0.24, 0.28, pantsM, 0, 1.0, 0, g);
  const torso = new THREE.Mesh(limb(0.25, 0.42), shirtM); torso.scale.set(1.08, 1, 0.72); torso.position.y = 1.42; g.add(torso);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.16, 12), skinM); neck.position.y = 1.93; g.add(neck);
  const head = new THREE.Group(); head.position.y = 2.13; g.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 28, 20), skinM));
  const eyeM = mat(0x1a1d26, { roughness: 0.3 });
  [-0.07, 0.07].forEach((x) => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), eyeM); e.position.set(x, 0.03, 0.18); head.add(e); });
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), skinM); nose.position.set(0, -0.02, 0.2); head.add(nose);
  const mouth = box(0.08, 0.014, 0.01, 0x7a3b33, 0, -0.09, 0.185, head);
  const hairM = mat(hair, { roughness: 0.9 });
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.215, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), hairM);
  cap.rotation.x = -0.25; cap.position.set(0, 0.01, -0.02); head.add(cap);
  if (hairStyle === 'bun') { const b = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), hairM); b.position.set(0, 0.12, -0.2); head.add(b); }
  const arm = (side) => {
    const p = new THREE.Group(); p.position.set(side * 0.33, 1.78, 0); p.rotation.z = side * 0.09;
    const a = new THREE.Mesh(limb(0.085, 0.5), shirtM); a.position.y = -0.33;
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), skinM); h.position.y = -0.68;
    p.add(a, h); g.add(p); return p;
  };
  rig.armL = arm(-1); rig.armR = arm(1);
  Object.assign(rig, { torso, head, mouth, shirtM });
  g.scale.setScalar(scale); g.userData.rig = rig; g.userData.height = 2.4 * scale;
  return g;
}
function setStride(p, phase, amt) {
  const r = p.userData.rig, a = Math.sin(phase) * 0.55 * amt;
  r.legL.rotation.x = a; r.legR.rotation.x = -a;
  if (!p.userData.carrying) { r.armL.rotation.x = -a * 0.8; r.armR.rotation.x = a * 0.8; }
}

const customer = human({ skin: 0xc68863, shirt: 0x3f7fd6, pants: 0x34425f, hair: 0x2b1d14 });
customer.userData.carrying = true;
customer.userData.rig.armL.rotation.x = customer.userData.rig.armR.rotation.x = -0.95;
const parcel = box(0.42, 0.32, 0.34, 0xc89a5e, 0, 1.36, 0.42, customer);
box(0.43, 0.05, 0.08, 0xe9dcc4, 0, 1.36, 0.42, customer).position.y = 1.53;
scene.add(customer);

const agent = human({ skin: 0xd9a77e, shirt: 0x6f52c9, pants: 0x262b3f, hair: 0x15161c, hairStyle: 'bun' });
{ // headset and an "AI" badge, so it reads as the AI agent at a glance
  const head = agent.userData.rig.head, hm = mat(0x22252f, { roughness: 0.4 });
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.018, 8, 24, Math.PI), hm); band.position.y = 0.02; head.add(band);
  [-1, 1].forEach((s) => { const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 16), hm); cup.rotation.z = Math.PI / 2; cup.position.set(s * 0.215, 0, 0); head.add(cup); });
  const mic = box(0.018, 0.018, 0.2, hm, -0.17, -0.08, 0.1, head); mic.rotation.y = 0.6;
  const glowM = mat(0x9cf2ff, { emissive: 0x4fd8ff, emissiveIntensity: 1.2 });
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), glowM); tip.position.set(-0.11, -0.09, 0.19); head.add(tip);
  const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.12), new THREE.MeshBasicMaterial({ map: canvasTex(128, 76, (c, w, h) => {
    c.fillStyle = '#e9f6ff'; c.beginPath(); c.roundRect(0, 0, w, h, 12); c.fill(); c.fillStyle = '#5236b5'; c.font = '700 52px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('AI', w / 2, h / 2 + 3);
  }) }));
  badge.position.set(0.12, 1.62, 0.2); agent.add(badge);
}
scene.add(agent);

const manager = human({ skin: 0x8d5a3b, shirt: 0x2c3448, pants: 0x232a3a, hair: 0x9a9a9a, shoes: 0x120d0a, scale: 0.94 });
{
  const r = manager.userData.rig;
  box(0.16, 0.42, 0.02, 0xf2f2f2, 0, 1.6, 0.19, manager);                 // shirt
  const tie = box(0.06, 0.34, 0.02, 0xb8322b, 0, 1.56, 0.205, manager); tie.rotation.z = 0.02;
  const gm = mat(0x111111, { roughness: 0.3 });
  [-0.075, 0.075].forEach((x) => { const g = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.008, 6, 16), gm); g.position.set(x, 0.03, 0.2); r.head.add(g); });
}
scene.add(manager);

const lblCustomer = textSprite('Customer', { size: 0.34, color: '#9ec0ff', bg: 'rgba(11,15,24,.7)' }); scene.add(lblCustomer);
const lblAgent = textSprite('AI agent', { size: 0.34, color: '#dcc8ff', bg: 'rgba(11,15,24,.7)' }); scene.add(lblAgent);
const lblManager = textSprite('Manager (human)', { size: 0.3, color: '#e3d4ff', bg: 'rgba(11,15,24,.7)' }); scene.add(lblManager);
function setAgentLabel(model) {
  const s = textSprite(`AI agent · ${model}`, { size: 0.34, color: '#dcc8ff', bg: 'rgba(11,15,24,.7)' });
  lblAgent.material.map.dispose(); lblAgent.material.map = s.material.map; lblAgent.scale.copy(s.scale); lblAgent.material.needsUpdate = true;
}

// ---------- the shop ----------
const floorTex = canvasTex(256, 256, (c, w, h) => {
  c.fillStyle = '#1a2236'; c.fillRect(0, 0, w, h); c.strokeStyle = '#232d45'; c.lineWidth = 3;
  for (let i = 0; i <= 2; i++) { c.beginPath(); c.moveTo(i * w / 2, 0); c.lineTo(i * w / 2, h); c.stroke(); c.beginPath(); c.moveTo(0, i * h / 2); c.lineTo(w, i * h / 2); c.stroke(); }
});
floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping; floorTex.repeat.set(30, 20);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 46), mat(0xffffff, { map: floorTex, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
const rug = new THREE.Mesh(new THREE.PlaneGeometry(19, 9.5), mat(0x222c47, { roughness: 1 })); rug.rotation.x = -Math.PI / 2; rug.position.set(-0.6, 0.005, 1.2); rug.receiveShadow = true; scene.add(rug);

const WOOD = mat(0x6b4e37, { roughness: 0.6 }), WOOD_D = mat(0x4a3526, { roughness: 0.6 }), METAL = mat(0x8c96aa, { metalness: 0.6, roughness: 0.35 });
const WALL = mat(0x27324f, { roughness: 0.9 });
// back wall of the shop, low enough that the results wall stays visible behind it
box(19, 1.1, 0.22, WALL, -0.6, 0.55, -3.6);
box(19, 0.08, 0.32, WOOD, -0.6, 1.14, -3.6);
// entrance on the left
box(0.22, 3.1, 0.22, WOOD_D, -10.1, 1.55, 3.4); box(0.22, 3.1, 0.22, WOOD_D, -10.1, 1.55, 6.2); box(0.26, 0.24, 3.04, WOOD_D, -10.1, 3.1, 4.8);
const doormat = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.4), mat(0x5a3a2a, { roughness: 1 })); doormat.rotation.x = -Math.PI / 2; doormat.position.set(-9.2, 0.01, 4.8); scene.add(doormat);
// customer counter
box(0.8, 1.05, 3.0, WOOD, -5.15, 0.52, 2.6); box(1.0, 0.07, 3.2, WOOD_D, -5.15, 1.08, 2.6);
const bell = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), METAL); bell.position.set(-5.15, 1.12, 3.6); scene.add(bell);
const sign = textSprite('REFUND DESK', { size: 0.5, color: '#ffe3b0', bg: 'rgba(60,38,24,.95)', weight: 700 }); sign.position.set(-5.15, 3.3, 2.6); scene.add(sign);
function plant(x, z) {
  box(0.5, 0.5, 0.5, mat(0x8a5a3c), x, 0.25, z);
  [[0, 0.95, 0, 0.38], [0.18, 1.2, 0.1, 0.26], [-0.16, 1.18, -0.08, 0.28]].forEach(([dx, y, dz, r]) => {
    const l = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat(0x2f8f5b, { roughness: 0.8, flatShading: true })); l.position.set(x + dx, y, z + dz); scene.add(l);
  });
}
plant(-9.3, -2.8); plant(8.6, 3.6); plant(-9.3, 1.9);

const stations = {};
function station(key, title, x, z, standDz, build) {
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.04, 40), mat(C.dim, { emissive: 0x000000 })); pad.position.set(0, 0.02, standDz - 0.2); pad.receiveShadow = true; g.add(pad);
  build(g);
  const l = textSprite(title, { size: 0.36, bg: 'rgba(11,15,24,.85)' }); l.position.set(0, 3.25, 0); g.add(l);
  stations[key] = { g, pad, stand: new THREE.Vector3(x, 0, z + standDz), top: new THREE.Vector3(x, 3.0, z) };
}
// order shelf with one parcel per order
const parcels = {};
station('lookup_order', 'Order shelf · lookup_order', -1.7, -2.3, 2.1, (g) => {
  box(2.3, 2.5, 0.08, WOOD_D, 0, 1.25, -0.32, g);
  [-1.1, 1.1].forEach((x) => box(0.08, 2.5, 0.7, WOOD, x, 1.25, 0, g));
  [0.05, 0.9, 1.75, 2.5].forEach((y) => box(2.3, 0.07, 0.7, WOOD, 0, y, 0, g));
  Object.keys(ORDERS).forEach((id, i) => {
    const p = new THREE.Group(); p.position.set(i % 2 ? 0.5 : -0.5, i < 2 ? 1.17 : 0.32, 0.05); g.add(p);
    const b = box(0.62, 0.48, 0.5, mat([0xc89a5e, 0xb98c56, 0xd2a86a, 0xc0905a][i], { emissive: 0x000000 }), 0, 0.02, 0, p);
    const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.2), new THREE.MeshBasicMaterial({ map: canvasTex(128, 56, (c, w, h) => {
      c.fillStyle = '#fbf6ea'; c.fillRect(0, 0, w, h); c.fillStyle = '#2a2a2a'; c.font = '700 34px ui-monospace,Consolas,monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(id, w / 2, h / 2 + 2);
    }) })); tag.position.set(0, 0.02, 0.26); p.add(tag);
    parcels[id] = { p, b, home: p.position.clone() };
  });
});
// till with the policy scanner in front: four lights, one per refund rule
let gate, gateLights = [], tillScreen;
station('issue_refund', 'Till · issue_refund', 2.6, -2.3, 2.5, (g) => {
  box(1.7, 1.05, 0.9, WOOD, 0, 0.52, -0.1, g); box(1.85, 0.07, 1.0, WOOD_D, 0, 1.08, -0.1, g);
  box(0.75, 0.32, 0.55, mat(0x2d3448, { metalness: 0.3 }), 0, 1.28, -0.15, g);
  tillScreen = box(0.6, 0.38, 0.05, mat(0x0b1020, { emissive: 0x1b2a55, emissiveIntensity: 1 }), 0, 1.72, -0.3, g); tillScreen.rotation.x = -0.35;
  gate = new THREE.Group(); g.add(gate); gate.position.z = 1.2;
  const gm = mat(0x51618f, { emissive: 0x000000, metalness: 0.4, roughness: 0.4 });
  [-1.0, 1.0].forEach((x) => box(0.16, 2.3, 0.2, gm, x, 1.15, 0, gate));
  box(2.16, 0.22, 0.22, gm, 0, 2.38, 0, gate);
  RULES.forEach((_, i) => {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), mat(0x2c3756, { emissive: 0x000000 })); l.position.set(-0.6 + i * 0.4, 2.38, 0.14); gate.add(l); gateLights.push(l);
  });
  gate.userData.mat = gm;
  const gl = textSprite('refund policy check', { size: 0.24, color: '#c9d3ea', weight: 500 }); gl.position.set(0, 2.78, 0); gate.add(gl);
});
// manager's office: a wall with a door; the manager waits inside
let door;
const MANAGER_HOME = new THREE.Vector3(6.6, 0, -3.2), MANAGER_OUT = new THREE.Vector3(6.6, 0, -1.0);
station('escalate_to_human', "Manager's office · escalate_to_human", 6.6, -2.3, 2.4, (g) => {
  box(0.9, 2.7, 0.18, WALL, -1.1, 1.35, -0.2, g); box(0.9, 2.7, 0.18, WALL, 1.1, 1.35, -0.2, g); box(3.1, 0.4, 0.18, WALL, 0, 2.9, -0.2, g);
  door = new THREE.Group(); door.position.set(-0.65, 0, -0.2); g.add(door);
  box(1.3, 2.5, 0.08, mat(0x8a6f4d, { roughness: 0.55 }), 0.65, 1.25, 0, door);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), METAL); knob.position.set(1.15, 1.2, 0.07); door.add(knob);
  [-1.55, 1.55].forEach((x) => box(0.1, 3.1, 1.6, WALL, x, 1.55, -1.0, g));
  box(3.2, 3.1, 0.1, WALL, 0, 1.55, -1.8, g);
});
stations.escalate_to_human.stand.x -= 1.3;   // stand beside the door, so the manager can step out
// a refund coin that travels from the agent to the till (or bounces off the policy check)
const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 28), mat(0xffd34d, { emissive: 0x7a5a00, metalness: 0.5, roughness: 0.3 }));
coin.rotation.x = Math.PI / 2; coin.visible = false; scene.add(coin);

// graders' bench at the front
const lampMeshes = {};
box(10.2, 0.1, 1.1, WOOD, 2.2, 0.95, 6.0); [-2.7, 7.1].forEach((x) => box(0.12, 0.95, 0.9, WOOD_D, x, 0.47, 6.0));
const benchLbl = textSprite('Graders', { size: 0.34, color: '#9aa6bf', weight: 500 }); benchLbl.position.set(-3.6, 1.35, 6.0); scene.add(benchLbl);
LAMPS.forEach(([key, name], i) => {
  const x = -1.6 + i * 1.95;
  box(0.08, 0.5, 0.08, METAL, x, 1.25, 6.0); box(0.4, 0.06, 0.3, METAL, x, 1.03, 6.0);
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), mat(0x3a4666, { emissive: 0x000000 })); m.position.set(x, 1.72, 6.0); scene.add(m);
  const l = textSprite(name, { size: 0.32, color: '#c9d3ea', weight: 500 }); l.position.set(x, 2.35, 6.0); scene.add(l);
  lampMeshes[key] = m;
});

scene.traverse((o) => { if (o.isMesh && o !== floor && o !== rug) { o.castShadow = true; o.receiveShadow = true; } });

// ---------- results wall ----------
const wall = new THREE.Group(); wall.position.set(-0.4, 1.4, -11); wall.scale.setScalar(1.15); scene.add(wall);   // raised, so it reads above the shop
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
  const board = box(Math.max(total + 1.6, 12), 8.6, 0.2, mat(0x141b2c, { roughness: 0.95 }), 0, 4.2, -0.5, wall); board.receiveShadow = true;
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
  await turn(p, angleTo(p, to), my);
  await tween(Math.max(300, dist * 260), my, (k) => {
    p.position.lerpVectors(from, to, k); const ph = k * dist * 3.4; setStride(p, ph, 1); p.position.y = Math.abs(Math.sin(ph)) * 0.035;
  }, false);
  setStride(p, 0, 0); p.position.y = 0;
}
const face = (p, x, z, my) => turn(p, Math.atan2(x - p.position.x, z - p.position.z), my);
const fly = (obj, from, to, ms, my, arc = 1.6) => { obj.visible = true; return tween(ms, my, (k) => { obj.position.lerpVectors(from, to, k); obj.position.y += Math.sin(k * Math.PI) * arc; }); };
function glow(mesh, color, on = 1) { mesh.material.emissive.setHex(color); mesh.material.emissiveIntensity = on; }
const handOf = (p, side = 'armR') => { const v = new THREE.Vector3(0, -0.68, 0); p.userData.rig[side].localToWorld(v); return v; };
async function reach(p, my, up = 1.5) { const a = p.userData.rig.armR; await tween(260, my, (k) => { a.rotation.x = -up * k; }); }
async function unreach(p, my) { const a = p.userData.rig.armR, a0 = a.rotation.x; await tween(220, my, (k) => { a.rotation.x = a0 * (1 - k); }); }

const AGENT_HOME = new THREE.Vector3(-3.7, 0, 2.6), CUSTOMER_SPOT = new THREE.Vector3(-6.55, 0, 2.6), ENTRANCE = new THREE.Vector3(-11.5, 0, 4.8);
function resetShop() {
  agent.position.copy(AGENT_HOME); agent.rotation.y = -Math.PI / 2; setStride(agent, 0, 0); agent.userData.rig.armR.rotation.x = 0;
  customer.position.copy(ENTRANCE); customer.rotation.y = Math.PI / 2; parcel.visible = true;
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
    already[a.order_id] = (already[a.order_id] || 0) + a.amount;
  } else {
    glow({ material: gate.userData.mat }, C.warn, 1.4); glow(st.pad, C.warn, 0.9); glow(tillScreen, C.fail, 1.2);
    stage('shop', 'Blocked: ' + (res.error || 'refused'));
    say('station', () => st.top, 'BLOCKED · ' + (res.error || 'refused'), 'card blocked');
    await fly(coin, gatePos, handOf(agent), 420, my, 0.7); coin.visible = false;
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
    say('customer', above(customer), short(prompt, 110)); await wait(1500, my);
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
        manager.visible = true; await walk(manager, MANAGER_OUT, my);
        const reason = (s.args && s.args.reason) || '';
        setManager(`Called in by the agent${reason ? `: “${short(reason, 90)}”` : '.'}`, true); $('mgr').scrollIntoView({ block: 'nearest' });
        say('manager', above(manager), "I'll take it from here.", 'mgr');
      } else {   // lookup_order
        const pc = parcels[s.args && s.args.order_id];
        await reach(agent, my, pc && pc.home.y > 1 ? 1.9 : 1.2);
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
    camera.position.set(0.5, (narrow ? 20 : 11) * far, (narrow ? 42 : 20.5) * far); resize.done = true;
  }
  // keep the side panels below the header, however many rows the chips wrap to
  document.documentElement.style.setProperty('--top', Math.ceil(document.querySelector('header').getBoundingClientRect().bottom + 6) + 'px');
}
addEventListener('resize', resize);
if (innerWidth < 1180) $('side').classList.add('hidden');
resize();
const v3 = new THREE.Vector3(), clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  controls.update();
  for (const [p, l, ph] of [[customer, lblCustomer, 0], [agent, lblAgent, 1.7], [manager, lblManager, 3.1]]) {
    l.visible = p.visible; l.position.set(p.position.x, p.userData.height + 0.32, p.position.z);
    p.userData.rig.torso.scale.y = 1 + Math.sin(t * 2 + ph) * 0.012;             // breathing
  }
  // the speaker's mouth moves while their bubble is up
  for (const [p, key] of [[customer, 'customer'], [agent, 'agent'], [manager, 'manager']]) {
    const b = bubbles.get(key); p.userData.rig.mouth.scale.y = b && b.anchor ? 1 + Math.abs(Math.sin(t * 14)) * 3 : 1;
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
  buildPolicyList(); resetShop();
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
