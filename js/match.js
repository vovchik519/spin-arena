// Match logic (singles): scoring, service order, rally refereeing, shot construction,
// human strokes (you move with your thumb, a flick is the stroke) and the computer opponent.
import * as THREE from 'three';
import { T, BallState, step, DT, solveShot, solveServe, spinVector, predict, landsLegally } from './physics.js';
import { Athlete } from './athlete.js';

const UP = new THREE.Vector3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;
export const HUMAN_SPEED = 6;          // m/s, the legs limit you, not the finger
const LATENCY = 0.03;                  // touch-to-frame latency compensation, s

// Timing windows around the ideal contact moment; they tighten as the ball gets faster.
export function windows(v, mult = 1) {
  const k = clamp((v - 8) / 12, 0, 1), L = THREE.MathUtils.lerp;
  return { P: L(0.07, 0.05, k) * mult, G: L(0.15, 0.11, k) * mult, late: L(0.12, 0.09, k) * mult };
}
// Where the contact point sits relative to the body: comfortable, a stretch, or out of reach.
export function reachZone(h, cx, v) {
  const rel = (cx - h.pos.x) * h.rs.x;
  const grow = 0.015 * Math.max(0, v - 10);
  const out = Math.max(0, (-0.38 - grow) - rel, rel - (0.8 + grow));
  return out <= 0 ? 'core' : out <= 0.28 ? 'stretch' : 'out';
}
function sampleAt(samples, t) {
  let best = null, bd = 1e9;
  for (const s of samples) { const d = Math.abs(s.t - t); if (d < bd) { bd = d; best = s; } }
  return best ? best.p.clone() : null;
}

