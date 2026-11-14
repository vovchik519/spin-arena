// Match logic (singles): scoring, service order, rally refereeing, shot construction,
// buffered human strokes and the computer opponent.
import * as THREE from 'three';
import { T, BallState, step, DT, solveShot, solveServe, spinVector, predict, landsLegally } from './physics.js';
import { Athlete } from './athlete.js';

const UP = new THREE.Vector3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;
export const PERFECT_WINDOW = 0.16;   // seconds before contact in which a release counts as perfect

export const DIFF = {
  easy:   { err: 0.14, speed: 0.55, place: 0.55, spin: 0.6, crit: 0.02, move: 4.4, critResp: 0.45 },
  pro:    { err: 0.045, speed: 0.78, place: 0.8, spin: 0.85, crit: 0.1, move: 5.2, critResp: 0.28 },
  master: { err: 0.02, speed: 0.95, place: 0.92, spin: 1, crit: 0.18, move: 6, critResp: 0.16 },
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
        maxSpeed: human ? 6.5 : DIFF[cfg.diff].move,
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
    for (const p of this.players) { p.setPose('ready', this.now); p.hold = false; p.tossT = -1; }
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
    if (p.crit) { hs *= 1.4; top = top * 1.7 + 120; depth = Math.max(depth, 1.08); }
    const target = new THREE.Vector3(lateral, 0, dir * clamp(depth, 0.2, 1.3));
    const w = spinVector(new THREE.Vector3(target.x - C.x, 0, target.z - C.z), top, side);
    let v = solveShot(C, target, hs, w, p.kind === 'smash' || p.crit ? 0.015 : 0.04);
    // solver safety net: if the intended shot would not land, take pace off until it does
    for (let k = 0; k < 4 && !landsLegally(C, v, w, dir); k++) { hs *= 0.82; v = solveShot(C, target, hs, w, 0.05); }
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
      h.goal.set(h.pos.x * 0.6, 0, h.side * (T.halfL + 0.9));
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
      this.window = { hitter: h, tIdeal: tc, C, high, queued: null, t0: this.now };
      this.hooks.onWindow(this.window);
    } else this.scheduleAI(h);
  }

  scheduleAI(h) {
    const P = this.pending, d = DIFF[this.cfg.diff];
    const inc = P.incoming.length(), spin = P.spin.length();
    let err = d.err + Math.max(0, inc - 11) * 0.007 + Math.max(0, spin - 250) * 0.0003 + (this.rally.lastCrit ? d.critResp : 0);
    if (this.rally.serving) err *= 0.5;
    const miss = Math.random() < err;
    const r = Math.random();
    let kind = 'drive';
    if (P.high && r < 0.75) kind = 'smash';
    else if (r < 0.15) kind = 'push';
    const crit = !miss && kind !== 'push' && Math.random() < d.crit + (P.high ? 0.25 : 0);
    P.ai = {
      kind, lateral: rnd(-1, 1) * d.place, power: clamp(rnd(0.3, 1) * d.speed + (kind === 'smash' ? 0.2 : 0), 0, 1),
      side: Math.random() < 0.25 ? rnd(-1, 1) * d.spin : 0,
      error: miss ? rnd(1.2, 2.4) : rnd(0, 0.3), crit, perfect: crit, whiff: miss && Math.random() < 0.15,
    };
    if (kind !== P.stroke && (kind === 'push' || kind === 'smash')) h.planSwing(kind, P.C, P.tc, h.fwd.clone(), this.now, P.stroke === 'bh');
  }

  // A swipe from a human. Shots are buffered: swipe any time while the ball comes,
  // the stroke fires at contact. Releasing in the last moment (green ring) is perfect.
  humanStroke(team, p) {
    if (this.state === 'serve' && this.server.team === team && this.server.human) { this.serve(p); return 'serve'; }
    const W = this.window;
    if (!W || W.hitter.team !== team) return null;
    const left = W.tIdeal - this.now;
    if (left > 1.6) return null;
    const perfect = left <= PERFECT_WINDOW;
    if (W.high && p.kind === 'drive' && p.power > 0.55) p.kind = 'smash';
    p.perfect = perfect;
    p.crit = perfect && (p.kind === 'smash' || p.power > 0.6);
    const pressure = this.incomingPressure();
    p.error = perfect ? pressure * 0.25 : (p.power > 0.85 ? 0.4 : 0.1) + pressure;
    W.queued = p;
    const h = W.hitter, P = this.pending;
    if (p.kind === 'push' || p.kind === 'smash') h.planSwing(p.kind, W.C, W.tIdeal, h.fwd.clone(), this.now, P?.stroke === 'bh');
    else if (h.swing && (h.swing.type === 'push')) h.planSwing(P.stroke === 'smash' ? 'fh' : P.stroke, W.C, W.tIdeal, h.fwd.clone(), this.now);
    this.hooks.onQueued(W, p);
    return perfect ? 'perfect' : 'queued';
  }

  // How hard the incoming ball is to handle: pace, spin and a crit from the other side.
  incomingPressure() {
    const P = this.pending; if (!P || !P.incoming) return 0;
    return Math.max(0, P.incoming.length() - 10) * 0.035 + Math.max(0, P.spin.length() - 250) * 0.0012 + (this.rally.lastCrit ? 0.9 : 0);
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
    const P = this.pending;
    if (this.state === 'rally' && P && !P.none && this.now >= P.tc) {
      if (!P.hitter.human) {
        if (P.ai.whiff) this.pending = null;
        else this.launch(P.hitter, this.buildShot(P.hitter, ball.p.clone(), P.ai), { crit: P.ai.crit, perfect: P.ai.perfect, kind: P.ai.kind });
      } else if (this.window) {
        let q = this.window.queued, auto = false;
        if (!q) { q = { kind: 'block', lateral: rnd(-0.4, 0.4), power: 0.2, error: 0.4 + this.incomingPressure() * 1.3 }; auto = true; }
        this.launch(P.hitter, this.buildShot(P.hitter, ball.p.clone(), q), { crit: q.crit, perfect: q.perfect, kind: q.kind, auto });
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
