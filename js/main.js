// App shell: cinematic camera, touch controls, HUD, menu demo, post-processing and the loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createWorld, MOBILE } from './scene.js';
import { FX, Sound } from './fx.js';
import { Match, TEAM_STYLE, CHARGE_MAX } from './match.js';
import { loadModels } from './athlete.js';
import { T } from './physics.js';

const $ = id => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
const ease = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
const canvas = $('scene');
const world = createWorld(canvas);
const { renderer, scene, camera } = world;
const fx = new FX(scene);
const snd = new Sound();

// ---------- post-processing: MSAA target + gentle bloom so hits and neon glow
const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: MOBILE ? 2 : 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.5, 0.95);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const GAME_SPEED = 0.8;
let models = null;
let cfg = loadCfg();
let match = null, demo = true, paused = false;
let timeScale = 1, slowUntil = 0, shake = 0, fovKick = 0, realT = 0;
let camMode = 'orbit', cine = null;
const camPos = new THREE.Vector3(5, 3, 5), camLook = new THREE.Vector3(0, 0.8, 0), camUp = new THREE.Vector3(0, 1, 0);

function loadCfg() {
  const d = { opp: 'cpu', diff: 'pro', bestOf: 3, sound: true };
  try { const c = { ...d, ...JSON.parse(localStorage.getItem('spin-arena-cfg') || '{}') }; delete c.doubles; return c; } catch (e) { return d; }
}
function saveCfg() { try { localStorage.setItem('spin-arena-cfg', JSON.stringify(cfg)); } catch (e) {} }

