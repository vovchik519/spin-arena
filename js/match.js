// Match logic (singles): scoring, service order, rally refereeing, shot construction,
// human strokes (you move with your thumb, a flick is the stroke) and the computer opponent.
import * as THREE from 'three';
import { T, BallState, step, DT, solveShot, solveServe, spinVector, predict, landsLegally } from './physics.js';
import { Athlete } from './athlete.js';

const UP = new THREE.Vector3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;
export const HUMAN_SPEED = 10;          // m/s, the legs limit you, not the finger
const RACKET_OFFSET = 0.32;            // racket sits this far to the racket-hand side of the body
const SWEET = 0.1;
const LATE_WINDOW = 0.09;
const STROKE_FWD = 0.55, STROKE_BACK = 0.9;   // finger speed (screen heights/s) that counts as a stroke              // a stroke up to this long after the ideal moment still connects
const BASE_DEPTH = T.halfL + 0.5;     // the human's ready line behind the end line                    // half-width of the racket's sweet spot, m
export const CHARGE_MAX = 3;           // clean hits in a row that load a super shot

// Timing windows around the ideal contact moment; they tighten as the ball gets faster.
export function windows(v, mult = 1) {
  const k = clamp((v - 8) / 12, 0, 1), L = THREE.MathUtils.lerp;
  return { P: L(0.07, 0.05, k) * mult, G: L(0.15, 0.11, k) * mult, late: L(0.12, 0.09, k) * mult };
}
function sampleAt(samples, t) {
  let best = null, bd = 1e9;
  for (const s of samples) { const d = Math.abs(s.t - t); if (d < bd) { bd = d; best = s; } }
  return best ? best.p.clone() : null;
}

export const DIFF = {
  easy:   { err: 0.12, speed: 0.45, place: 0.5, spin: 0.6, crit: 0.0, move: 4.4, critResp: 0.45, win: 1.35, tele: 0.65, reach: 1.3, loop: 0.0, sideP: 0.08, sideServe: 0.1, spinScale: 0.6 },
  pro:    { err: 0.05, speed: 0.65, place: 0.8, spin: 0.85, crit: 0.05, move: 5.2, critResp: 0.28, win: 1, tele: 0.5, reach: 1, loop: 0.2, sideP: 0.2, sideServe: 0.3, spinScale: 0.85 },
  master: { err: 0.02, speed: 0.8, place: 0.9, spin: 1, crit: 0.1, move: 6, critResp: 0.16, win: 0.85, tele: 0.35, reach: 0.95, loop: 0.35, sideP: 0.3, sideServe: 0.45, spinScale: 1 },
};
export const TEAM_STYLE = [
  { color: '#5ef0ff', accent: '#5ef0ff', hue: 192, hueAccent: 222 },
  { color: '#c9a2ff', accent: '#b48cff', hue: 268, hueAccent: 300, body: '#4b2fd6' },
];

export class Match {
  constructor(world, fx, sound, cfg, hooks, models) {
    this.w = world; this.fx = fx; this.snd = sound; this.cfg = cfg; this.hooks = hooks;
    this.ball = new BallState();
    this.players = [];
    for (let team = 0; team < 2; team++) {
      const st = TEAM_STYLE[team];
      const robot = team === 1 && cfg.opp === 'cpu';
      const human = cfg.humans[team];
      const a = new Athlete(world.scene, {
        team, robot, name: robot ? 'X-Бот' : team === 0 ? 'Мишель' : 'Мишель II',
        hue: st.hue, hueAccent: st.hueAccent, accent: st.accent, body: st.body,
        maxSpeed: human ? HUMAN_SPEED : DIFF[cfg.diff].move,
      }, models);
      a.human = human; if (human) a.accel = 75;
      a.place(new THREE.Vector3(0.15 * (team === 0 ? 1 : -1), 0, (team === 0 ? 1 : -1) * 2.1));
      this.players.push(a);
    }
    this.score = [0, 0]; this.games = [0, 0];
    this.gamesToWin = cfg.bestOf === 1 ? 1 : cfg.bestOf === 3 ? 2 : 3;
    this.firstServer = Math.random() < 0.5 ? 0 : 1;
    this.state = 'intro'; this.now = 0; this.stateT = 0;
    this.rally = null; this.pending = null; this.window = null; this.inFlight = false;
    this.charge = [0, 0]; this.rallyHits = 0;
  }

