// 3D replay of agent eval runs. Reads results.json (recorded) or a run from the local API.
// Plain Three.js, no build step: open web/index.html through any static server.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const C = { pass: 0x2ecc71, fail: 0xff5a4d, warn: 0xf5a623, accent: 0x6ea0ff, floor: 0x18203a, dim: 0x2a3550,
            agent: 0xc7a6ff, customer: 0x6ea0ff, wood: 0x3a4a72 };
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

// ---------- scene ----------
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1420);
scene.fog = new THREE.Fog(0x0f1420, 45, 130);
const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.48; controls.minDistance = 8; controls.maxDistance = 60;
controls.target.set(1.5, 2.0, -3.5);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2030, 1.15));
const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(6, 14, 10); scene.add(sun);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...extra });
const box = (w, h, d, color, x, y, z, parent = scene) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color)); m.position.set(x, y, z); parent.add(m); return m;
};
function textSprite(text, { size = 0.42, color = '#e8ecf5', bg = null, weight = 600 } = {}) {
  const pad = 14, font = `${weight} 44px system-ui, Segoe UI, Arial, sans-serif`;
  const cv = document.createElement('canvas'); let ctx = cv.getContext('2d'); ctx.font = font;
  cv.width = Math.ceil(ctx.measureText(text).width) + pad * 2; cv.height = 64;
  ctx = cv.getContext('2d'); ctx.font = font; ctx.textBaseline = 'middle';
  if (bg) { ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, cv.width, cv.height, 14); ctx.fill(); }
  ctx.fillStyle = color; ctx.fillText(text, pad, 34);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(size * cv.width / cv.height, size, 1); return s;
}
function person(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 1.1, 20), mat(color)); body.position.y = 0.55; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 16), mat(color, { roughness: 0.5 })); head.position.y = 1.42; g.add(head);
  g.userData.body = body; return g;
}

// floor and shop
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), mat(C.floor)); floor.rotation.x = -Math.PI / 2; scene.add(floor);
const HOME = new THREE.Vector3(-3.4, 0, 2.6);
const customer = person(C.customer); customer.position.set(-6.6, 0, 2.6); scene.add(customer);
box(0.7, 1.0, 2.6, C.wood, -5, 0.5, 2.6);                                   // counter
const agent = person(C.agent); agent.position.copy(HOME); scene.add(agent);
const lblCustomer = textSprite('Customer', { size: 0.36, color: '#9ec0ff' }); lblCustomer.position.set(-6.6, 2.2, 2.6); scene.add(lblCustomer);
const lblAgent = textSprite('AI agent', { size: 0.36, color: '#dcc8ff' }); scene.add(lblAgent);

