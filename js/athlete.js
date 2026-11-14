// Rigged athletes: skinned glTF characters (Mixamo skeleton) posed every frame by
// procedural IK. The racket blade follows a swing curve that passes through the
// contact point at contact time; the arm is solved to hold it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { T } from './physics.js';

const UP = new THREE.Vector3(0, 1, 0);
const F0 = new THREE.Vector3(0, 0, 1);
const clamp = THREE.MathUtils.clamp;
const ease = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
const RK = 1.12;                       // racket scale (slightly oversized so it reads on phones)
const GRIP_TO_BLADE = 0.165 * RK;

// scratch
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), q3 = new THREE.Quaternion();
const m4 = new THREE.Matrix4();

// ------------------------------------------------------------ loading
function b64ToBuffer(s) {
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
export async function loadModels() {
  const loader = new GLTFLoader();
  const [m1, m2, xm] = await Promise.all([import('../models/michelle-1.js'), import('../models/michelle-2.js'), import('../models/xbot.js')]);
  const mm = { default: m1.default + m2.default };
  const [m, x] = await Promise.all([
    loader.parseAsync(b64ToBuffer(mm.default), ''),
    loader.parseAsync(b64ToBuffer(xm.default), ''),
  ]);
  return { human: m.scene, robot: x.scene, humanTex: findMap(m.scene) };
}
function findMap(root) { let t = null; root.traverse(n => { if (n.isMesh && n.material.map) t = n.material.map; }); return t; }

// Recolour the outfit (yellow + red panels in the source texture) into team colours; skin stays.
const texCache = new Map();
function teamTexture(src, hueMain, hueAccent) {
  const key = hueMain + ':' + hueAccent;
  if (texCache.has(key)) return texCache.get(key);
  const img = src.image;
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
  const col = new THREE.Color(), hsl = {};
  for (let i = 0; i < p.length; i += 4) {
    col.setRGB(p[i] / 255, p[i + 1] / 255, p[i + 2] / 255, THREE.SRGBColorSpace);
    col.getHSL(hsl, THREE.SRGBColorSpace);
    const h = hsl.h * 360;
    if (h > 38 && h < 70 && hsl.s > 0.45 && hsl.l > 0.35) {          // yellow panels
      col.setHSL(hueMain / 360, Math.min(1, hsl.s * 0.95), hsl.l * 0.62, THREE.SRGBColorSpace);
    } else if ((h < 14 || h > 340) && hsl.s > 0.6 && hsl.l > 0.28) {  // red accents
      col.setHSL(hueAccent / 360, hsl.s, Math.min(0.75, hsl.l * 1.1), THREE.SRGBColorSpace);
    } else continue;
    col.getRGB(col, THREE.SRGBColorSpace);
    p[i] = col.r * 255; p[i + 1] = col.g * 255; p[i + 2] = col.b * 255;
  }
  g.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.flipY = src.flipY; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  t.wrapS = src.wrapS; t.wrapT = src.wrapT;
  texCache.set(key, t);
  return t;
}

export function makeRacket() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0xc89b62, roughness: 0.55 });
  const flare = new THREE.LatheGeometry([[0.0, 0], [0.016, 0], [0.0145, 0.03], [0.0135, 0.07], [0.0155, 0.1], [0.0, 0.1]].map(p => new THREE.Vector2(...p)), 16);
  const handle = new THREE.Mesh(flare, wood); handle.scale.z = 0.72; g.add(handle);
  const bladeGeo = new THREE.CylinderGeometry(0.076, 0.076, 0.006, 40); bladeGeo.rotateX(Math.PI / 2);
  const blade = new THREE.Mesh(bladeGeo, wood); blade.position.y = 0.165; blade.scale.x = 0.94; g.add(blade);
  const rubGeo = new THREE.CylinderGeometry(0.0745, 0.0745, 0.0022, 40); rubGeo.rotateX(Math.PI / 2);
  const red = new THREE.Mesh(rubGeo, new THREE.MeshPhysicalMaterial({ color: 0xd0122f, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.6 }));
  red.position.set(0, 0.165, 0.0042); red.scale.x = 0.94; g.add(red);
  const black = new THREE.Mesh(rubGeo, new THREE.MeshPhysicalMaterial({ color: 0x101216, roughness: 0.5, clearcoat: 0.3 }));
  black.position.set(0, 0.165, -0.0042); black.scale.x = 0.94; g.add(black);
  const edge = new THREE.Mesh(new THREE.TorusGeometry(0.0758, 0.0035, 6, 48), new THREE.MeshStandardMaterial({ color: 0x1a2a55, roughness: 0.4, metalness: 0.3 }));
  edge.position.y = 0.165; edge.scale.x = 0.94; g.add(edge);
  g.scale.setScalar(RK);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function basisQ(a, b, out) {      // rotation of the frame (a, b⊥, a×b)
  v4.copy(b).addScaledVector(a, -b.dot(a)).normalize();
  v3.crossVectors(a, v4);
  m4.makeBasis(a, v4, v3);
  return out.setFromRotationMatrix(m4);
}
function setWorldQ(bone, q) {
  bone.parent.getWorldQuaternion(q3);
  bone.quaternion.copy(q3.invert().multiply(q));
  bone.updateMatrixWorld(true);
}
function ik(root, target, la, lb, pole, outMid, outEnd) {
  const d0 = v1.subVectors(target, root);
  let d = d0.length();
  const dir = d0.normalize();
  d = clamp(d, Math.abs(la - lb) + 0.02, la + lb - 0.004);
  outEnd.copy(root).addScaledVector(dir, d);
  const cosA = clamp((la * la + d * d - lb * lb) / (2 * la * d), -1, 1);
  const along = la * cosA, h = la * Math.sqrt(1 - cosA * cosA);
  const bend = v2.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (bend.lengthSq() < 1e-6) bend.set(0, -1, 0);
  bend.normalize();
  outMid.copy(root).addScaledVector(dir, along).addScaledVector(bend, h);
}