// ------------------------------------------------------------ hooks
function teamLabel(team) {
  if (cfg.opp === 'cpu' && !demo) return team === 0 ? 'Вы' : 'X-Бот';
  if (demo) return match.players[team].name;
  return team === 0 ? 'Игрок 1' : 'Игрок 2';
}
function hooks() {
  return {
    onServeReady(server) {
      updateHud();
      if (demo) return;
      if (server.human) showHint(server.team, tutorial > 0 ? 'Подача: резкий свайп к сопернику · к себе — короткая с подрезкой' : 'Ваша подача');
      else showHint(null);
    },
    swingState,
    onWindow(W) {
      if (demo || tutorial <= 0) return;
      showHint(W.hitter.team, tutorial >= 3 ? 'Держите палец на экране — это ракетка. Совместите кольца на полу'
        : tutorial === 2 ? 'Когда мяч подлетает, резко двиньте палец вперёд. Палец на месте — блок'
        : 'Куда двинете палец, туда и полетит мяч. Слишком сильно и плоско — аут');
    },
    onSwing(W, p, tag) {
      if (demo) return;
      const team = W.hitter.team;
      const dir = team === 0 ? -1 : 1;
      fx.showMarker(new THREE.Vector3(clamp(p.lateral, -1, 1) * 0.64, 0, dir * (p.kind === 'push' ? 0.6 : 0.7 + p.power * 0.55)), tag === 'perfect' ? 0x7dffb4 : TEAM_STYLE[team].color);
      const txt = { 'perfect': 'Идеально', 'early': 'Рано', 'late': 'Поздно', 'very-early': 'Слишком рано', 'very-late': 'Слишком поздно' }[tag];
      if (tag !== 'perfect') feedback(team, txt, 'miss');
    },
    onMissWindow(W, reason) {
      if (demo) return;
      feedback(W.hitter.team, reason === 'far' ? 'Мимо ракетки' : 'Нет удара — держите палец на экране', 'miss');
    },
    onTelegraph(pt, team) { if (!demo) fx.showTele(pt, TEAM_STYLE[team].color); },
    onHit(hitter, shot, q, p) {
      fx.showMarker(null);
      const speed = shot.v.length(), col = TEAM_STYLE[hitter.team].color;
      const dirZ = -hitter.side;
      const topC = shot.w.dot(new THREE.Vector3(0, 1, 0).cross(new THREE.Vector3(0, 0, dirZ)));
      const sideC = Math.abs(shot.w.y);
      // spin you can read: topspin = cyan, backspin = violet, sidespin = mint
      fx.trailColor.set(q.crit ? 0x8ff6ff : sideC > 90 ? 0x7dffb4 : topC > 230 ? 0x5ef0ff : topC < -90 ? 0xb48cff : col);
      if (!demo && hitter.human && !q.crit) {
        if (q.kind === 'loop') feedback(hitter.team, 'Топспин', 'good');
        else if (Math.abs(q.side || 0) > 0.35) feedback(hitter.team, 'Крученый', 'good');
        else if (q.kind === 'push' && topC < -200) feedback(hitter.team, 'Подрезка', 'good');
      }
      fx.trailHeat = q.crit ? 1 : clamp((speed - 8) / 18, 0, 0.6);
      fx.burst(p, q.crit ? 80 : 10, q.crit ? 0x8ff6ff : col, q.crit ? 6 : 2.2, q.crit ? 0.09 : 0.04, q.crit ? 0.9 : 0.35);
      if (q.crit) {
        fx.burst(p, 50, 0xb48cff, 4, 0.07, 1.1, 0.3);
        fx.ring(p, 0x8ff6ff, 1.5, 0.55); fx.ring(p, 0xb48cff, 0.9, 0.42);
        slowUntil = realT + 0.6; timeScale = 0.16; shake = 0.06; fovKick = 8;
        snd.boom(); world.crowd.cheer(1); flash();
        banner(q.kind === 'smash' ? 'СМЭШ!' : 'КРИТ!', 'crit', `${Math.round(speed * 3.6)} км/ч`);
        hitter.setColorBoost(1); setTimeout(() => hitter.setColorBoost(0), 900);
      } else if (q.perfect && hitter.human) { fx.ring(p, 0x7dffb4, 0.5, 0.35); feedback(hitter.team, 'Идеально', 'good'); }
      else if (q.auto && !demo) feedback(hitter.team, 'Автоблок · свайпните сами', 'miss');
      else if (q.kind === 'smash') { shake = 0.025; fx.ring(p, col, 0.6, 0.3); }
      if (!demo) { showHint(null); if (hitter.human && tutorial > 0) tutorial--; }
      if (!demo && hitter.human && q.kind === 'block') feedback(hitter.team, 'Блок', q.perfect ? 'good' : 'miss');
      if (!demo && q.charged && q.crit) banner('СУПЕРУДАР!', 'crit', `${Math.round(speed * 3.6)} км/ч`);
      updateRally();
    },
    onBounce(ev) {
      const p = new THREE.Vector3(ev.x, T.top + 0.004, ev.z);
      const hot = fx.trailHeat > 0.8;
      fx.ring(p, hot ? 0x8ff6ff : 0xdff6ff, hot ? 0.5 : 0.12, hot ? 0.5 : 0.3, true);
      if (hot) { fx.burst(p, 30, 0x8ff6ff, 3, 0.05, 0.5, 0.8); shake = Math.max(shake, 0.03); }
    },
    onNet() { if (!demo) banner('Сетка', 'miss'); },
    onLet() { if (!demo) banner('Переподача', 'info', 'мяч задел сетку'); },
    onPoint(team, reason, r) {
      updateHud(team); lastRally = 0; if ($('rally')) $('rally').hidden = true; showHint(null); fx.showMarker(null);
      fx.trailHeat *= 0.5;
      world.crowd.cheer(r.gameOver ? 1 : 0.55); snd.crowd(r.gameOver ? 1.4 : 0.7);
      if (demo || r.matchOver) return;
      if (r.gameOver) banner(`Партия · ${teamLabel(team)}`, 'big', `${match.games[0]} : ${match.games[1]} по партиям`);
      else banner(reason, 'info', `очко · ${teamLabel(team)}`);
    },
    onGameBreak() { startCine('break', 3.1); updateHud(); setTimeout(() => !demo && banner(`Партия ${match.gameNo()}`, 'big'), 1300); },
    onMatchOver(team) {
      updateHud();
      if (demo) { setTimeout(() => { if (demo && match.state === 'over') startDemo(); }, 4000); startCine('outro', 99, team); return; }
      fx.burst(new THREE.Vector3(0, 2.2, 0), 160, 0x8ff6ff, 6, 0.08, 2, 0.6);
      fx.burst(new THREE.Vector3(0, 2.2, 0), 120, 0xb48cff, 6, 0.08, 2, 0.6);
      world.crowd.cheer(1.3); snd.crowd(2.5);
      startCine('outro', 99, team);
      setTimeout(() => showOver(team), 3800);
    },
  };
}