const stations = {};
function station(key, title, x, z, build) {
  const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.06, 40), mat(C.dim, { emissive: 0x000000 })); pad.position.y = 0.03; g.add(pad);
  build(g);
  const l = textSprite(title, { size: 0.38, bg: 'rgba(11,15,24,.85)' }); l.position.set(0, 3.0, 0); g.add(l);
  stations[key] = { g, pad, stand: new THREE.Vector3(x, 0, z + (key === 'issue_refund' ? 2.2 : 1.6)), top: new THREE.Vector3(x, 3.5, z) };
}
station('lookup_order', 'Order shelf · look up', -1.6, -1.6, (g) => {
  box(1.8, 2.2, 0.5, C.wood, 0, 1.1, -0.2, g);
  [[-0.5, 1.7], [0.1, 1.7], [0.55, 1.0], [-0.3, 1.0], [0.2, 0.35]].forEach(([x, y], i) => box(0.42, 0.42, 0.42, [0x8fb3ff, 0xffd08a, 0x9be7c4][i % 3], x, y, 0.12, g));
});
let gate, coin, door;
station('issue_refund', 'Till · refund', 2.6, -1.6, (g) => {
  box(1.3, 1.0, 0.8, C.wood, 0, 0.5, -0.2, g); box(0.8, 0.5, 0.5, 0x51618f, 0, 1.25, -0.2, g);
  gate = new THREE.Group(); g.add(gate); gate.position.z = 0.9;                // policy gate in front of the till
  const gm = mat(0x51618f, { emissive: 0x000000 });
  [[-0.95, 1.0, 0.14, 2.0], [0.95, 1.0, 0.14, 2.0]].forEach(([x, y, w, h]) => { const p = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.14), gm); p.position.set(x, y, 0); gate.add(p); });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.14, 0.14), gm); bar.position.y = 2.0; gate.add(bar);
  gate.userData.mat = gm;
  const gl = textSprite('policy gate', { size: 0.26, color: '#9aa6bf', weight: 500 }); gl.position.set(0, 2.35, 0); gate.add(gl);
});
station('escalate_to_human', "Manager's door · hand over", 6.6, -1.6, (g) => {
  box(1.5, 2.4, 0.16, 0x26324f, 0, 1.2, -0.3, g);
  door = new THREE.Group(); door.position.set(-0.55, 0, -0.2); g.add(door);
  box(1.1, 2.1, 0.1, 0x8a6f4d, 0.55, 1.05, 0, door);
});
coin = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.08, 28), mat(0xffd34d, { emissive: 0x7a5a00, metalness: 0.4, roughness: 0.3 }));
coin.rotation.x = Math.PI / 2; coin.visible = false; scene.add(coin);
const envelope = box(0.5, 0.32, 0.06, 0xffffff, 0, 0, 0); envelope.visible = false;

// lamp beam above the shop
const lampMeshes = {};
LAMPS.forEach(([key, name], i) => {
  const x = -1.9 + i * 2.3;
  box(0.16, 0.9, 0.16, C.dim, x, 0.45, 5.6);
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 16), mat(0x3a4666, { emissive: 0x000000 })); m.position.set(x, 1.15, 5.6); scene.add(m);
  const l = textSprite(name, { size: 0.34, color: '#c9d3ea', weight: 500 }); l.position.set(x, 1.85, 5.6); scene.add(l);
  lampMeshes[key] = m;
});

// ---------- results wall ----------
const wall = new THREE.Group(); wall.position.set(1.5, 0, -9.5); wall.scale.setScalar(1.15); scene.add(wall);
let data = {}, order = [], blocks = [], current = null;
const blockGeo = new THREE.BoxGeometry(1.0, 0.62, 0.5);
function wilson(p, n) { if (!n) return [0, 1]; const z = 1.96, ph = p / n, d = 1 + z * z / n, c = (ph + z * z / (2 * n)) / d,
  h = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; }

function buildWall() {
  while (wall.children.length) wall.remove(wall.children[0]);
  blocks = []; order = [];
  const ids = Object.keys(data);
  const grouped = GROUPS.map((g) => ids.filter((id) => data[id].capability === g)).concat([ids.filter((id) => !GROUPS.includes(data[id].capability))]);
  const total = ids.length * 1.25 + grouped.filter((g) => g.length).length * 0.7;
  let x = -total / 2 + 0.6;
  grouped.forEach((g, gi) => {
    if (!g.length) return;
    const x0 = x;
    g.forEach((id) => {
      const r = data[id];
      box(1.08, 0.08, 0.6, C.dim, x, 0.04, 0, wall);
      r.trials.forEach((t, i) => {
        const m = new THREE.Mesh(blockGeo, mat(t.grades.pass ? C.pass : C.fail, { emissive: 0x000000 }));
        m.position.set(x, 0.42 + i * 0.72, 0); m.userData = { id, i }; wall.add(m); blocks.push(m); order.push({ id, i });
      });
      const topY = 0.42 + Math.max(r.trials.length, 1) * 0.72;
      const s = textSprite(`${r.passes}/${r.k}`, { size: 0.34, color: r.passes === r.k ? '#8df0b4' : r.passes ? '#ffd89a' : '#ffb0a8' });
      s.position.set(x, topY + 0.02, 0); wall.add(s);
      const l = textSprite(id.replace(/_/g, ' '), { size: 0.33, color: '#c9d3ea', weight: 500 });
      l.material.rotation = Math.PI / 4.2; l.center.set(0, 0.5); l.position.set(x - 0.2, topY + 0.42, 0); wall.add(l);
      x += 1.25;
    });
    const name = GROUP_TEXT[GROUPS[gi]] || 'OTHER';
    const gl = textSprite(name, { size: 0.34, color: '#9aa6bf', bg: 'rgba(22,29,46,.9)' }); gl.position.set((x0 + x - 1.25) / 2, 7.3, 0); wall.add(gl);
    x += 0.7;
  });
  order.sort((a, b) => blocks.findIndex((m) => m.userData.id === a.id && m.userData.i === a.i) - blocks.findIndex((m) => m.userData.id === b.id && m.userData.i === b.i));
}