  dispose() { for (const p of this.players) p.dispose(this.w.scene); }
  gameNo() { return this.games[0] + this.games[1] + 1; }

  serverTeam() {
    const tp = this.score[0] + this.score[1];
    const turn = (this.score[0] >= 10 && this.score[1] >= 10) ? 10 + (tp - 20) : Math.floor(tp / 2);
    return (this.firstServer + this.games[0] + this.games[1] + turn) % 2;
  }

  begin() { this.startPoint(); }

  startPoint() {
    const st = this.serverTeam();
    const server = this.server = this.players[st], receiver = this.receiver = this.players[1 - st];
    for (const p of this.players) { p.setPose('ready', this.now); p.hold = false; p.tossT = -1; p.ctrlX = null; }
    server.place(new THREE.Vector3(server.right.x * 0.24 - server.rs.x * 0.35, 0, server.side * (T.halfL + 0.62)));
    server.hold = true;
    receiver.place(new THREE.Vector3(receiver.right.x * 0.05, 0, receiver.side * (T.halfL + 0.75)));
    this.rallyHits = 0;
    this.rally = { lastHitter: null, bounces: [0, 0], serve: true, serving: false, netTouched: false, hitNet: false };
    this.state = 'serve'; this.stateT = this.now;
    this.fx.clearTrail(); this.fx.trailHeat = 0;
    this.window = null; this.pending = null; this.inFlight = false;
    this.hooks.onServeReady(server);
    if (!server.human) this.aiServeAt = this.now + rnd(0.9, 1.5);
  }

  serve(params) {
    if (this.state !== 'serve') return;
    const s = this.server;
    this.state = 'toss'; this.stateT = this.now;
    s.tossT = this.now; s.hold = false;
    this.serveParams = params;
    this.ball.p.copy(s.freeHand); this.ball.v.set(0, 2.45, 0); this.ball.w.set(0, 0, 0);
    this.inFlight = true;
    const contactT = this.now + 0.42;
    const pr = this.ball.clone(); for (let t = 0; t < 0.42; t += DT) step(pr, DT, false);
    this.serveContact = { t: contactT, C: pr.p.clone() };
    s.planSwing('serve', pr.p.clone(), contactT, s.fwd.clone(), this.now);
    s.goal.copy(s.pos);
  }

  buildServe(params) {
    // try the asked serve, then progressively safer ones, so a valid swipe never faults
    const tries = [params, { ...params, power: params.power * 0.5 }, { ...params, lateral: params.lateral * 0.5, power: 0.2 }, { kind: 'push', lateral: 0, power: 0.3 }];
    let r = null;
    for (const p of tries) { r = this.buildServeOnce(p); if (landsLegally(this.ball.p, r.v, r.w, -this.server.side, true)) return r; }
    return r;
  }
  buildServeOnce(params) {
    const s = this.server, C = this.ball.p.clone(), dir = -s.side;
    const short = params.kind === 'push';
    const depth = short ? rnd(0.35, 0.55) : 0.75 + params.power * 0.45;
    const target = new THREE.Vector3(clamp(params.lateral * 0.55 * s.rs.x, -0.62, 0.62), 0, dir * clamp(depth, 0.25, 1.22));
    const sc = params.spinScale ?? 1;
    const top = (short ? -rnd(160, 260) : 60 + params.power * 160) * sc;
    const w = spinVector(new THREE.Vector3(target.x - C.x, 0, target.z - C.z), top, -(params.side || 0) * 110 * sc);
    const v = solveServe(C, target, short ? 4.2 : 5.2 + params.power * 4.5, w);
    return { v, w, target };
  }