const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];

export class Athlete {
  constructor(scene, o, models) {
    this.team = o.team; this.name = o.name; this.handed = 1; this.robot = !!o.robot;
    this.fwd = new THREE.Vector3(0, 0, o.team === 0 ? -1 : 1);
    this.right = new THREE.Vector3().crossVectors(this.fwd, UP);
    this.rs = this.right.clone();
    this.side = o.team === 0 ? 1 : -1;
    this.yaw = o.team === 0 ? Math.PI : 0;
    this.pos = new THREE.Vector3(0, 0, this.side * 2.3);
    this.vel = new THREE.Vector3(); this.goal = this.pos.clone();
    this.maxSpeed = o.maxSpeed ?? 5;
    this.swing = null; this.pose = 'ready'; this.poseT = 0;
    this.lean = 0.25; this.hold = false; this.tossT = -1; this._reach = 0;

    // ---- model
    const inner = SkeletonUtils.clone(this.robot ? models.robot : models.human);
    const root = this.group = new THREE.Group();
    root.add(inner); scene.add(root);
    this.mats = [];
    inner.traverse(n => {
      if (!n.isMesh) return;
      n.castShadow = true; n.frustumCulled = false;
      if (this.robot) {
        const joints = /Joints/i.test(n.material.name);
        n.material = joints
          ? new THREE.MeshPhysicalMaterial({ color: 0x161a26, roughness: 0.28, metalness: 0.7, clearcoat: 1, emissive: new THREE.Color(o.accent), emissiveIntensity: 0.12 })
          : new THREE.MeshPhysicalMaterial({ color: new THREE.Color(o.body), roughness: 0.38, metalness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.2, sheen: 0.15, sheenColor: new THREE.Color(o.accent), emissive: new THREE.Color(o.accent), emissiveIntensity: 0 });
      } else {
        const m = n.material.clone();
        m.map = teamTexture(models.humanTex, o.hue, o.hueAccent);
        m.metalness = 0; m.metalnessMap = null; m.roughnessMap = null; m.roughness = 0.62;
        m.emissive = new THREE.Color(o.accent); m.emissiveIntensity = 0;
        n.material = m;
      }
      this.mats.push(n.material);
    });
    const b = this.b = {};
    inner.traverse(n => { if (n.isBone) b[n.name.replace(/^mixamorig:?/, '')] = n; });
    // scale to height, face +Z, feet on the floor
    inner.updateMatrixWorld(true);
    const wp = (n, out = new THREE.Vector3()) => n.getWorldPosition(out);
    const box = new THREE.Box3().setFromObject(inner);
    const h = box.max.y - box.min.y;
    inner.scale.multiplyScalar((this.robot ? 1.74 : 1.7) / h);
    inner.updateMatrixWorld(true);
    const across = wp(b.RightArm).sub(wp(b.LeftArm));
    const f = new THREE.Vector3().crossVectors(UP, across).normalize();
    inner.rotation.y -= Math.atan2(f.x, f.z);
    inner.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(inner);
    const hp = wp(b.Hips);
    inner.position.set(inner.position.x - hp.x, inner.position.y - box2.min.y, inner.position.z - hp.z);
    root.updateMatrixWorld(true);

    // ---- rest data (root space; root is identity here)
    this.bones = Object.values(b);
    for (const bn of this.bones) { bn.userData.rq = bn.quaternion.clone(); bn.userData.rp = bn.position.clone(); bn.userData.wq = bn.getWorldQuaternion(new THREE.Quaternion()); bn.userData.wp = wp(bn); }
    const P = n => b[n].userData.wp, dirOf = (a, c) => new THREE.Vector3().subVectors(P(c), P(a)).normalize();
    this.L = {
      upper: P('RightArm').distanceTo(P('RightForeArm')), fore: P('RightForeArm').distanceTo(P('RightHand')),
      thigh: P('RightUpLeg').distanceTo(P('RightLeg')), shin: P('RightLeg').distanceTo(P('RightFoot')),
      ankle: P('RightFoot').y, hips: P('Hips').y,
    };
    this.rest = {};
    for (const s of ['Right', 'Left']) {
      const ua = dirOf(s + 'Arm', s + 'ForeArm'), fa = dirOf(s + 'ForeArm', s + 'Hand');
      const hd = dirOf(s + 'Hand', s + 'HandMiddle1');
      const acr = dirOf(s + 'HandPinky1', s + 'HandIndex1');
      const palm = s === 'Right' ? new THREE.Vector3().crossVectors(acr, hd) : new THREE.Vector3().crossVectors(hd, acr);
      const th = dirOf(s + 'UpLeg', s + 'Leg'), sh = dirOf(s + 'Leg', s + 'Foot');
      this.rest[s] = {
        ua, fa, hd, palm: palm.normalize(),
        uh: new THREE.Vector3().crossVectors(ua, F0).normalize(), fh: new THREE.Vector3().crossVectors(fa, F0).normalize(),
        th, sh, kh: new THREE.Vector3().crossVectors(th, F0.clone().negate()).normalize(), shh: new THREE.Vector3().crossVectors(sh, F0.clone().negate()).normalize(),
      };
    }
    this.headFwdLocal = F0.clone().applyQuaternion(b.Head.userData.wq.clone().invert());

    this.racket = makeRacket(); scene.add(this.racket);
    this.blade = new THREE.Vector3(); this.bladeVel = new THREE.Vector3(); this.freeHand = new THREE.Vector3();
    this.feet = [0, 1].map(i => ({ p: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1, side: i === 0 ? 1 : -1 }));
    this.look = new THREE.Vector3(0, 1, 0);
    this._s = Array.from({ length: 10 }, () => new THREE.Vector3());
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._qr = new THREE.Quaternion();
    this.pelvisY = this.L.hips - 0.08;
    this.place(this.pos);
  }