function chips() {
  const all = Object.values(data).flatMap((r) => r.trials), n = all.length, p = all.filter((t) => t.grades.pass).length;
  const tasks = Object.values(data), every = tasks.filter((r) => r.trials.length && r.trials.every((t) => t.grades.pass)).length;
  const [lo, hi] = wilson(p, n), pc = (v) => Math.round(v * 100) + '%';
  const lies = all.filter((t) => t.grades.claim && !t.grades.claim.pass).length;
  const blocked = all.reduce((s, t) => s + (t.blocked_attempts || 0), 0);
  const ungr = all.filter((t) => t.grades.grounded && !t.grades.grounded.pass).length;
  $('chips').innerHTML = n ? [
    `<span class="chip ${p / n > 0.9 ? 'good' : 'warn'}" title="95% range ${pc(lo)} to ${pc(hi)}"><b>${pc(p / n)}</b> of ${n} runs did the right thing</span>`,
    `<span class="chip warn"><b>${every}/${tasks.length}</b> scenarios passed every time</span>`,
    all[0].grades.claim ? `<span class="chip ${lies ? 'bad' : 'good'}"><b>${lies}</b> replies claimed an action that never happened</span>` : '',
    all[0].grades.grounded ? `<span class="chip ${ungr ? 'warn' : 'good'}"><b>${ungr}</b> said no without checking</span>` : '',
    `<span class="chip ${blocked ? 'warn' : 'good'}"><b>${blocked}</b> refund attempts blocked by the shop</span>`,
  ].join('') : '';
}

// ---------- playback ----------
let paused = false, speed = 1, token = 0, stepRequests = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cancelled extends Error {}
async function hold(my) { if (my !== token) throw new Cancelled(); while (paused && !stepRequests) { await sleep(60); if (my !== token) throw new Cancelled(); } }
async function wait(ms, my) { let left = ms; while (left > 0) { await hold(my); const d = Math.min(40, left); await sleep(d / speed); left -= d; } if (my !== token) throw new Cancelled(); }
async function tween(ms, my, fn) {
  const t0 = performance.now(); let el = 0, last = t0;
  while (el < ms) { await hold(my); await new Promise(requestAnimationFrame); const now = performance.now(); if (!(paused && !stepRequests)) el += (now - last) * speed; last = now;
    const k = Math.min(1, el / ms); fn(k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2); }
  fn(1); if (my !== token) throw new Cancelled();
}
async function stepDone(my) { if (stepRequests) { stepRequests--; } await hold(my); }
const walk = (to, my) => { const from = agent.position.clone(); return tween(Math.max(350, from.distanceTo(to) * 190), my, (k) => { agent.position.lerpVectors(from, to, k); agent.position.y = Math.abs(Math.sin(k * Math.PI * 4)) * 0.07; }); };
const fly = (obj, from, to, ms, my, arc = 1.6) => { obj.visible = true; return tween(ms, my, (k) => { obj.position.lerpVectors(from, to, k); obj.position.y += Math.sin(k * Math.PI) * arc; }); };
function glow(mesh, color, on = 1) { mesh.material.emissive.setHex(color); mesh.material.emissiveIntensity = on; }

let activeCard = null;
function showCard(pos, text, cls) { activeCard = pos; const c = $('card'); c.textContent = text; c.className = cls || ''; c.style.display = 'block'; }
function hideCard() { activeCard = null; $('card').style.display = 'none'; }