  buildShot(hitter, C, p) {
    const dir = -hitter.side;
    let depth, hs, top;
    const sc = p.spinScale ?? 1;
    const side = -(p.side || 0) * 90 * sc;   // positive = curves to the hitter's right
    const lateral = clamp(p.lateral, -1.7, 1.7) * 0.62 * hitter.rs.x;
    if (p.kind === 'push') { depth = rnd(0.45, 0.85); hs = rnd(4.2, 5.5); top = -(150 + 130 * (p.chop ?? Math.random())) * sc; }
    else if (p.kind === 'loop') { depth = 0.85 + p.power * 0.35; hs = 7 + p.power * 7; top = (320 + p.power * 240) * sc; }
    else if (p.kind === 'smash') { depth = 0.9 + p.power * 0.3; hs = 20 + p.power * 8; top = 40; }
    else if (p.kind === 'block') { depth = rnd(0.7, 1.05); hs = rnd(5.6, 6.8); top = 40; }
    else { depth = 0.55 + p.power * 0.95; hs = 7.5 + p.power * 11; top = (110 + p.power * 190) * sc; }   // flat and too hard = long
    if (p.depth) depth = p.depth;
    if (p.crit) { hs *= 1.4; top = top * 1.7 + 120; depth = Math.max(depth, 1.08); }
    const target = new THREE.Vector3(lateral, 0, dir * clamp(depth, 0.2, 1.75));
    const w = spinVector(new THREE.Vector3(target.x - C.x, 0, target.z - C.z), top, side);
    let v = solveShot(C, target, hs, w, p.kind === 'smash' || p.crit ? 0.015 : 0.04);
    // solver safety net: if the intended shot would not land, take pace off until it does
    // solver safety net only for shots aimed at the table; an aim off the table is the player's choice
    const onTable = Math.abs(target.x) < T.halfW - 0.02 && Math.abs(target.z) < T.halfL - 0.02;
    for (let k = 0; onTable && k < 4 && !landsLegally(C, v, w, dir); k++) { hs *= 0.82; v = solveShot(C, target, hs, w, 0.05); }
    if (p.dev) {
      v.applyAxisAngle(UP, p.dev.xSign * p.dev.yaw * (dir > 0 ? 1 : -1));
      const ax = new THREE.Vector3().crossVectors(v, UP).normalize();
      v.applyAxisAngle(ax, p.dev.pitch);
    }
    const e = p.error || 0;
    if (e > 0) {
      v.applyAxisAngle(UP, rnd(-1, 1) * e * 0.12);
      const ax = new THREE.Vector3().crossVectors(v, UP).normalize();
      v.applyAxisAngle(ax, (Math.random() < 0.5 ? -1 : 1) * e * rnd(0.03, 0.1));
      v.multiplyScalar(1 + rnd(-0.07, 0.09) * e);
    }
    return { v, w, target };
  }

  launch(hitter, shot, quality) {
    this.ball.v.copy(shot.v); this.ball.w.copy(shot.w);
    this.rally.lastHitter = hitter;
    this.rally.bounces = [0, 0]; this.rally.hitNet = false;
    this.window = null; this.pending = null;
    if (this.rally.serve) this.rally.serving = true;
    this.rally.lastCrit = !!quality.crit;
    if (!quality.serve) this.rallyHits++;
    hitter.aimFace(shot.v);
    this.players[1 - hitter.team].splitStep(this.now);
    this.snd.paddle(shot.v.length());
    if (navigator.vibrate && hitter.human) try { navigator.vibrate(quality.crit ? [30, 30, 60] : 14); } catch (e) {}
    this.fx.impactSquash();
    this.hooks.onHit(hitter, shot, quality, this.ball.p.clone());
    this.planNext(this.players[1 - hitter.team]);
  }