  dispose(scene) { scene.remove(this.group); scene.remove(this.racket); }

  place(p) {
    this.pos.copy(p); this.goal.copy(p); this.vel.set(0, 0, 0);
    for (const f of this.feet) { this.footTarget(f, f.p); f.from.copy(f.p); f.to.copy(f.p); f.t = 1; }
  }
  footTarget(f, out) {
    return out.copy(this.pos).addScaledVector(this.right, f.side * 0.24).addScaledVector(this.fwd, f.side * 0.05).setY(0);
  }

  frameFor(type, out, axis, normal, bh = false) {
    const R = this.rs, F = this.fwd;
    const oh = v1.set(out.x, 0, out.z).normalize();
    if (type === 'bh' || bh) axis.set(0, 0, 0).addScaledVector(R, -0.75).addScaledVector(UP, 0.4).addScaledVector(F, 0.3);
    else if (type === 'smash') axis.set(0, 0, 0).addScaledVector(R, 0.55).addScaledVector(UP, 0.6).addScaledVector(F, 0.15);
    else axis.set(0, 0, 0).addScaledVector(R, 0.78).addScaledVector(F, 0.35).addScaledVector(UP, -0.08);
    axis.normalize();
    if (type === 'push' || type === 'serve') normal.copy(oh).addScaledVector(UP, 0.9);
    else if (type === 'smash') normal.copy(out).normalize().addScaledVector(UP, -0.2);
    else normal.copy(oh).addScaledVector(UP, -0.55);
    normal.addScaledVector(axis, -normal.dot(axis)).normalize();
    if (type === 'bh' || (bh && type !== 'smash')) normal.negate();
  }