function resetShop() {
  agent.position.copy(HOME); coin.visible = false; envelope.visible = false; hideCard();
  Object.values(stations).forEach((s) => glow(s.pad, 0x000000, 0));
  glow({ material: gate.userData.mat }, 0x000000, 0); door.rotation.y = 0;
  Object.values(lampMeshes).forEach((m) => { m.material.color.setHex(0x3a4666); glow(m, 0x000000, 0); });
}
function describe(name, res) {
  if (!res || typeof res !== 'object') return String(res);
  if (res.error) return 'Shop says: ' + res.error;
  if (name === 'lookup_order') return `${res.status}${res.days_since_delivery != null ? `, ${res.days_since_delivery} days ago` : ''}, total $${res.total}`;
  if (name === 'issue_refund') return `Refunded $${res.refunded}`;
  if (name === 'escalate_to_human') return 'Handed to a human';
  return JSON.stringify(res);
}
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
  $('t-meta').textContent = `${r.capability} · run ${i + 1} of ${r.trials.length} · this scenario passed ${r.passes}/${r.k}`;
  $('t-prompt').textContent = prompt;
  const ol = $('steps'); ol.innerHTML = '';
  steps.forEach((s, n) => {
    const li = document.createElement('li'); li.dataset.n = n + 1;
    const blocked = s.name === 'issue_refund' && !(s.result && s.result.ok);
    li.className = blocked ? 'blocked' : (s.result && s.result.error ? '' : 'ok');
    const code = document.createElement('code'); code.textContent = `${s.name}(${Object.values(s.args).map((v) => JSON.stringify(v)).join(', ')})`;
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
  return { t, steps };
}

async function play(id, i) {
  const my = ++token; current = { id, i };
  blocks.forEach((m) => { const on = m.userData.id === id && m.userData.i === i; m.scale.setScalar(on ? 1.18 : 1); glow(m, on ? 0xffffff : 0x000000, on ? 0.35 : 0); });
  resetShop();
  const { t, steps } = fillPanel(id, i);
  try {
    await wait(350, my);
    // the request arrives
    const from = customer.position.clone().add(new THREE.Vector3(0.4, 1.3, 0)), to = HOME.clone().add(new THREE.Vector3(0, 1.3, 0));
    await fly(envelope, from, to, 650, my, 0.9); envelope.visible = false;
    await stepDone(my);
    for (let n = 0; n < steps.length; n++) {
      const s = steps[n], st = stations[s.name] || stations.lookup_order, li = $('steps').children[n];
      await walk(st.stand, my);
      const ok = s.result && !s.result.error, blocked = s.name === 'issue_refund' && !(s.result && s.result.ok);
      li.classList.add('on'); li.scrollIntoView({ block: 'nearest' });
      if (s.name === 'issue_refund') {
        const a = st.stand.clone().add(new THREE.Vector3(0, 1.3, -0.4)), till = st.g.position.clone().add(new THREE.Vector3(0, 1.5, -0.2));
        if (blocked) {
          const gatePos = st.g.position.clone().add(new THREE.Vector3(0, 1.2, 0.9));
          await fly(coin, a, gatePos, 380, my, 0.3);
          glow({ material: gate.userData.mat }, C.warn, 1.6); glow(st.pad, C.warn, 0.9);
          showCard(st.top, 'BLOCKED · ' + describe(s.name, s.result), 'blocked');
          await fly(coin, gatePos, a, 420, my, 0.7); coin.visible = false;
        } else {
          glow({ material: gate.userData.mat }, C.pass, 1.2); glow(st.pad, C.pass, 0.9);
          await fly(coin, a, till, 420, my, 0.4);
          showCard(st.top, describe(s.name, s.result), 'ok');
          await fly(coin, till, customer.position.clone().add(new THREE.Vector3(0, 1.3, 0)), 900, my, 2.4); coin.visible = false;
        }
      } else if (s.name === 'escalate_to_human') {
        glow(st.pad, 0xc7a6ff, 0.9); showCard(st.top, describe(s.name, s.result), 'ok');
        await tween(500, my, (k) => { door.rotation.y = -k * 1.25; });
      } else {
        glow(st.pad, ok ? C.accent : C.warn, 0.9); showCard(st.top, describe(s.name, s.result), ok ? '' : 'blocked');
        await tween(420, my, (k) => { agent.userData.body.scale.y = 1 + Math.sin(k * Math.PI) * 0.12; });
      }
      await wait(1150, my); hideCard(); await stepDone(my);
    }
    if (agent.position.distanceTo(HOME) > 0.1) await walk(HOME, my);
    // the reply
    $('t-final').textContent = t.final && t.final.trim() ? t.final.trim() : '(no reply)';
    const claim = t.grades.claim;
    if (claim && !claim.pass) { $('t-final').classList.add('lie'); $('t-lie').textContent = '⚠ ' + claim.note.split(':')[0] + '.'; $('t-lie').style.display = 'block'; }
    $('t-final').scrollIntoView({ block: 'nearest' });
    await wait(1300, my); await stepDone(my);
    // the graders
    for (const [key] of LAMPS) {
      const g = t.grades[key]; if (!g) continue;
      const m = lampMeshes[key]; m.material.color.setHex(g.pass ? C.pass : C.fail); glow(m, g.pass ? C.pass : C.fail, 1.4);
      const el = $('lamp-' + key); el.classList.add('on'); el.scrollIntoView({ block: 'nearest' });
      await wait(380, my);
    }
    const v = $('verdict'); v.className = t.grades.pass ? 'pass' : 'fail';
    v.innerHTML = '';
    v.append(t.grades.pass ? 'PASS · did the right thing' : 'FAIL');
    const small = document.createElement('small');
    small.textContent = t.grades.pass ? ((t.grades.claim && !t.grades.claim.pass) || (t.grades.grounded && !t.grades.grounded.pass) ? 'Passed the main rule, but an extra check is red.' : '') : (LABEL_TEXT[t.failure_label] || t.grades.outcome.note);
    v.append(small); v.scrollIntoView({ block: 'nearest' });
    stepRequests = 0;
    await wait(2600, my);
    if (!paused) go(1);                                          // keep the demo moving
  } catch (e) { if (!(e instanceof Cancelled)) throw e; }
}
function idx() { return current ? order.findIndex((o) => o.id === current.id && o.i === current.i) : -1; }
function go(delta) { if (!order.length) return; const n = (idx() + delta + order.length) % order.length; play(order[n].id, order[n].i); }
function nextFail() {
  const start = idx();
  for (let k = 1; k <= order.length; k++) { const o = order[(start + k) % order.length]; if (!data[o.id].trials[o.i].grades.pass) return play(o.id, o.i); }
}
function setPaused(p) { paused = p; $('play').textContent = paused ? '▶ Play' : '⏸ Pause'; }
$('play').onclick = () => setPaused(!paused);
$('step').onclick = () => { setPaused(true); stepRequests = 1; };
$('prev').onclick = () => go(-1); $('next').onclick = () => go(1); $('nextfail').onclick = nextFail;
$('speed').onchange = (e) => { speed = parseFloat(e.target.value); };
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); setPaused(!paused); } else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); else if (e.key.toLowerCase() === 'f') nextFail();
});