  // Predict where the receiver meets the ball and start them moving.
  planNext(h) {
    const pr = predict(this.ball, 2.6);
    let bounceT = -1, ok = true, bounces = 0;
    for (const ev of pr.events) {
      if (ev.type === 'table') {
        bounces++;
        if (this.rally.serving && bounces === 1) { if (ev.side !== -h.side) { ok = false; break; } continue; }
        if (ev.side === h.side) { bounceT = ev.t; if (h.human) this.hooks.onTelegraph(new THREE.Vector3(ev.x, T.top, ev.z), 1 - h.team); } else ok = false;
        break;
      }
      if (ev.type === 'floor') { ok = false; break; }
    }
    if (!ok || bounceT < 0) {
      if (!h.human) h.goal.set(h.pos.x * 0.6, 0, h.side * (T.halfL + 0.9));
      this.pending = { hitter: h, none: true };
      return;
    }
    let best = null, apexY = -1;
    for (const s of pr.samples) {
      if (s.t < bounceT + 0.04) continue;
      if (s.p.y < T.top + 0.06 && s.v.y < 0) break;
      if (Math.abs(s.p.z) > T.halfL + 1.6) break;
      if (s.p.y > apexY) { apexY = s.p.y; best = s; }
      else if (Math.abs(s.p.z) < T.halfL - 0.1) best = s;
      else break;
    }
    // a human may meet the ball just after its peak (a little more time), but only while it is
    // still above net height and close to the end line, so the return can be flat, not a lob
    if (h.human) {
      // humans meet the ball close to the end line: the highest point the ball reaches
      // between its bounce and 40 cm behind the table (never far back, never a lob from the floor)
      let hb = null, first = null;
      for (const s2 of pr.samples) {
        if (s2.t < bounceT + 0.012) continue;
        if (!first) first = s2;                       // fast balls: right after the bounce
        if (Math.abs(s2.p.z) > T.halfL + 0.45) break;
        if (s2.p.y < T.top + 0.06 && s2.v.y < 0) break;
        if (!hb || s2.p.y >= hb.p.y - 0.01) hb = s2;
      }
      best = hb || first || best;
    }
    if (!best) { this.pending = { hitter: h, none: true }; return; }
    const tc = this.now + best.t, C = best.p.clone();
    const high = C.y > T.top + 0.38;
    const rel = new THREE.Vector3().subVectors(C, h.pos).dot(h.rs);
    const stroke = high ? 'smash' : rel > -0.12 ? 'fh' : 'bh';
    this.pending = { hitter: h, tc, C, high, stroke, incoming: best.v.clone(), spin: best.w.clone() };
    if (!h.human) h.planSwing(stroke, C, tc, h.fwd.clone(), this.now);
    if (h.human) {
      // depth is automatic, left/right is yours
      this.holdLateral(h);
      const v = best.v.length();
      const mult = (this.cfg.opp === 'cpu' ? DIFF[this.cfg.diff].win : 1) * (this.rally.lastCrit ? 0.75 : 1);
      this.window = { hitter: h, tIdeal: tc, C, high, t0: this.now, v, spin: best.w.clone(), samples: pr.samples,
        minT: this.now + bounceT + 0.03, win: windows(v, mult), shot: null, missed: false };
      this.hooks.onWindow(this.window);
    } else this.scheduleAI(h);
  }