function newMatch(c, isDemo) {
  if (match) match.dispose();
  demo = isDemo;
  const humans = isDemo ? [false, false] : [true, c.opp === 'friend'];
  match = new Match(world, fx, snd, { opp: isDemo ? 'cpu' : c.opp, diff: isDemo ? 'master' : c.diff, bestOf: isDemo ? 1 : c.bestOf, humans }, hooks(), models);
  fx.showMarker(null); showHint(null);
  updateHud();
}
function startDemo() { newMatch({ opp: 'cpu' }, true); camMode = 'orbit'; cine = null; match.begin(); }
function startGame() {
  newMatch(cfg, false);
  tutorial = 3;
  camMode = cfg.opp === 'friend' ? 'broadcast' : 'play';
  startCine('intro', 3.6);
  setTimeout(() => banner(`Партия 1`, 'big', cfg.opp === 'cpu' ? 'Вы против X-Бота' : 'Игрок 1 против Игрока 2'), 400);
}

// ------------------------------------------------------------ camera
const finite = v => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
function startCine(kind, dur, team) {
  const a0 = Math.atan2(camPos.x, camPos.z);
  cine = { kind, t0: realT, dur, team, a0 };
}
function gameplayCam(aspect) {
  const portrait = aspect < 1;
  const P = new THREE.Vector3(), L = new THREE.Vector3();
  let fov = 50; camUp.set(0, 1, 0);
  if (camMode === 'play') {
    const me = match.players[0];
    const mx = clamp(me.pos.x, -1.6, 1.6), mz = me.pos.z;
    const k = clamp((aspect - 0.5) / 0.9, 0, 1);
    P.set(mx * 0.5 + THREE.MathUtils.lerp(0.3, 0.45, k), THREE.MathUtils.lerp(3.0, 2.5, k), mz + THREE.MathUtils.lerp(1.85, 1.7, k));
    L.set(mx * 0.2, THREE.MathUtils.lerp(0.6, 0.72, k), THREE.MathUtils.lerp(-0.8, -0.85, k));
    fov = THREE.MathUtils.lerp(68, 50, k);
  } else if (camMode === 'broadcast') {
    if (portrait) { P.set(2.3, 6.0, 0); L.set(0, 0.55, 0); camUp.set(0, 0, -1); fov = 60; }
    else { P.set(4.4, 3.5, 0); L.set(0, 0.7, 0); fov = 44; }
  } else { // menu orbit
    const a = realT * 0.12;
    P.set(Math.sin(a) * 3.9, 2.6 + Math.sin(realT * 0.2) * 0.4, Math.cos(a) * (portrait ? 6.2 : 5.4)); L.set(0, 0.85, 0); fov = portrait ? 62 : 46;
  }
  return { P, L, fov };
}
function updateCamera(dt) {
  // a bad frame (NaN) must never poison the smoothed camera state
  if (!finite(camPos)) camPos.set(5, 3, 5);
  if (!finite(camLook)) camLook.set(0, 0.8, 0);
  if (!finite(camera.up) || camera.up.lengthSq() < 1e-6) camera.up.set(0, 1, 0);
  const aspect = innerWidth / innerHeight;
  let { P, L, fov } = gameplayCam(aspect);
  let k = 1 - Math.exp(-dt * 5);
  if (cine) {
    const t = (realT - cine.t0) / cine.dur, e = ease(t);
    const portrait = aspect < 1;
    if (cine.kind === 'intro') {
      // sweep around the whole court and settle behind the player
      const aEnd = Math.atan2(P.x, P.z), rEnd = Math.hypot(P.x, P.z);
      const ang = THREE.MathUtils.lerp(aEnd - Math.PI * 1.6, aEnd, e);
      const r = THREE.MathUtils.lerp(portrait ? 7.2 : 6.2, rEnd, e);
      const tgt = new THREE.Vector3(Math.sin(ang) * r, THREE.MathUtils.lerp(4.6, P.y, e) + Math.sin(Math.PI * Math.min(t, 1)) * 0.6, Math.cos(ang) * r);
      if (t > 0.85) tgt.lerp(P, Math.min(1, (t - 0.85) / 0.15));
      P = tgt; L = new THREE.Vector3(0, 0.78, 0).lerp(L, e * e); camUp.lerp(new THREE.Vector3(0, 1, 0), 1 - e);
      fov = THREE.MathUtils.lerp(portrait ? 58 : 42, fov, e);
      k = 1 - Math.exp(-dt * 9);
      if (t >= 1) { cine = null; if (match.state === 'intro') match.begin(); }
    } else if (cine.kind === 'break') {
      const a = cine.a0 + Math.sin(e * Math.PI) * 1.4 + e * 0.0;
      const r = portrait ? 5.6 : 4.6;
      P = new THREE.Vector3(Math.sin(a + e * Math.PI * 2) * r * (1 - e) + P.x * e, THREE.MathUtils.lerp(3.2, P.y, e), Math.cos(a + e * Math.PI * 2) * r * (1 - e) + P.z * e);
      L = new THREE.Vector3(0, 0.8, 0).lerp(L, e);
      k = 1 - Math.exp(-dt * 6);
      if (t >= 1) cine = null;
    } else if (cine.kind === 'fixed') {
      P = cine.P.clone(); L = cine.L.clone(); camUp.set(0, 1, 0); fov = cine.fov || 30; k = 1;
    } else if (cine.kind === 'outro') {
      // slow victory orbit around the winner, then rise over the whole court
      const w = match.players[cine.team ?? 0];
      const tt = realT - cine.t0;
      const a = cine.a0 + tt * 0.45;
      const rise = ease((tt - 5) / 4);
      const r = THREE.MathUtils.lerp(2.4, portrait ? 6.5 : 5.2, rise);
      const c = new THREE.Vector3(w.pos.x, 1.1, w.pos.z).lerp(new THREE.Vector3(0, 0.8, 0), rise);
      P = new THREE.Vector3(c.x + Math.sin(a) * r, THREE.MathUtils.lerp(1.45, 4, rise) + Math.sin(tt * 0.7) * 0.15, c.z + Math.cos(a) * r);
      L = c; camUp.set(0, 1, 0); fov = portrait ? 60 : 45;
      k = 1 - Math.exp(-dt * 3);
    }
  }
  if (!finite(P) || !finite(L) || !Number.isFinite(k)) { window.__camNaN = { P: P.toArray(), L: L.toArray(), k, cine: cine && cine.kind, mode: camMode }; return; }
  camPos.lerp(P, k); camLook.lerp(L, k);
  camera.up.lerp(camUp, k).normalize();
  camera.position.copy(camPos);
  if (shake > 0) {
    camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake;
    shake = Math.max(0, shake - dt * 0.15);
  }
  camera.lookAt(camLook);
  fovKick = Math.max(0, fovKick - dt * 14);
  const f = fov - fovKick;
  if (Math.abs(camera.fov - f) > 0.01) { camera.fov = f; camera.updateProjectionMatrix(); fx.setPointScale(renderer.domElement.height, f); }
}