// ---------- picking ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(); let down = null;
function pick(e) { const r = canvas.getBoundingClientRect(); mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(mouse, camera); const h = ray.intersectObjects(blocks, false)[0]; return h ? h.object : null; }
canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => { if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return; const m = pick(e); if (m) play(m.userData.id, m.userData.i); });
canvas.addEventListener('pointermove', (e) => {
  const m = pick(e), tip = $('tip'); canvas.style.cursor = m ? 'pointer' : 'grab';
  if (!m) { tip.style.display = 'none'; return; }
  const r = data[m.userData.id], t = r.trials[m.userData.i], [lo, hi] = wilson(r.passes, r.k);
  tip.textContent = `${m.userData.id} · run ${m.userData.i + 1} · ${t.grades.pass ? 'pass' : 'fail' + (t.failure_label ? ': ' + t.failure_label.replace(/_/g, ' ') : '')} · scenario ${r.passes}/${r.k} (plausibly ${Math.round(lo * 100)}–${Math.round(hi * 100)}%)`;
  tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 14, innerWidth - 270) + 'px'; tip.style.top = e.clientY + 14 + 'px';
});

// ---------- frame loop ----------
function resize() {
  const w = innerWidth, h = innerHeight, narrow = w < 760; renderer.setSize(w, h, false);
  // keep the scene clear of the side panel (desktop) or the bottom sheet (phone)
  const padX = narrow ? 0 : 380, padY = narrow ? Math.round(h * 0.42) : 0;
  camera.aspect = (w + padX) / (h + padY); camera.fov = narrow ? 58 : 44;
  camera.setViewOffset(w + padX, h + padY, 0, padY, w, h); camera.updateProjectionMatrix();
  if (!resize.done) { camera.position.set(1.5, narrow ? 20 : 11.5, narrow ? 43 : 21); resize.done = true; }
}
addEventListener('resize', resize); resize();
const v3 = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  controls.update();
  lblAgent.position.set(agent.position.x, 2.2, agent.position.z);
  if (activeCard) { v3.copy(activeCard).project(camera); const c = $('card'); c.style.left = ((v3.x + 1) / 2) * innerWidth + 'px'; c.style.top = ((1 - v3.y) / 2) * innerHeight + 'px'; }
  renderer.render(scene, camera);
});