  scheduleAI(h) {
    const P = this.pending, d = DIFF[this.cfg.diff];
    const inc = P.incoming.length(), spin = P.spin.length();
    const lh = this.rally.lastHuman;
    let err = d.err + Math.max(0, inc - 11) * 0.007 + Math.max(0, spin - 250) * 0.0003 + (this.rally.lastCrit ? d.critResp : 0)
      + (lh ? Math.abs(lh.lateral) * 0.08 + (lh.perfect ? 0.06 : 0) : 0);
    // the longer the rally, the harder the robot pushes, and the more it risks
    const press = Math.min(1, this.rallyHits / 12);
    err += press * 0.05;
    const soft = inc < 7.5 && P.C.y > T.top + 0.2;      // a floated block or lob: punish it
    if (this.rally.serving) err *= 0.5;
    const miss = Math.random() < err;
    const r = Math.random();
    let kind = 'drive';
    if ((P.high || (soft && P.C.y > T.top + 0.3)) && r < 0.8) kind = 'smash';
    else if (!soft && r < 0.15) kind = 'push';
    const crit = !miss && kind !== 'push' && Math.random() < (P.high || soft ? 0.25 + d.crit : d.crit * 0.3);
    const opp = this.players[1 - h.team];
    const away = -(Math.sign(opp.pos.x) || (Math.random() < 0.5 ? 1 : -1));
    const lateral = (Math.random() < 0.45 + 0.35 * press ? away * rnd(0.35 + 0.35 * press, 0.95) * d.place : rnd(-0.8, 0.8) * d.place) * h.rs.x;
    if (kind === 'drive' && !soft && Math.random() < d.loop) kind = 'loop';
    P.ai = {
      kind, lateral, power: clamp(rnd(0.3, 1) * d.speed + press * 0.3 + (soft ? 0.35 : 0) + (kind === 'smash' ? 0.2 : 0), 0, 1),
      side: Math.random() < d.sideP ? (Math.random() < 0.5 ? -1 : 1) * rnd(0.4, 1) : 0, spinScale: d.spinScale,
      error: miss ? rnd(1.2, 2.4) : rnd(0, 0.3), crit, perfect: crit, whiff: miss && Math.random() < 0.15,
    };
    P.ai.depth = kind === 'push' ? rnd(0.45, 0.8) : kind === 'smash' ? 1.05 : kind === 'loop' ? clamp(0.85 + P.ai.power * 0.35, 0.3, 1.25) : clamp(0.7 + P.ai.power * 0.55, 0.3, 1.25);
    if (kind !== P.stroke && (kind === 'push' || kind === 'smash')) h.planSwing(kind, P.C, P.tc, h.fwd.clone(), this.now, P.stroke === 'bh');
  }

  // ------------------------------------------------------------ human strokes
  // The finger is the racket. When the ball reaches the contact point, it is struck if the
  // racket is in its path. How the finger is moving at that instant decides the stroke:
  // still = soft block, quick push toward the opponent = drive (faster = harder),
  // quick pull back = chop. Hitting with the middle of the racket is clean; the edge sprays.
  humanStroke(team, p) {
    if (this.state === 'serve' && this.server.team === team && this.server.human) { this.serve(p); return 'serve'; }
    return null;
  }

  racketX(h) { return h.pos.x + RACKET_OFFSET * h.rs.x; }
  reachMult() { return this.cfg.opp === 'cpu' ? DIFF[this.cfg.diff].reach : 1; }
  // how well the racket covers the ball: 'sweet' | 'hit' | 'out'
  coverage(h, ballX, v, bonus = 0) {
    const R = (0.46 + 0.012 * Math.max(0, v - 10)) * this.reachMult() + bonus;
    const d = Math.abs(ballX - this.racketX(h));
    return { d, R, sweet: SWEET * this.reachMult(), zone: d <= SWEET * this.reachMult() ? 'sweet' : d <= R ? 'hit' : 'out' };
  }