  planSwing(type, C, tc, out, now, bh = false) {
    const R = this.rs, F = this.fwd;
    const s = { type, C: C.clone(), tc, t0: now, out: out.clone(), B: new THREE.Vector3(), Fo: new THREE.Vector3(), M: new THREE.Vector3(), bh: type === 'bh' || bh };
    const B = s.B, Fo = s.Fo;
    if (type === 'bh') { B.copy(C).addScaledVector(R, -0.12).addScaledVector(F, -0.32).addScaledVector(UP, -0.12); Fo.copy(C).addScaledVector(R, 0.42).addScaledVector(F, 0.3).addScaledVector(UP, 0.3); }
    else if (type === 'smash') { B.copy(C).addScaledVector(R, 0.28).addScaledVector(F, -0.32).addScaledVector(UP, 0.32); Fo.copy(C).addScaledVector(R, -0.45).addScaledVector(F, 0.3).addScaledVector(UP, -0.5); }
    else if (type === 'push' || type === 'serve') { B.copy(C).addScaledVector(F, -0.22).addScaledVector(UP, 0.1).addScaledVector(R, 0.06); Fo.copy(C).addScaledVector(F, 0.3).addScaledVector(UP, -0.04).addScaledVector(R, -0.08); }
    else { B.copy(C).addScaledVector(R, 0.34).addScaledVector(F, -0.42).addScaledVector(UP, -0.26); Fo.copy(C).addScaledVector(R, -0.46).addScaledVector(F, 0.22).addScaledVector(UP, 0.5); }
    s.M.copy(C).multiplyScalar(2).addScaledVector(B, -0.5).addScaledVector(Fo, -0.5);
    const ax = new THREE.Vector3(), nm = new THREE.Vector3();
    this.frameFor(type, out, ax, nm, bh);
    s.qC = new THREE.Quaternion().setFromRotationMatrix(m4.makeBasis(v3.crossVectors(ax, nm), ax, nm));
    const tw = (s.bh ? -0.6 : 0.75) * (type === 'push' || type === 'serve' ? 0.4 : 1);
    s.qB = new THREE.Quaternion().setFromAxisAngle(UP, tw).multiply(s.qC);
    s.qF = new THREE.Quaternion().setFromAxisAngle(UP, -tw * 1.2).multiply(s.qC);
    this.swing = s;
    s.lunge = !this.human;
    const g = this.goal.copy(C);
    if (s.bh) g.addScaledVector(R, 0.16).addScaledVector(F, -0.46);
    else if (type === 'smash') g.addScaledVector(R, -0.42).addScaledVector(F, -0.36);
    else if (type === 'serve') g.addScaledVector(R, -0.38).addScaledVector(F, -0.38);
    else g.addScaledVector(R, -0.55).addScaledVector(F, -0.36);
    g.y = 0;
    s.stance = g.clone();
    return s;
  }

  // Point the racket face along the ball's real outgoing direction (called at contact).
  aimFace(out) {
    const S = this.swing; if (!S) return;
    const ax = new THREE.Vector3(), nm = new THREE.Vector3();
    this.frameFor(S.type, out, ax, nm, S.bh);
    S.qC.setFromRotationMatrix(m4.makeBasis(v3.crossVectors(ax, nm), ax, nm));
    const tw = (S.bh ? -0.6 : 0.75) * (S.type === 'push' || S.type === 'serve' ? 0.4 : 1);
    S.qF.setFromAxisAngle(UP, -tw * 1.2).multiply(S.qC);
  }
  splitStep(now) { this.splitT = now; }

  readyFrame(axis, normal, hand) {
    axis.copy(UP).multiplyScalar(0.7).addScaledVector(this.fwd, 0.5).addScaledVector(this.rs, 0.25).normalize();
    normal.copy(this.fwd).addScaledVector(axis, -this.fwd.dot(axis)).normalize();
    hand.copy(this.pos).setY(this.pelvisY + 0.0).addScaledVector(this.fwd, 0.34).addScaledVector(this.rs, 0.24);
  }