// ---------- data ----------
async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
async function load() {
  const run = new URLSearchParams(location.search).get('run');
  const sources = run ? [`/api/runs/${encodeURIComponent(run)}`] : ['../results/results.json', './results.json'];
  for (const s of sources) { try { data = await getJson(s); break; } catch (e) { data = null; } }
  if (!data) { $('msg').textContent = 'Could not load results.json. Serve the repo folder (python -m http.server) or start the API (uvicorn api.main:app) and open /web/.'; return; }
  $('msg').style.display = 'none';
  if (run) $('runname').textContent = `Run ${run}. Click a block to replay it.`;
  buildWall(); chips();
  const first = order.find((o) => data[o.id].trials[o.i].grades.claim && !data[o.id].trials[o.i].grades.claim.pass) || order[0];
  if (first) play(first.id, first.i);
  liveButton();
}

// Optional: when the local API is up, start a fresh mock run and watch the wall fill in.
async function liveButton() {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;   // the API only exists when you run it locally
  try { const h = await getJson('/api/health'); if (!h.ok) return; } catch (e) { return; }
  const b = $('live'); b.style.display = 'inline-block';
  b.onclick = async () => {
    b.disabled = true; b.textContent = 'Running…';
    try {
      const r = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'mock', k: 5, seed: Math.floor(Math.random() * 1e6) }) });
      if (!r.ok) throw new Error((await r.json()).detail || r.status);
      const { id } = await r.json(); token++; data = {}; current = null; buildWall(); chips();
      $('runname').textContent = `Live mock run ${id}: blocks appear as each run is graded.`;
      const es = new EventSource(`/api/runs/${id}/events`);
      es.addEventListener('trial_started', (e) => { const ev = JSON.parse(e.data); data[ev.task_id] = data[ev.task_id] || { capability: ev.capability, passes: 0, k: 5, trials: [] }; });
      es.addEventListener('graded', (e) => { const ev = JSON.parse(e.data); const r2 = data[ev.task_id]; r2.trials.push(ev.record); r2.passes += ev.pass ? 1 : 0; buildWall(); chips(); });
      const end = () => { es.close(); b.disabled = false; b.textContent = 'Run mock eval live'; if (order.length) play(order[0].id, order[0].i); };
      es.addEventListener('run_finished', end); es.addEventListener('run_failed', end); es.onerror = end;
    } catch (e) { b.disabled = false; b.textContent = 'Run mock eval live'; $('runname').textContent = 'Could not start a live run: ' + e.message; }
  };
}
load();