  resolveHuman(W, sw, late = 0) {
    const h = W.hitter, ball = this.ball;
    if (!sw.touching) { W.missed = true; W.missReason = 'none'; return; }   // no finger, no racket
    // swinging lets you stretch for a wide ball (an extra ~15 cm), standing still does not
    const swinging = sw.fwd > STROKE_FWD || sw.back > STROKE_BACK;
    const cov = this.coverage(h, ball.p.x, W.v, swinging ? 0.15 : 0);
    if (cov.zone === 'out') { W.missed = true; W.missReason = 'far'; return; }
    const p = { side: 0 };
    if (sw.back > STROKE_BACK && sw.back > sw.fwd) { p.kind = 'push'; p.power = 0.3; }
    else if (sw.fwd < STROKE_FWD) { p.kind = 'block'; p.power = 0.15; }
    else { p.kind = 'drive'; p.power = clamp((sw.fwd - STROKE_FWD) / 2.6, 0, 1); }
    if (W.high && p.kind === 'drive' && p.power > 0.45) p.kind = 'smash';
    // aim: the swing's sideways motion for strokes, the racket angle (contact offset) for blocks
    const off = clamp((ball.p.x - this.racketX(h)) / cov.R, -1, 1);
    // direction comes from the player's stroke, including mistakes (beyond ±1.2 it misses the table)
    if (p.kind === 'block') p.lateral = clamp(off * h.rs.x * 0.9 + sw.lat * 0.5, -1.7, 1.7);
    else p.lateral = clamp(sw.lat / Math.max(0.8, sw.fwd + sw.back) / 0.4, -1.7, 1.7);
    const sweet = cov.zone === 'sweet';
    const q = sweet ? 1 : 0.6;                                       // a clean contact grips the ball
    if (p.kind === 'drive' && sw.wind && p.power > 0.15) p.kind = 'loop';
    p.side = clamp((sw.curve || 0) * q, -1, 1);
    if (p.kind === 'push') p.chop = clamp((sw.back - 1.1) / 2, 0, 1) * q;
    p.spinScale = p.kind === 'loop' ? q : 1;
    const charged = this.charge[h.team] >= CHARGE_MAX;
    p.perfect = sweet;
    p.crit = sweet && p.kind !== 'block' && p.kind !== 'push' && (p.kind === 'smash' || p.power >= 0.8 || charged);
    if (p.crit && charged) { p.power = Math.max(p.power, 0.85); this.charge[h.team] = 0; }
    else if (sweet && p.kind !== 'block') this.charge[h.team] = Math.min(CHARGE_MAX, this.charge[h.team] + 1);
    else if (!sweet) this.charge[h.team] = Math.max(0, this.charge[h.team] - 1);
    // edge contact sprays the ball toward that edge; hard swings punish it more
    const eo = sweet ? 0 : (cov.d - cov.sweet) / (cov.R - cov.sweet);
    const scale = (0.5 + 0.9 * p.power) * (1 + 0.025 * Math.max(0, W.v - 10)) * (this.rally.lastCrit ? 1.3 : 1);
    let yaw = THREE.MathUtils.degToRad(10 * eo * eo * scale + 2 * eo);
    let pitch = THREE.MathUtils.degToRad(p.kind === 'block' ? 2.2 * eo * eo : -3 * eo * eo * scale);
    const top = W.spin.dot(new THREE.Vector3(0, 1, 0).cross(new THREE.Vector3(0, 0, h.side)));
    if (!sweet && (p.kind === 'drive' || p.kind === 'block') && top < -60) pitch -= THREE.MathUtils.degToRad(1.2 * Math.min(2, -top / 250));
    if (!sweet && p.kind === 'push' && top > 60) pitch += THREE.MathUtils.degToRad(1.4 * Math.min(2, top / 250));
    if (!sweet && p.kind === 'block' && top > 120) pitch += THREE.MathUtils.degToRad(0.9 * Math.min(2, top / 300));
    const inSide = W.spin.y * -h.side;                               // incoming sidespin, signed in world x
    if (!sweet && Math.abs(inSide) > 50) yaw += THREE.MathUtils.degToRad(2.5 * Math.min(2, Math.abs(inSide) / 150) * (p.kind === 'block' ? 1.4 : 1));
    // a late stroke meets the ball behind the body: it leaves wide toward the racket side and lower
    if (late > 0.01) { const lk = Math.min(1, late / (W.lateCap || LATE_WINDOW)); yaw += THREE.MathUtils.degToRad(9 * lk); pitch -= THREE.MathUtils.degToRad(2 * lk); }
    // a stroke made well before the ball arrived: pulled cross-court and a touch long
    const early = sw.early || 0;
    if (early > 0.08) { const ek = Math.min(1, (early - 0.08) / 0.2); yaw += THREE.MathUtils.degToRad(7 * ek); pitch += THREE.MathUtils.degToRad(1.2 * ek); }
    p.dev = { xSign: late > 0.01 ? h.rs.x : early > 0.08 ? -h.rs.x : Math.sign(off) || 1, yaw, pitch };
    if (p.kind === 'block') p.depth = 0.75 + 0.2 * Math.random();
    this.rally.lastHuman = { lateral: p.lateral, perfect: sweet };
    // swing the racket through the real contact point
    const C = ball.p.clone();
    const rel = (C.x - h.pos.x) * h.rs.x;
    const type = p.kind === 'push' || p.kind === 'smash' ? p.kind : p.kind === 'block' ? 'push' : rel < -0.05 ? 'bh' : 'fh';
    // the stroke starts now, from the player's gesture; a short lunge brings the blade onto the ball
    h.planSwing(type, C, this.now, h.fwd.clone(), this.now - 0.1, rel < -0.05);
    h.swing.lunge = true;
    const st = h.swing.stance;
    if (Math.abs(st.z) > Math.abs(h.pos.z)) st.z = h.pos.z;
    const jump = Math.min(1, 0.32 / Math.max(0.001, Math.hypot(st.x - h.pos.x, st.z - h.pos.z)));
    h.pos.x += (st.x - h.pos.x) * 0.6 * jump; h.pos.z += (st.z - h.pos.z) * 0.6 * jump;
    this.holdLateral(h);
    const shot = this.buildShot(h, C, p);
    this.hooks.consumeStroke?.(h.team);
    this.launch(h, shot, { crit: p.crit, perfect: sweet, kind: p.kind, zone: cov.zone, charged, side: p.side });
  }

