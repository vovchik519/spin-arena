// Ball physics: gravity, quadratic drag, Magnus force, spin-aware bounces.
// Units: metres, seconds, radians. Table centred at origin, length along Z.
import * as THREE from 'three';

export const T = {
  halfL: 1.37, halfW: 0.7625, top: 0.76, thick: 0.03,
  netH: 0.1525, netHalfW: 0.9125,
};
export const BALL_R = 0.02;
const G = 9.81;
const MASS = 0.0027;
const KD = 0.5 * 1.2 * 0.5 * Math.PI * BALL_R * BALL_R / MASS;   // drag  ~0.14 1/m
const KM = 0.5 * 1.2 * Math.PI * BALL_R * BALL_R * BALL_R / MASS; // Magnus ~0.0056
const E_TABLE = 0.9, MU_TABLE = 0.25;
const E_FLOOR = 0.72, MU_FLOOR = 0.4;
export const DT = 1 / 600;

const _a = new THREE.Vector3(), _m = new THREE.Vector3(), _vc = new THREE.Vector3();
const _r = new THREE.Vector3(), _j = new THREE.Vector3(), _t = new THREE.Vector3();

export class BallState {
  constructor() {
    this.p = new THREE.Vector3(0, 1, 0);
    this.v = new THREE.Vector3();
    this.w = new THREE.Vector3();   // angular velocity
  }
  copy(o) { this.p.copy(o.p); this.v.copy(o.v); this.w.copy(o.w); return this; }
  clone() { return new BallState().copy(this); }
}

// Contact with a horizontal surface: restitution + friction that can turn spin into
// a kick (topspin jumps forward, backspin checks up). Ball treated as a hollow sphere.
function bounce(s, e, mu) {
  const vn = s.v.y;
  if (vn >= 0) return 0;
  const Jn = -(1 + e) * vn;                       // per unit mass
  _r.set(0, -BALL_R, 0);
  _vc.crossVectors(s.w, _r).add(s.v); _vc.y = 0;  // contact-point slip velocity
  const slip = _vc.length();
  s.v.y = -e * vn;
  if (slip > 1e-6) {
    const jt = Math.min(mu * Jn, slip / 2.5);     // 2.5 = 1 + m r^2 / I
    _j.copy(_vc).multiplyScalar(-jt / slip);
    s.v.add(_j);
    // dw = (r x J) / I, I = 2/3 m r^2
    _t.crossVectors(_r, _j).multiplyScalar(1.5 / (BALL_R * BALL_R));
    s.w.add(_t);
  }
  return -vn;
}

// One integration step. Returns an event or null.
// Events: {type:'table', side:+1|-1, x, z, speed} | {type:'net'} | {type:'floor'}
export function step(s, dt, netCheck = true, collide = true) {
  const sp = s.v.length();
  _a.set(0, -G, 0);
  _a.addScaledVector(s.v, -KD * sp);
  _m.crossVectors(s.w, s.v).multiplyScalar(KM);
  _a.add(_m);
  const pz = s.p.z, py = s.p.y;
  s.v.addScaledVector(_a, dt);
  s.p.addScaledVector(s.v, dt);
  s.w.multiplyScalar(1 - 0.08 * dt);
  if (!collide) return null;

  // net (plane z = 0)
  if (netCheck && (pz > 0) !== (s.p.z > 0) && Math.abs(s.p.x) < T.netHalfW) {
    const netTop = T.top + T.netH;
    if (s.p.y - BALL_R < netTop && s.p.y > T.top) {
      const cord = s.p.y > netTop - BALL_R * 0.2;
      if (cord) {           // clips the tape and trickles over
        s.v.z *= 0.45; s.v.y = Math.abs(s.v.y) * 0.3 + 0.6; s.v.x *= 0.7;
        s.w.multiplyScalar(0.4);
        return { type: 'netcord', x: s.p.x, y: s.p.y };
      }
      s.p.z = pz > 0 ? 0.012 : -0.012;
      s.v.z *= -0.12; s.v.x *= 0.5; s.v.y *= 0.4;
      s.w.multiplyScalar(0.3);
      return { type: 'net', x: s.p.x, y: s.p.y };
    }
  }
  // table top
  if (s.v.y < 0 && s.p.y - BALL_R <= T.top && py - BALL_R > T.top - 0.02 &&
      Math.abs(s.p.x) <= T.halfW + BALL_R * 0.5 && Math.abs(s.p.z) <= T.halfL + BALL_R * 0.5) {
    s.p.y = T.top + BALL_R;
    const speed = bounce(s, E_TABLE, MU_TABLE);
    return { type: 'table', side: s.p.z > 0 ? 1 : -1, x: s.p.x, z: s.p.z, speed };
  }
  // floor
  if (s.v.y < 0 && s.p.y - BALL_R <= 0) {
    s.p.y = BALL_R;
    const speed = bounce(s, E_FLOOR, MU_FLOOR);
    if (Math.abs(s.v.y) < 0.15) { s.v.y = 0; s.v.multiplyScalar(0.98); }
    return { type: 'floor', speed };
  }
  return null;
}