// ------------------------------------------------------------ input
// The finger is the racket: its left/right position places the racket (the player runs to
// keep up), and how it is moving when the ball arrives decides the stroke.
const swipeCv = $('swipe'), sctx = swipeCv.getContext('2d');
const touches = new Map(), fading = [];
const trails = [[], []], lifted = [0, 0];
const toScreen = v => { const p = v.clone().project(camera); return new THREE.Vector2((p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight); };
function teamBasis(team) {
  const own = new THREE.Vector3(0, T.top, team === 0 ? T.halfL : -T.halfL);
  const opp = new THREE.Vector3(0, T.top, -own.z);
  const a = toScreen(own), b = toScreen(opp);
  const f = b.clone().sub(a).normalize();
  const line = (team === 0 ? 1 : -1) * (T.halfL + 0.6);
  const xa = toScreen(new THREE.Vector3(-1, 0.9, line)), xb = toScreen(new THREE.Vector3(1, 0.9, line));
  const xs = xb.clone().sub(xa).normalize();
  const r = team === 0 ? xs.clone() : xs.clone().negate();
  return { f, r, xs };
}
function duo() { return cfg.opp === 'friend' && !demo; }
function teamForPoint(x, y) {
  if (!duo()) return 0;
  const portrait = innerWidth < innerHeight;
  const u = portrait ? y / innerHeight : x / innerWidth;
  if (Math.abs(u - 0.5) < 0.04) return -1;
  return portrait ? (u > 0.5 ? 0 : 1) : (u < 0.5 ? 0 : 1);
}
// absolute mapping: the width of your half spans the court from -1.3 m to +1.3 m
function fingerToCourtX(team, x, y) {
  const B = teamBasis(team);
  if (!Number.isFinite(B.xs.x) || B.xs.lengthSq() < 0.5) return null;
  const horiz = Math.abs(B.xs.x) >= Math.abs(B.xs.y);
  const half = horiz ? innerWidth / 2 : innerHeight / 2;
  const u = horiz ? (x - innerWidth / 2) * Math.sign(B.xs.x) : (y - innerHeight / 2) * Math.sign(B.xs.y);
  return clamp(u / (half * 0.85), -1, 1) * 1.3;
}
const humanPlayer = team => match && !demo ? match.players[team] : null;

// Finger motion over the last ~140 ms, in screen-heights per second.
function swingState(team) {
  const tr = trails[team], now = performance.now();
  // touching: the finger is on the screen (or left it a moment ago) — you are holding the racket
  const out = { fwd: 0, back: 0, lat: 0, curve: 0, wind: false, touching: isDown(team) || now - lifted[team] < 160 };
  if (!tr.length || now - lifted[team] > 160 && !isDown(team)) return out;
  const B = teamBasis(team), norm = Math.min(innerWidth, innerHeight);
  const at = dt => { const t = now - dt; let best = tr[0]; for (const p of tr) if (p.t <= t) best = p; return best; };
  const p2 = tr[tr.length - 1];
  if (now - p2.t > 90) return out;               // finger resting: a block
  const p1 = at(70), p0 = at(140);
  const seg = (a, b) => {
    const dt = Math.max(0.016, (b.t - a.t) / 1000);
    const dx = b.x - a.x, dy = b.y - a.y;
    return { f: (dx * B.f.x + dy * B.f.y) / dt / norm, l: (dx * B.r.x + dy * B.r.y) / dt / norm };
  };
  const s1 = seg(p0, p1), s2 = seg(p1, p2);
  const fast = s2.f >= s1.f ? s2 : s1;
  out.fwd = Math.max(0, fast.f); out.back = Math.max(0, -Math.min(s1.f, s2.f)); out.lat = fast.l;
  // the stroke bends: sideways speed changes during the push
  out.curve = out.fwd > 0.7 ? clamp((s2.l - s1.l) / Math.max(1, out.fwd) * 1.6, -1, 1) : 0;
  // a short pull back right before the push = brushing low-to-high (topspin loop)
  const e0 = at(340), e1 = at(200);
  const early = seg(e0, e1);
  out.wind = out.fwd > 0.9 && early.f < -0.35 && e1 !== e0;
  return out;
}
function isDown(team) { for (const tr of touches.values()) if (tr.team === team) return true; return false; }

function flickParams(tr) {
  const pts = tr.pts, e = pts[pts.length - 1];
  let i = pts.length - 1;
  while (i > 0 && e.t - pts[i - 1].t <= 180) i--;
  const s = pts[i];
  const B = teamBasis(tr.team);
  const vec = new THREE.Vector2(e.x - s.x, e.y - s.y);
  const len = vec.length(), norm = Math.min(innerWidth, innerHeight);
  const dur = Math.max(0.03, (e.t - s.t) / 1000);
  const f = vec.dot(B.f), l = vec.dot(B.r);
  if (len < 24) return null;
  // curvature: how far the path bows away from its chord, signed toward the player's right
  let bow = 0;
  const n = new THREE.Vector2(-vec.y / len, vec.x / len);
  for (let k = i; k < pts.length; k++) { const d = (pts[k].x - s.x) * n.x + (pts[k].y - s.y) * n.y; if (Math.abs(d) > Math.abs(bow)) bow = d; }
  const side = clamp(-bow / len * (Math.sign(n.dot(B.r)) || 1) * 4, -1, 1);
  if (f < -len * 0.5) return { kind: 'push', lateral: clamp(Math.atan2(l, -f) / 0.5, -1, 1), power: 0.3, side };
  if (f < len * 0.4) return null;
  return { kind: 'drive', lateral: clamp(Math.atan2(l, f) / 0.5, -1, 1), power: clamp(0.45 * (len / norm) / 0.32 + 0.55 * (len / dur / norm) / 3.2, 0, 1), side };
}

function pushSample(team, x, y, t) {
  const tr = trails[team];
  tr.push({ x, y, t });
  while (tr.length > 2 && t - tr[0].t > 400) tr.shift();
  const p = humanPlayer(team); if (!p) return;
  const cx = fingerToCourtX(team, x, y);
  if (cx != null && Number.isFinite(cx)) p.ctrlX = cx;
}
canvas.addEventListener('pointerdown', e => {
  snd.unlock();
  if (demo || paused || !match || cine) return;
  const team = teamForPoint(e.clientX, e.clientY);
  if (team < 0 || isDown(team)) return;          // one finger per player
  canvas.setPointerCapture?.(e.pointerId);
  const t = performance.now();
  trails[team].length = 0;
  touches.set(e.pointerId, { team, pts: [{ x: e.clientX, y: e.clientY, t }] });
  pushSample(team, e.clientX, e.clientY, t);
});
canvas.addEventListener('pointermove', e => {
  const tr = touches.get(e.pointerId); if (!tr) return;
  const t = performance.now();
  tr.pts.push({ x: e.clientX, y: e.clientY, t });
  if (tr.pts.length > 80) tr.pts.splice(1, 1);
  pushSample(tr.team, e.clientX, e.clientY, t);
});
const endTouch = e => {
  const tr = touches.get(e.pointerId); if (!tr) return;
  touches.delete(e.pointerId);
  const t = performance.now();
  tr.pts.push({ x: e.clientX, y: e.clientY, t });
  pushSample(tr.team, e.clientX, e.clientY, t);
  lifted[tr.team] = t;
  tr.fade = 1; fading.push(tr);
  if (!match || demo || paused) return;
  // serving: a flick toward the opponent is a long serve, a tap or pull-back is a short one
  if (match.state === 'serve' && match.server.team === tr.team && match.server.human) {
    const fp = flickParams(tr) || { kind: 'push', lateral: 0, power: 0.3, side: 0 };
    match.humanStroke(tr.team, fp);
  }
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

function drawSwipes(dt) {
  const dpr = Math.min(devicePixelRatio, 2);
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.clearRect(0, 0, innerWidth, innerHeight);
  for (const tr of [...touches.values(), ...fading]) {
    const a = tr.fade ?? 1, col = tr.team === 0 ? '94,240,255' : '201,162,255';
    sctx.lineCap = 'round'; sctx.lineJoin = 'round';
    for (const [w, al] of [[18, 0.12], [7, 0.5], [2.5, 0.95]]) {
      sctx.strokeStyle = `rgba(${col},${al * a})`; sctx.lineWidth = w;
      sctx.beginPath(); tr.pts.forEach((p, i) => i ? sctx.lineTo(p.x, p.y) : sctx.moveTo(p.x, p.y)); sctx.stroke();
    }
  }
  for (let i = fading.length - 1; i >= 0; i--) { fading[i].fade -= dt * 3; if (fading[i].fade <= 0) fading.splice(i, 1); }
}

// ------------------------------------------------------------ HUD
function updateHud(pointTeam) {
  if (!match) return;
  const st = match.serverTeam();
  for (const t of [0, 1]) {
    $(`n${t}`).textContent = teamLabel(t);
    $(`c${t}`).textContent = match.players[t].name;
    $(`p${t}`).textContent = match.score[t];
    $(`g${t}`).textContent = match.games[t];
    $(`s${t}`).hidden = st !== t || match.state === 'over';
    if (pointTeam === t) { const el = $(`p${t}`); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  }
  $('hud').hidden = demo;
  document.body.classList.toggle('duo', !demo && cfg.opp === 'friend');
  drawBoards();
}
function drawBoards() {
  const { canvas: c, tex } = world.scoreboard, g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, c.height);
  grd.addColorStop(0, '#0b1734'); grd.addColorStop(1, '#050a18');
  g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(94,240,255,0.5)'; g.lineWidth = 4; g.strokeRect(8, 8, c.width - 16, c.height - 16);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 34px Unbounded, Arial Black, sans-serif'; g.fillStyle = '#8fa6d8';
  g.fillText(demo ? 'ВЫСТАВОЧНЫЙ МАТЧ' : `ПАРТИЯ ${match.gameNo()}`, 512, 56);
  for (const t of [0, 1]) {
    const x = t === 0 ? 270 : 754;
    g.fillStyle = TEAM_STYLE[t].color; g.font = '800 150px Unbounded, Arial Black, sans-serif';
    g.fillText(String(match.score[t]), x, 210);
    g.font = '600 30px Manrope, Arial, sans-serif'; g.fillStyle = '#dbe6ff';
    g.fillText(match.players[t].name, x, 325);
  }
  g.fillStyle = '#dbe6ff'; g.font = '800 54px Unbounded, Arial Black, sans-serif';
  g.fillText(`${match.games[0]}:${match.games[1]}`, 512, 210);
  tex.needsUpdate = true;
  // umpire flip board
  const f = world.flip, h = f.canvas.getContext('2d');
  h.fillStyle = '#0a0f1e'; h.fillRect(0, 0, 512, 256);
  for (const t of [0, 1]) {
    const x = 18 + t * 252;
    h.fillStyle = '#f2f5fb'; h.fillRect(x, 20, 224, 216);
    h.fillStyle = 'rgba(0,0,0,.25)'; h.fillRect(x, 126, 224, 4);
    h.fillStyle = t === 0 ? '#0c6b8a' : '#5b3cc4'; h.font = '800 150px Unbounded, Arial Black, sans-serif';
    h.textAlign = 'center'; h.textBaseline = 'middle'; h.fillText(String(match.score[t]), x + 112, 134);
  }
  f.tex.needsUpdate = true;
}
let bannerTimer = 0;
function banner(text, kind = 'info', sub = '') {
  const b = $('banner');
  b.className = ''; void b.offsetWidth;
  b.querySelector('.bt').textContent = text; b.querySelector('.bs').textContent = sub;
  b.className = `show ${kind}`;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.className = '', kind === 'crit' ? 1500 : 1200);
}
function flash() { const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
let tutorial = 3;
let lastRally = 0;
function updateRally() {
  const n = match ? match.rallyHits : 0, el = $('rally');
  if (!el) return;
  el.hidden = demo || n < 3;
  if (n !== lastRally && n >= 3) {
    el.querySelector('b').textContent = n;
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    el.dataset.heat = n >= 15 ? '3' : n >= 9 ? '2' : '1';
    if (n % 5 === 0) { world.crowd.cheer(0.5 + Math.min(n, 20) / 40); snd.crowd(0.5 + Math.min(n, 20) / 30); }
  }
  lastRally = n;
  for (const t of [0, 1]) {
    const c = match ? match.charge[t] : 0, pips = $('q' + t);
    if (!pips) continue;
    pips.hidden = demo || !match.players[t].human;
    pips.dataset.n = c; pips.classList.toggle('full', c >= CHARGE_MAX);
  }
}
const fbTimers = [0, 0];
// short result text: centre banner vs the computer, the player's own half when two play
function feedback(team, text, kind) {
  if (!duo()) { banner(text, kind); return; }
  const h = $('hint' + team);
  h.hidden = false; h.textContent = text; h.dataset.kind = kind;
  clearTimeout(fbTimers[team]); fbTimers[team] = setTimeout(() => { h.hidden = true; }, 900);
}
function showHint(team, text) {
  for (const t of [0, 1]) {
    const h = $(`hint${t}`), show = !!text && team === t;
    h.hidden = !show; if (show) h.textContent = text;
  }
}

// ------------------------------------------------------------ menu / screens
function bindSeg(id, key, parse = v => v) {
  const el = $(id);
  const sync = () => el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(parse(b.dataset.v) === cfg[key])));
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    cfg[key] = parse(b.dataset.v); saveCfg(); sync(); snd.unlock(); snd.ui();
    $('diffRow').hidden = cfg.opp !== 'cpu';
  });
  sync();
}
bindSeg('segOpp', 'opp');
bindSeg('segDiff', 'diff');
bindSeg('segBest', 'bestOf', v => +v);
$('diffRow').hidden = cfg.opp !== 'cpu';
function screen(name) {
  for (const s of ['menu', 'how', 'pause', 'over']) $(s).hidden = s !== name;
  document.body.classList.toggle('ingame', !name);
}
$('play').onclick = () => {
  if (!models) return;
  snd.unlock(); snd.on = cfg.sound; snd.ui();
  screen(null); paused = false; startGame();
  try { navigator.wakeLock?.request('screen').catch(() => {}); } catch (e) {}
};
$('howBtn').onclick = () => { snd.unlock(); snd.ui(); screen('how'); };
$('howBack').onclick = () => screen('menu');
$('pauseBtn').onclick = () => { paused = true; screen('pause'); syncPause(); };
$('resume').onclick = () => { paused = false; screen(null); };
$('toMenu').onclick = () => { paused = false; screen('menu'); startDemo(); };
$('again').onclick = () => { screen(null); startGame(); };
$('overMenu').onclick = () => { screen('menu'); startDemo(); };
$('soundBtn').onclick = () => { cfg.sound = !cfg.sound; snd.on = cfg.sound; saveCfg(); syncPause(); };
function syncPause() { $('soundBtn').textContent = cfg.sound ? 'Звук: вкл' : 'Звук: выкл'; }
function showOver(team) {
  const vsCpu = cfg.opp === 'cpu';
  $('overTitle').textContent = vsCpu ? (team === 0 ? 'Победа' : 'Поражение') : `Победил ${teamLabel(team)}`;
  $('overScore').textContent = `${match.games[0]} : ${match.games[1]}`;
  $('overNames').textContent = `${match.players[0].name} против ${match.players[1].name}`;
  screen('over');
}