  // the player only moves where the finger says; depth stays on a fixed ready line
  holdLateral(h) {
    h.goal.x = h.ctrlX != null ? h.ctrlX - RACKET_OFFSET * h.rs.x : h.pos.x;
    h.goal.z = h.side * BASE_DEPTH;
  }

  pointTo(team, reason) {
    if (this.state !== 'rally' && this.state !== 'toss') return;
    this.state = 'point'; this.stateT = this.now;
    this.window = null; this.pending = null;
    this.score[team]++;
    for (const p of this.players) p.setPose(p.team === team ? 'celebrate' : 'sad', this.now);
    let gameOver = false, matchOver = false;
    const [a, b] = this.score;
    if ((a >= 11 || b >= 11) && Math.abs(a - b) >= 2) {
      gameOver = true; this.games[team]++;
      if (this.games[team] >= this.gamesToWin) matchOver = true;
    }
    this.pointResult = { gameOver, matchOver, team };
    this.hooks.onPoint(team, reason, this.pointResult);
  }

  nextAfterPoint() {
    const r = this.pointResult;
    if (r.matchOver) {
      this.state = 'over'; this.stateT = this.now;
      for (const p of this.players) p.setPose(p.team === r.team ? 'win' : 'sad', this.now, true);
      this.hooks.onMatchOver(r.team);
      return;
    }
    if (r.gameOver) { this.score = [0, 0]; this.state = 'break'; this.stateT = this.now; this.hooks.onGameBreak(); return; }
    this.startPoint();
  }

  onEvent(ev) {
    const R = this.rally, last = R.lastHitter;
    if (ev.type === 'table') {
      this.snd.table(ev.speed);
      this.hooks.onBounce(ev);
      if (!last) return;
      const sideIdx = ev.side > 0 ? 0 : 1;
      if (R.serving) {
        R.bounces[sideIdx]++;
        const own = sideIdx === last.team, total = R.bounces[0] + R.bounces[1];
        if (total === 1 && !own) return this.pointTo(1 - last.team, 'Подача: нужен отскок на своей стороне');
        if (total === 2) {
          if (own) return this.pointTo(1 - last.team, 'Подача в сетку');
          if (R.netTouched) return this.let();
          R.serving = false; R.serve = false;
        }
        return;
      }
      if (sideIdx === last.team) return this.pointTo(1 - last.team, R.hitNet ? 'Сетка' : 'Мяч на своей стороне');
      R.bounces[sideIdx]++;
      if (R.bounces[sideIdx] >= 2) return this.pointTo(last.team, 'Два отскока');
    } else if (ev.type === 'net' || ev.type === 'netcord') {
      this.snd.net();
      R.netTouched = R.netTouched || !!R.serving; R.hitNet = ev.type === 'net';
      this.hooks.onNet(ev);
    } else if (ev.type === 'floor') {
      this.snd.floor(ev.speed);
      if (!last) return this.pointTo(1 - this.server.team, 'Подача сорвана');
      const opp = 1 - last.team;
      if (R.serving && R.bounces[opp] >= 1) return this.pointTo(last.team, 'Эйс!');
      if (R.bounces[opp] >= 1) return this.pointTo(last.team, 'Мимо ракетки');
      return this.pointTo(opp, R.hitNet ? 'Сетка' : 'Аут');
    }
  }