// Fly a ballistic arc (no collisions) until it comes down to table height on the far
// half. Returns landing point and the height the ball had when crossing the net.
function flyToLanding(p0, v0, w0, dir) {
  const s = _sim; s.p.copy(p0); s.v.copy(v0); s.w.copy(w0);
  let netY = null, prevZ = s.p.z;
  for (let i = 0; i < 2400; i++) {
    step(s, DT, false, false);
    if (netY === null && (prevZ * dir < 0) && (s.p.z * dir >= 0)) netY = s.p.y;
    prevZ = s.p.z;
    if (s.v.y < 0 && s.p.y <= T.top + BALL_R && s.p.z * dir > 0) {
      return { x: s.p.x, z: s.p.z, netY: netY ?? s.p.y, t: i * DT };
    }
    if (s.p.y < 0) break;
  }
  return null;
}
const _sim = new BallState();

// Solve the launch velocity that lands the ball on `target` (x,z on the far half),
// with horizontal speed `hs` and spin `w`. Lowers speed until the net is cleared.
export function solveShot(p0, target, hs, w, minClear = 0.03) {
  const dir = Math.sign(target.z - p0.z) || -1;
  const aim = new THREE.Vector3();
  const v = new THREE.Vector3();
  let best = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    aim.set(target.x, T.top + BALL_R, target.z);
    let land = null;
    for (let it = 0; it < 10; it++) {
      const dx = aim.x - p0.x, dz = aim.z - p0.z;
      const dist = Math.hypot(dx, dz);
      const t = Math.max(dist / hs, 0.08);
      v.set(dx / t, (aim.y - p0.y + 0.5 * G * t * t) / t, dz / t);
      land = flyToLanding(p0, v, w, dir);
      if (!land) break;
      const ex = target.x - land.x, ez = target.z - land.z;
      if (ex * ex + ez * ez < 1e-4) break;
      aim.x += ex; aim.z += ez * 0.9;
    }
    if (land) {
      best = v.clone();
      if (land.netY - BALL_R - (T.top + T.netH) >= minClear) return best;
    }
    hs *= 0.86;
  }
  return best ?? v.clone();
}

// Serve: ball must bounce once on the server's half, then land on `target`.
export function solveServe(p0, target, hs, w, firstXSign = 0) {
  const dir = Math.sign(target.z - p0.z);
  const first = new THREE.Vector3(
    firstXSign ? firstXSign * 0.3 : p0.x + (target.x - p0.x) * 0.25, T.top + BALL_R, p0.z + dir * 0.45);
  const v = new THREE.Vector3();
  const s = _sim;
  for (let attempt = 0; attempt < 6; attempt++) {
    let ok = false, reached = false;
    for (let it = 0; it < 14; it++) {
      const dx = first.x - p0.x, dz = first.z - p0.z;
      const t = Math.max(Math.hypot(dx, dz) / hs, 0.06);
      v.set(dx / t, (first.y - p0.y + 0.5 * G * t * t) / t, dz / t);
      s.p.copy(p0); s.v.copy(v); s.w.copy(w);
      let bounces = 0, land = null, netOk = true;
      for (let i = 0; i < 2400; i++) {
        const ev = step(s, DT, true);
        if (ev) {
          if (ev.type === 'net' || ev.type === 'netcord') { netOk = false; }
          if (ev.type === 'table') { bounces++; if (bounces === 2) { land = ev; break; } }
          if (ev.type === 'floor') break;
        }
      }
      if (!land) { first.z += dir * 0.06; continue; }
      reached = true;
      const ex = target.x - land.x, ez = target.z - land.z;
      if (ex * ex + ez * ez < 4e-4 && netOk) { ok = true; break; }
      first.x += ex * 0.3; first.z += ez * 0.3;
      if (firstXSign) first.x = firstXSign > 0 ? Math.max(first.x, 0.1) : Math.min(first.x, -0.1);
      first.x = THREE.MathUtils.clamp(first.x, -T.halfW + 0.05, T.halfW - 0.05);
      first.z = dir < 0 ? THREE.MathUtils.clamp(first.z, 0.15, T.halfL - 0.05)
                        : THREE.MathUtils.clamp(first.z, -T.halfL + 0.05, -0.15);
    }
    if (ok) return v.clone();
    hs *= reached ? 0.92 : 1.12;
  }
  return v.clone();
}

// Spin vectors: topspin rolls the top of the ball forward along `d`.
export function spinVector(d, top, side) {
  const h = new THREE.Vector3(d.x, 0, d.z).normalize();
  const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), h);
  return axis.multiplyScalar(top).add(new THREE.Vector3(0, side, 0));
}

// Predict a trajectory with collisions; collects samples + events.
export function predict(state, maxT = 2.5) {
  const s = state.clone();
  const out = { samples: [], events: [] };
  const n = Math.floor(maxT / DT);
  for (let i = 0; i < n; i++) {
    const ev = step(s, DT, true);
    if (i % 4 === 0) out.samples.push({ t: i * DT, p: s.p.clone(), v: s.v.clone(), w: s.w.clone() });
    if (ev) { ev.t = i * DT; out.events.push(ev); if (ev.type === 'floor') break; }
  }
  return out;
}

// Does a launch land legally? Rally shot: first table contact on the far half.
// Serve: first on the server's half, second on the far half. dir = sign of the far half.
export function landsLegally(p0, v, w, dir, serve = false) {
  const s = _chk; s.p.copy(p0); s.v.copy(v); s.w.copy(w);
  let n = 0;
  for (let i = 0; i < 2400; i++) {
    const ev = step(s, DT, true);
    if (!ev) continue;
    if (ev.type === 'net') return false;
    if (ev.type === 'floor') return false;
    if (ev.type === 'table') {
      n++;
      const far = ev.side === dir;
      if (!serve) return far;
      if (n === 1 && far) return false;
      if (n === 2) return far;
    }
  }
  return false;
}
const _chk = new BallState();