// ------------------------------------------------------------ loop
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  const pr = renderer.getPixelRatio();
  composer.setPixelRatio(pr); composer.setSize(w, h);
  bloom.resolution.set(w * pr * 0.5, h * pr * 0.5);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const dpr = Math.min(devicePixelRatio, 2);
  swipeCv.width = w * dpr; swipeCv.height = h * dpr;
  fx.setPointScale(renderer.domElement.height, camera.fov);
}
addEventListener('resize', resize); resize();

let last = performance.now();
function frame(nowMs) {
  requestAnimationFrame(frame);
  const rdt = Math.min(0.05, (nowMs - last) / 1000); last = nowMs;
  tick(rdt);
}
let liveFrozen = false;   // debug: stop the live loop so stepped frames can be inspected
function tick(rdt, draw = true, forced = false) {
  if (liveFrozen && !forced) { composer.render(0); return; }
  realT += rdt;
  // the whole match runs a touch slower than real time: easier to read, still real physics
  const base = demo ? 1 : GAME_SPEED;
  if (realT > slowUntil) timeScale += (base - timeScale) * (1 - Math.exp(-rdt * 6));
  const dt = paused ? 0 : rdt * timeScale;
  if (match && !paused) {
    match.update(dt);
    fx.setBall(match.ball.p, match.ball.w, dt);
    fx.ball.visible = match.state !== 'intro';
    if (match.inFlight && match.state !== 'serve') fx.pushTrail(match.ball.p, fx.trailHeat);
    const W = match.window;
    if (W && !demo && !W.missed) {
      const left = W.tIdeal - match.now, total = Math.max(0.2, W.tIdeal - W.t0);
      // ring shrinks over the ball's whole flight, so fast balls get a full countdown too
      fx.timing.visible = left > -0.02;
      fx.timing.position.copy(match.ball.p);
      fx.timing.scale.setScalar(0.06 + clamp(left / total, 0, 1) * 0.55);
      const inP = Math.abs(left) <= W.win.P, inG = Math.abs(left) <= W.win.G;
      fx.timing.material.color.set(inP ? 0x7dffb4 : inG ? 0x8ff6ff : 0xffffff);
      fx.timing.material.opacity = inG ? 1 : 0.6;
      const h = W.hitter, cov = match.coverage(h, W.C.x, W.v);
      const lineZ = h.side * (T.halfL + 0.45);
      fx.showReach(new THREE.Vector3(match.racketX(h), 0, lineZ), cov.zone === 'sweet' ? 0x7dffb4 : cov.zone === 'hit' ? 0x8ff6ff : 0x8a93b8, cov.R);
      fx.showSpot(new THREE.Vector3(W.C.x, 0, lineZ));
    } else { fx.timing.visible = false; fx.showReach(null); fx.showSpot(null); }
  }
  world.crowd.update(realT, rdt);
  fx.update(dt || rdt * 0.2, camera, realT);
  updateCamera(rdt);
  if (!draw) return;
  drawSwipes(rdt);
  composer.render(rdt);
}

// debug handle for automated checks
window.__game = { get match() { return match; }, fx, camera, get camMode() { return camMode; }, get cine() { return cine; },
  photo(P, L, fov) { cine = { kind: 'fixed', P: new THREE.Vector3(...P), L: new THREE.Vector3(...L), fov, t0: realT, dur: 1e9 }; },
  step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) tick(dt, i === n - 1, true); },
  freeze(v = true) { liveFrozen = v; } };
screen('menu');
requestAnimationFrame(frame);
loadModels().then(m => {
  models = m;
  startDemo();
  $('loading').hidden = true;
  $('play').disabled = false;
}).catch(err => {
  $('loading').textContent = 'Не удалось загрузить модели: ' + err.message;
  console.error(err);
});