  let() { this.state = 'let'; this.stateT = this.now; this.hooks.onLet(); }

  update(dt) {
    this.now += dt;
    const ball = this.ball;
    if (this.state === 'serve') {
      ball.p.copy(this.server.freeHand); ball.v.set(0, 0, 0); ball.w.set(0, 0, 0);
      if (!this.server.human && this.now > this.aiServeAt) {
        const d = DIFF[this.cfg.diff];
        this.serve({ kind: Math.random() < 0.45 ? 'push' : 'drive', lateral: rnd(-1, 1) * d.place, power: rnd(0.2, 0.8) * d.speed,
          side: Math.random() < d.sideServe ? (Math.random() < 0.5 ? -1 : 1) * rnd(0.5, 1) : 0, spinScale: d.spinScale });
      }
    }
    if (this.state === 'toss' && this.now >= this.serveContact.t) {
      this.state = 'rally';
      this.server.tossT = -1;   // the tossing arm comes back down once the ball is struck
      this.launch(this.server, this.buildServe(this.serveParams), { serve: true });
    }
    for (const p of this.players) if (p.human && p.ctrlX != null && !(this.state === 'serve' && p === this.server)) this.holdLateral(p);
    const P = this.pending;
    if (this.state === 'rally' && P && !P.none) {
      if (!P.hitter.human) {
        if (this.now >= P.tc) {
          if (P.ai.whiff) this.pending = null;
          else this.launch(P.hitter, this.buildShot(P.hitter, ball.p.clone(), P.ai), { crit: P.ai.crit, perfect: P.ai.perfect, kind: P.ai.kind });
        }
      } else if (this.window) {
        const W = this.window;
        if (!W.missed && this.now >= W.tIdeal) {
          const sw = this.hooks.swingState(W.hitter.team);
          const late = this.now - W.tIdeal;
          const stroke = sw.fwd > STROKE_FWD || sw.back > STROKE_BACK;
          // a held racket blocks right away; only a stroke may come a little late (not after the ball drops)
          const dropping = ball.p.y < T.top + 0.1;
          // a late stroke may only catch the ball within ~20 cm of the contact point, however fast it is
          W.lateCap = Math.min(LATE_WINDOW, 0.2 / Math.max(4, ball.v.length()));
          if (stroke || late >= W.lateCap || !sw.touching || dropping || (late >= 0.015 && sw.fwd < 0.3)) this.resolveHuman(W, sw, stroke ? late : 0);
        }
        if (W.missed && this.window === W) {
          this.hooks.onMissWindow(W, W.missReason);
          this.window = null; this.pending = null;
        }
      }
    }
    if (this.inFlight && this.state !== 'serve') {
      let remaining = dt;
      while (remaining > 1e-6) {
        const h = Math.min(DT, remaining); remaining -= h;
        const ev = step(ball, h, true);
        if (ev) {
          if (this.state === 'rally') this.onEvent(ev);
          else if (ev.type === 'table') this.snd.table(ev.speed);
          else if (ev.type === 'floor') this.snd.floor(ev.speed * 0.6);
        }
        if (this.state === 'toss' && ball.p.y < T.top - 0.1) { this.state = 'rally'; this.rally.lastHitter = null; this.onEvent({ type: 'floor', speed: 1 }); }
      }
      if (this.state === 'rally' && (Math.abs(ball.p.x) > 3.7 || Math.abs(ball.p.z) > 6.7 || this.now - this.stateT > 30)) this.onEvent({ type: 'floor', speed: 0 });
    }
    for (const p of this.players) p.update(dt, this.now, this.inFlight ? ball.p : null);
    if (this.state === 'point' && this.now - this.stateT > 1.9) this.nextAfterPoint();
    if (this.state === 'let' && this.now - this.stateT > 1.3) this.startPoint();
    if (this.state === 'break' && this.now - this.stateT > 3.2) this.startPoint();
  }
}