  // ---------------------------------------------------------------- per frame
  update(dt, now, ballPos) {
    // locomotion
    if (!Number.isFinite(this.goal.x) || !Number.isFinite(this.goal.z)) this.goal.copy(this.pos);
    const d = v1.subVectors(this.goal, this.pos); d.y = 0;
    const want = v2.copy(d).multiplyScalar(7);
    if (want.length() > this.maxSpeed) want.setLength(this.maxSpeed);
    const dv = v3.subVectors(want, this.vel); const acc = (this.accel || 30) * dt;
    if (dv.length() > acc) dv.setLength(acc);
    this.vel.add(dv); this.pos.addScaledVector(this.vel, dt);
    if (!Number.isFinite(this.pos.x) || !Number.isFinite(this.pos.z)) { this.pos.set(0, 0, this.side * 2.1); this.vel.set(0, 0, 0); this.goal.copy(this.pos); }
    const minZ = T.halfL + 0.32;
    if (this.pos.z * this.side < minZ) { this.pos.z = this.side * minZ; this.vel.z = 0; }
    this.pos.x = clamp(this.pos.x, -3.3, 3.3);
    const Sl = this.swing;
    if (Sl && Sl.lunge && Sl.stance) {
      const dl = now - Sl.tc;
      if (dl > -0.2 && dl < 0.03) { // last-moment lunge so the blade really meets the ball
        const k = 1 - Math.exp(-dt * 16);
        this.pos.x += (Sl.stance.x - this.pos.x) * k; this.pos.z += (Sl.stance.z - this.pos.z) * k;
        if (this.pos.z * this.side < minZ) this.pos.z = this.side * minZ;
      }
    }
    const speed = this.vel.length();
    const gait = Math.min(speed / 3, 1);
    this.phase = (this.phase || 0) + dt * (4 + speed * 3.2);

    // swing timeline
    const S = this.swing;
    let dtc = S ? now - S.tc : 99;
    if (S && dtc > 0.75) { this.swing = null; dtc = 99; }
    const crouch = (S ? clamp((1.12 - S.C.y) * 0.45, 0, 0.14) : 0) + (this.pose === 'ready' ? 0.1 : 0.02) + Math.min(speed * 0.01, 0.03);
    this.pelvisY = this.L.hips - crouch;
    let twist = 0;

    const blade = this._s[0], axis = this._s[1], normal = this._s[2], hand = this._s[3];
    this.readyFrame(axis, normal, hand);
    const readyBlade = this._s[4].copy(hand).addScaledVector(axis, GRIP_TO_BLADE);
    const q = this._q.setFromRotationMatrix(m4.makeBasis(v3.crossVectors(axis, normal), axis, normal));
    const qReady = this._qr.copy(q);
    blade.copy(readyBlade);
    if (S && dtc < 0.75) {
      const tPrep = Math.max(S.t0, S.tc - 0.55);
      const tb = S.bh ? 0.45 : -0.6, tf = S.bh ? -0.35 : 0.55;
      if (dtc < -0.12) {
        const k = ease((now - tPrep) / Math.max(0.05, (S.tc - 0.12) - tPrep));
        blade.lerpVectors(readyBlade, S.B, k); q.slerp(S.qB, k); twist = k * tb;
      } else if (dtc < 0.14) {
        const sP = dtc < 0 ? 0.5 * (dtc + 0.12) / 0.12 : 0.5 + 0.5 * dtc / 0.14;
        const a = (1 - sP) * (1 - sP), bb = 2 * sP * (1 - sP), c = sP * sP;
        blade.set(0, 0, 0).addScaledVector(S.B, a).addScaledVector(S.M, bb).addScaledVector(S.Fo, c);
        if (sP < 0.5) q.copy(S.qB).slerp(S.qC, sP * 2); else q.copy(S.qC).slerp(S.qF, sP * 2 - 1);
        twist = THREE.MathUtils.lerp(tb, tf, sP);
      } else {
        const k = ease((dtc - 0.14) / 0.5);
        blade.lerpVectors(S.Fo, readyBlade, k); q.copy(S.qF).slerp(qReady, k); twist = tf * (1 - k);
      }
    }
    let freeTarget = null;
    if (this.pose === 'celebrate') {
      // short, low fist-pump with the racket hand, then straight back to ready
      const tt = now - this.poseT;
      const k = tt < 0.18 ? ease(tt / 0.18) : 1 - ease((tt - 0.45) / 0.35);
      blade.lerp(v1.copy(this.pos).setY(1.22).addScaledVector(this.rs, 0.18).addScaledVector(this.fwd, 0.22), Math.max(0, k) * 0.85);
    } else if (this.pose === 'win') {
      const k = ease((now - this.poseT) / 0.3);
      const pump = this.pose === 'win' ? 0.12 * Math.sin((now - this.poseT) * 8) : 0;
      blade.lerp(v1.copy(this.pos).setY(1.95 + pump).addScaledVector(this.rs, 0.3).addScaledVector(this.fwd, 0.05), k);
      q.slerp(this._q2.setFromRotationMatrix(m4.makeBasis(v3.crossVectors(UP, this.fwd), UP, this.fwd)), k);
      if (this.pose === 'win') freeTarget = this._s[4].copy(this.pos).setY(1.85 - pump).addScaledVector(this.rs, -0.3).addScaledVector(this.fwd, 0.05);
    } else if (this.pose === 'sad') {
      const k = ease((now - this.poseT) / 0.4) * (this.sadFull ? 1 : 0.5);
      blade.lerp(v1.copy(this.pos).setY(0.82).addScaledVector(this.rs, 0.28).addScaledVector(this.fwd, 0.12), k);
    }
    this.racket.quaternion.copy(q);
    axis.set(0, 1, 0).applyQuaternion(q); normal.set(0, 0, 1).applyQuaternion(q);
    this.racket.position.copy(blade).addScaledVector(axis, -GRIP_TO_BLADE);

    // ------------------------------------------------ skeleton
    const b = this.b, root = this.group;
    for (const bn of this.bones) { bn.quaternion.copy(bn.userData.rq); bn.position.copy(bn.userData.rp); }
    root.position.set(this.pos.x, 0, this.pos.z); root.rotation.set(0, this.yaw, 0);
    root.updateMatrixWorld(true);
    const qRoot = root.quaternion;
    // hips: height + twist
    const split = this.splitT != null ? now - this.splitT : 9;
    const splitDip = split < 0.3 ? Math.sin(Math.min(1, split / 0.3) * Math.PI) * 0.06 : 0;
    const idle = (1 - gait) * Math.sin(now * 6.5) * 0.012 * (this.pose === 'ready' ? 1 : 0.3);
    const bob = Math.abs(Math.sin(this.phase)) * gait * 0.035;
    const hipT = v1.set(this.pos.x, this.pelvisY + bob + idle - splitDip, this.pos.z)
      .addScaledVector(this.fwd, -0.04).addScaledVector(this.right, Math.sin(this.phase) * gait * 0.025);
    b.Hips.position.copy(b.Hips.parent.worldToLocal(hipT.clone()));
    b.Hips.updateMatrixWorld(true);
    setWorldQ(b.Hips, q1.setFromAxisAngle(UP, twist * 0.3 + Math.sin(this.phase) * 0.1 * gait).multiply(b.Hips.getWorldQuaternion(q2)));
    const sadLean = this.pose === 'sad' ? (this.sadFull ? 0.3 : 0.08) : 0;
    this.lean = THREE.MathUtils.damp(this.lean, 0.3 + clamp(this._reach * 1.6, 0, 0.5) + sadLean, 10, dt);
    const leanAxis = v1.copy(this.right).negate();
    // lean into the run, counter-rotate the shoulders against the hips
    const side = clamp(-this.vel.dot(this.right) * 0.055, -0.2, 0.2);
    const counter = -Math.sin(this.phase) * 0.12 * gait;
    for (const n of ['Spine', 'Spine1', 'Spine2']) {
      q1.setFromAxisAngle(leanAxis, this.lean / 3 + splitDip * 0.6).multiply(q2.setFromAxisAngle(UP, twist * 0.22 + counter / 3))
        .multiply(q3.setFromAxisAngle(this.fwd, side));
      setWorldQ(b[n], q1.multiply(b[n].getWorldQuaternion(this._q2)));
    }
    // head tracks the ball
    if (ballPos) this.look.lerp(ballPos, 1 - Math.exp(-dt * 12));
    const hq = b.Head.getWorldQuaternion(this._q2);
    const curF = v2.copy(this.headFwdLocal).applyQuaternion(hq);
    const hpos = b.Head.getWorldPosition(v3);
    let want2;
    if (this.pose === 'sad' && this.sadFull) want2 = v4.copy(this.fwd).multiplyScalar(0.5).add(UP.clone().multiplyScalar(-0.85)).normalize();
    else { want2 = v4.subVectors(this.look, hpos).normalize(); if (want2.dot(this.fwd) < 0.1) want2.copy(this.fwd); }
    q1.setFromUnitVectors(curF, want2); q1.slerp(q3.identity(), 0.25);
    setWorldQ(b.Head, q1.multiply(hq));

    // right arm holds the racket
    // shakehand grip: palm on the red-face side, the handle runs diagonally across the palm
    const gripC = v1.copy(this.racket.position).addScaledVector(axis, 0.05 * RK);
    const palm = normal;
    const across = this._s[9].crossVectors(palm, axis).normalize();          // toward the thumb
    const handDir = this._hd || (this._hd = new THREE.Vector3());
    handDir.copy(axis).multiplyScalar(0.62).addScaledVector(across, -0.78).normalize();
    const wrist = this._s[5].copy(gripC).addScaledVector(handDir, -0.075).addScaledVector(palm, -0.03);
    const sR = b.RightArm.getWorldPosition(this._s[6]);
    const elbow = this._s[7], end = this._s[8];
    const pole = v2.copy(this.rs).multiplyScalar(0.5).addScaledVector(UP, -1).addScaledVector(this.fwd, -0.3);
    ik(sR, wrist, this.L.upper, this.L.fore, pole, elbow, end);
    this._reach = sR.distanceTo(wrist) - (this.L.upper + this.L.fore - 0.03);
    this.poseArm('Right', sR, elbow, end, qRoot);
    this.poseHand('Right', handDir, palm, qRoot, 1.25);
    const realWrist = b.RightHand.getWorldPosition(v2);
    const off = v3.subVectors(realWrist, wrist);
    this.racket.position.add(off); blade.add(off);
    this.bladeVel.subVectors(blade, this.blade).divideScalar(Math.max(dt, 1e-4));
    this.blade.copy(blade);

    // free arm
    if (!freeTarget) {
      freeTarget = this._s[4].copy(this.pos).setY(this.pelvisY + 0.02 + Math.abs(twist) * 0.12).addScaledVector(this.fwd, 0.28 + Math.sin(this.phase) * 0.14 * gait).addScaledVector(this.rs, -0.3 - twist * 0.2);
      if (this.hold) freeTarget.copy(this.pos).setY(1.0).addScaledVector(this.fwd, 0.36).addScaledVector(this.rs, -0.05);
      if (this.tossT >= 0) { const tt = now - this.tossT, k = clamp(tt / 0.25, 0, 1); freeTarget.y += Math.sin(k * Math.PI * 0.5) * 0.45 * (1 - clamp((tt - 0.5) / 0.3, 0, 1)); }
    }
    const sL = b.LeftArm.getWorldPosition(this._s[6]);
    const poleL = v2.copy(this.rs).multiplyScalar(-0.5).addScaledVector(UP, -1).addScaledVector(this.fwd, -0.2);
    ik(sL, freeTarget, this.L.upper, this.L.fore, poleL, elbow, end);
    this.poseArm('Left', sL, elbow, end, qRoot);
    this.poseHand('Left', null, null, qRoot, this.hold || this.tossT >= 0 ? 0.6 : 0.35);
    this.freeHand.copy(b.LeftHandMiddle1.getWorldPosition(v1)).addScaledVector(UP, 0.03).addScaledVector(this.fwd, 0.02);

    // legs with stepping feet
    const tgt = this._s[9];
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i], other = this.feet[1 - i];
      if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / (0.15 - 0.04 * gait));
        f.p.lerpVectors(f.from, f.to, ease(f.t)); f.p.y = Math.sin(f.t * Math.PI) * (0.06 + 0.05 * gait);
      } else if (other.t >= 1) {
        this.footTarget(f, tgt);
        if (tgt.distanceTo(f.p) > 0.09) { f.from.copy(f.p); f.to.copy(tgt).addScaledVector(this.vel, 0.11); f.to.y = 0; f.t = 0; }
      }
    }
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 'Right' : 'Left', f = this.feet[i];
      const hipP = b[s + 'UpLeg'].getWorldPosition(this._s[6]);
      const ankle = v4.copy(f.p); ankle.y += this.L.ankle;
      const kp = v2.copy(this.fwd).addScaledVector(this.right, i === 0 ? 0.2 : -0.2);
      ik(hipP, ankle, this.L.thigh, this.L.shin, kp, elbow, end);
      this.poseLeg(s, hipP, elbow, end, qRoot, i === 0 ? -0.25 : 0.25);
    }
  }

  poseArm(s, S, E, W, qRoot) {
    const r = this.rest[s], b = this.b;
    const du = v1.subVectors(E, S).normalize();
    const df = v2.subVectors(W, E).normalize();
    let bend = v3.copy(df).addScaledVector(du, -df.dot(du));
    if (bend.lengthSq() < 1e-5) bend.copy(this.fwd).addScaledVector(du, -this.fwd.dot(du));
    bend.normalize();
    const hinge = this._s[9].crossVectors(du, bend).normalize();
    this.aimBone(b[s + 'Arm'], r.ua, r.uh, du, hinge, qRoot);
    this.aimBone(b[s + 'ForeArm'], r.fa, r.fh, df, hinge, qRoot);
  }
  poseLeg(s, H, K, A, qRoot, splay) {
    const r = this.rest[s], b = this.b;
    const dt = v1.subVectors(K, H).normalize();
    const ds = v2.subVectors(A, K).normalize();
    let bend = v3.copy(ds).addScaledVector(dt, -ds.dot(dt));
    if (bend.lengthSq() < 1e-5) bend.copy(this.fwd).negate().addScaledVector(dt, this.fwd.dot(dt));
    bend.normalize();
    const hinge = this._s[9].crossVectors(dt, bend).normalize();
    this.aimBone(b[s + 'UpLeg'], r.th, r.kh, dt, hinge, qRoot);
    this.aimBone(b[s + 'Leg'], r.sh, r.shh, ds, hinge, qRoot);
    setWorldQ(b[s + 'Foot'], q1.setFromAxisAngle(UP, this.yaw + splay).multiply(b[s + 'Foot'].userData.wq));
  }
  // Rotate a bone so its rest (dir, hinge) frame maps onto (dir, hinge) in the world.
  aimBone(bone, rDir, rHinge, dir, hinge, qRoot) {
    const a = new THREE.Vector3().copy(rDir).applyQuaternion(qRoot);
    const rh = new THREE.Vector3().copy(rHinge).applyQuaternion(qRoot);
    const qa = basisQ(a, rh, new THREE.Quaternion());
    const qb = basisQ(dir.clone(), hinge.clone(), new THREE.Quaternion());
    const R = qb.multiply(qa.invert());
    setWorldQ(bone, R.multiply(q2.copy(qRoot).multiply(bone.userData.wq)));
  }
  poseHand(s, dir, palm, qRoot, curl) {
    const b = this.b, r = this.rest[s];
    if (dir) {
      const rd = new THREE.Vector3().copy(r.hd).applyQuaternion(qRoot), rp = new THREE.Vector3().copy(r.palm).applyQuaternion(qRoot);
      const qa = basisQ(rd, rp, new THREE.Quaternion());
      const qb = basisQ(dir.clone(), palm.clone(), new THREE.Quaternion());
      setWorldQ(b[s + 'Hand'], qb.multiply(qa.invert()).multiply(q2.copy(qRoot).multiply(b[s + 'Hand'].userData.wq)));
    }
    // curl fingers toward the palm
    const hq = b[s + 'Hand'].getWorldQuaternion(new THREE.Quaternion());
    // hand-space rest dir/palm, re-expressed through the current hand rotation
    const restHandRootQ = b[s + 'Hand'].userData.wq;
    const rel = hq.clone().multiply(restHandRootQ.clone().invert());
    const hd2 = r.hd.clone().applyQuaternion(rel), pm2 = r.palm.clone().applyQuaternion(rel);
    const curlAxis = new THREE.Vector3().crossVectors(hd2, pm2).normalize();
    for (const fn of FINGERS) for (let j = 1; j <= 3; j++) this.curlBone(b[`${s}Hand${fn}${j}`], curlAxis, curl * (j === 1 ? 0.8 : 1));
    for (let j = 1; j <= 3; j++) this.curlBone(b[`${s}HandThumb${j}`], curlAxis, curl * 0.3);
  }
  curlBone(bone, axisW, ang) {
    if (!bone) return;
    const wq = bone.getWorldQuaternion(q1).invert();
    const la = v1.copy(axisW).applyQuaternion(wq).normalize();
    bone.quaternion.multiply(q2.setFromAxisAngle(la, ang));
    bone.updateMatrixWorld(true);
  }

  setPose(p, now, full = false) { this.pose = p; this.poseT = now; this.sadFull = p === 'sad' && full; if (p !== 'ready') this.swing = null; }
  setColorBoost(v) { for (const m of this.mats) if (m.emissiveIntensity !== undefined) m.emissiveIntensity = (this.robot ? 0.12 : 0) + v * 0.6; }
}