export const DIFF = {
  easy:   { err: 0.12, speed: 0.55, place: 0.5, spin: 0.6, crit: 0.0, move: 4.4, critResp: 0.45, win: 1.35, tele: 0.45, autoBlock: true },
  pro:    { err: 0.05, speed: 0.78, place: 0.8, spin: 0.85, crit: 0.05, move: 5.2, critResp: 0.28, win: 1, tele: 0.3, autoBlock: false },
  master: { err: 0.02, speed: 0.95, place: 0.92, spin: 1, crit: 0.1, move: 6, critResp: 0.16, win: 0.85, tele: 0.18, autoBlock: false },
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
      a.human = human;
      a.place(new THREE.Vector3(0.15 * (team === 0 ? 1 : -1), 0, (team === 0 ? 1 : -1) * 2.1));
      this.players.push(a);
    }
    this.score = [0, 0]; this.games = [0, 0];
    this.gamesToWin = cfg.bestOf === 1 ? 1 : cfg.bestOf === 3 ? 2 : 3;
    this.firstServer = Math.random() < 0.5 ? 0 : 1;
    this.state = 'intro'; this.now = 0; this.stateT = 0;
    this.rally = null; this.pending = null; this.window = null; this.inFlight = false;
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
    const target = new THREE.Vector3(clamp(params.lateral * 0.55, -0.62, 0.62), 0, dir * clamp(depth, 0.25, 1.22));
    const top = short ? -rnd(160, 260) : 60 + params.power * 160;
    const w = spinVector(new THREE.Vector3(target.x - C.x, 0, target.z - C.z), top, (params.side || 0) * 160);
    const v = solveServe(C, target, short ? 4.2 : 5.2 + params.power * 4.5, w);
    return { v, w, target };
  }

  buildShot(hitter, C, p) {
    const dir = -hitter.side;
    let depth, hs, top;
    const side = (p.side || 0) * 140;
    const lateral = clamp(p.lateral, -1, 1) * 0.64;
    if (p.kind === 'push') { depth = rnd(0.45, 0.85); hs = rnd(4.2, 5.5); top = -rnd(140, 240); }
    else if (p.kind === 'smash') { depth = 0.9 + p.power * 0.3; hs = 20 + p.power * 8; top = 40; }
    else if (p.kind === 'block') { depth = rnd(0.6, 1.0); hs = rnd(5.5, 7); top = 60; }
    else { depth = 0.7 + p.power * 0.55; hs = 7.5 + p.power * 11; top = 120 + p.power * 260; }
    if (p.depth) depth = p.depth;
    if (p.crit) { hs *= 1.4; top = top * 1.7 + 120; depth = Math.max(depth, 1.08); }
    const target = new THREE.Vector3(lateral, 0, dir * clamp(depth, 0.2, 1.3));
    const w = spinVector(new THREE.Vector3(target.x - C.x, 0, target.z - C.z), top, side);
    let v = solveShot(C, target, hs, w, p.kind === 'smash' || p.crit ? 0.015 : 0.04);
    // solver safety net: if the intended shot would not land, take pace off until it does
    for (let k = 0; k < 4 && !landsLegally(C, v, w, dir); k++) { hs *= 0.82; v = solveShot(C, target, hs, w, 0.05); }
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
    this.snd.paddle(shot.v.length());
    if (navigator.vibrate && hitter.human) try { navigator.vibrate(quality.crit ? [30, 30, 60] : 14); } catch (e) {}
    this.fx.impactSquash();
    this.hooks.onHit(hitter, shot, quality, this.ball.p.clone());
    if (hitter.human) hitter.goal.z = hitter.side * (T.halfL + 0.75);
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
        if (ev.side === h.side) bounceT = ev.t; else ok = false;
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
    if (!best) { this.pending = { hitter: h, none: true }; return; }
    const tc = this.now + best.t, C = best.p.clone();
    const high = C.y > T.top + 0.38;
    const rel = new THREE.Vector3().subVectors(C, h.pos).dot(h.rs);
    const stroke = high ? 'smash' : rel > -0.12 ? 'fh' : 'bh';
    this.pending = { hitter: h, tc, C, high, stroke, incoming: best.v.clone(), spin: best.w.clone() };
    h.planSwing(stroke, C, tc, h.fwd.clone(), this.now);
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
    if (this.rally.serving) err *= 0.5;
    const miss = Math.random() < err;
    const r = Math.random();
    let kind = 'drive';
    if (P.high && r < 0.75) kind = 'smash';
    else if (r < 0.15) kind = 'push';
    const crit = !miss && kind !== 'push' && Math.random() < (P.high ? 0.3 + d.crit : d.crit * 0.3);
    const opp = this.players[1 - h.team];
    const away = -(Math.sign(opp.pos.x) || (Math.random() < 0.5 ? 1 : -1));
    const lateral = Math.random() < 0.65 ? away * rnd(0.45, 1) * d.place : rnd(-1, 1) * d.place;
    P.ai = {
      kind, lateral, power: clamp(rnd(0.3, 1) * d.speed + (kind === 'smash' ? 0.2 : 0), 0, 1),
      side: Math.random() < 0.25 ? rnd(-1, 1) * d.spin : 0,
      error: miss ? rnd(1.2, 2.4) : rnd(0, 0.3), crit, perfect: crit, whiff: miss && Math.random() < 0.15,
    };
    P.ai.depth = kind === 'push' ? rnd(0.45, 0.8) : kind === 'smash' ? 1.05 : clamp(0.7 + P.ai.power * 0.55, 0.3, 1.25);
    P.teleT = P.tc - d.tele; P.teleShown = false;
    if (kind !== P.stroke && (kind === 'push' || kind === 'smash')) h.planSwing(kind, P.C, P.tc, h.fwd.clone(), this.now, P.stroke === 'bh');
  }

  // ------------------------------------------------------------ human strokes
  // Release of a flick = the stroke. Timing against the ideal contact moment decides
  // the result deterministically: early pulls the ball cross-court and long, late pushes
  // it wide and into the net. A very early flick is held until the earliest contact.
  humanStroke(team, p) {
    if (this.state === 'serve' && this.server.team === team && this.server.human) { this.serve(p); return 'serve'; }
    const W = this.window;
    if (!W || W.hitter.team !== team || W.shot || W.missed) return null;
    const d = this.now + LATENCY - W.tIdeal;
    if (d < -0.6) return null;                      // far too early: treat as an accidental touch
    const win = W.win;
    if (d > win.late) { W.missed = true; W.missReason = 'late'; return 'late'; }
    let e = 0;
    if (Math.abs(d) > win.P) e = Math.sign(d) * Math.min(2, (Math.abs(d) - win.P) / (win.G - win.P));
    const tc = d < -win.G ? Math.max(W.tIdeal - win.G, W.minT) : Math.max(this.now + 0.04, W.minT);
    const C = sampleAt(W.samples, tc - W.t0) || W.C;
    if (W.high && p.kind === 'drive' && p.power > 0.55) p.kind = 'smash';
    p.timing = e; p.perfect = e === 0;
    W.shot = { p, tc, C };
    const h = W.hitter;
    const rel = (C.x - h.pos.x) * h.rs.x;
    const bh = rel < -0.12;
    const type = p.kind === 'push' || p.kind === 'smash' ? p.kind : bh ? 'bh' : 'fh';
    h.planSwing(type, C, tc, h.fwd.clone(), this.now, bh);
    this.holdLateral(h);
    const tag = e === 0 ? 'perfect' : Math.abs(e) <= 1 ? (e < 0 ? 'early' : 'late') : (e < 0 ? 'very-early' : 'very-late');
    this.hooks.onSwing(W, p, tag);
    return tag;
  }

  holdLateral(h) { h.goal.x = h.ctrlX ?? h.pos.x; }

  fireHuman(W) {
    const h = W.hitter, p = W.shot.p, ball = this.ball;
    const zone = reachZone(h, ball.p.x, W.v);
    if (zone === 'out') { W.missed = true; W.missReason = 'far'; return; }
    const stretch = zone === 'stretch';
    if (stretch) p.power = Math.min(p.power, 0.6);
    p.crit = p.perfect && !stretch && (p.kind === 'smash' || p.power >= 0.75);
    // deterministic deviation from timing, scaled by pace, ambition and reach
    const e = p.timing, ae = Math.abs(e);
    const scale = (0.6 + 0.8 * p.power) * (1 + 0.03 * Math.max(0, W.v - 10)) * (1 + 0.4 * Math.abs(p.lateral))
      * (stretch ? 2 : 1) * (this.rally.lastCrit ? 1.3 : 1);
    const cx = Math.sign(ball.p.x) || 1;
    let yaw = THREE.MathUtils.degToRad(6 * ae * scale + (stretch ? 3 : 0));
    let pitch = THREE.MathUtils.degToRad(e < 0 ? 1.2 * ae * scale : -1.5 * ae * scale);
    // reading spin: a drive against backspin sinks, a push against topspin floats
    const top = W.spin.dot(new THREE.Vector3(0, 1, 0).cross(new THREE.Vector3(0, 0, h.side)));
    if (!p.perfect && p.kind !== 'push' && top < -60) pitch -= THREE.MathUtils.degToRad(1.4 * Math.min(2, -top / 250));
    if (!p.perfect && p.kind === 'push' && top > 60) pitch += THREE.MathUtils.degToRad(1.6 * Math.min(2, top / 250));
    p.dev = { xSign: e < 0 ? -cx : cx, yaw, pitch };
    p.error = 0;
    this.rally.lastHuman = { lateral: p.lateral, perfect: p.perfect };
    const shot = this.buildShot(h, ball.p.clone(), p);
    this.launch(h, shot, { crit: p.crit, perfect: p.perfect, kind: p.kind, timing: e, zone });
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
      for (const p of this.players) p.setPose(p.team === r.team ? 'win' : 'sad', this.now);
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
        this.serve({ kind: Math.random() < 0.45 ? 'push' : 'drive', lateral: rnd(-1, 1) * d.place, power: rnd(0.2, 0.8) * d.speed, side: Math.random() < 0.5 ? rnd(-1, 1) : 0 });
      }
    }
    if (this.state === 'toss' && this.now >= this.serveContact.t) {
      this.state = 'rally';
      this.launch(this.server, this.buildServe(this.serveParams), { serve: true });
    }
    for (const p of this.players) if (p.human && p.ctrlX != null && !(this.state === 'serve' && p === this.server)) p.goal.x = p.ctrlX;
    const P = this.pending;
    if (this.state === 'rally' && P && !P.none) {
      if (!P.hitter.human) {
        if (!P.teleShown && this.now >= P.teleT) {
          P.teleShown = true;
          const dir = -P.hitter.side;
          this.hooks.onTelegraph(new THREE.Vector3(clamp(P.ai.lateral, -1, 1) * 0.64, T.top, dir * P.ai.depth), P.hitter.team);
        }
        if (this.now >= P.tc) {
          if (P.ai.whiff) this.pending = null;
          else this.launch(P.hitter, this.buildShot(P.hitter, ball.p.clone(), P.ai), { crit: P.ai.crit, perfect: P.ai.perfect, kind: P.ai.kind });
        }
      } else if (this.window) {
        const W = this.window;
        if (W.shot && !W.missed && this.now >= W.shot.tc) this.fireHuman(W);
        else if (!W.shot && !W.missed && this.now > W.tIdeal + W.win.late) {
          const easy = this.cfg.opp === 'cpu' && DIFF[this.cfg.diff].autoBlock;
          if (easy && reachZone(W.hitter, ball.p.x, W.v) === 'core') {
            const q = { kind: 'block', lateral: 0, power: 0.2, depth: 0.5 };
            this.launch(W.hitter, this.buildShot(W.hitter, ball.p.clone(), q), { kind: 'block', auto: true });
          } else { W.missed = true; W.missReason = 'none'; }
        }
        if (W.missed && this.window === W) {
          this.hooks.onMissWindow(W, W.missReason);
          W.hitter.goal.z = W.hitter.side * (T.halfL + 0.75);
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
