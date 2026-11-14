// Visual effects (ball, trail, sparks, shockwaves, timing ring, aim marker) and synthesized sound.
import * as THREE from 'three';
import { BALL_R, T } from './physics.js';

const glowVS = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
varying float vA; varying vec3 vC;
uniform float uScale;
void main(){ vA=aAlpha; vC=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0);
  gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix*mv; }`;
const glowFS = `
varying float vA; varying vec3 vC;
void main(){ vec2 d=gl_PointCoord-0.5; float r=length(d); if(r>0.5) discard;
  float a = smoothstep(0.5,0.0,r); a*=a; gl_FragColor=vec4(vC*(1.0+a), a*vA); }`;

function pointCloud(n) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: glowVS, fragmentShader: glowFS, uniforms: { uScale: { value: 600 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
  return pts;
}

function ringTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineWidth = 7; g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 2; g.globalAlpha = 0.5; g.beginPath(); g.arc(64, 64, 44, 0, Math.PI * 2); g.stroke();
  const t = new THREE.CanvasTexture(c); return t;
}

export class FX {
  constructor(scene) {
    this.scene = scene;
    // ball with a printed seam + logo so spin reads on screen
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#fbfcff'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = 'rgba(120,140,170,0.35)'; g.fillRect(0, 62, 256, 4);
    g.fillStyle = '#1b2a4a'; g.font = '700 22px Arial'; g.textAlign = 'center'; g.fillText('★★★', 64, 50); g.fillText('40+', 192, 92);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.ballMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, emissive: 0x000000 });
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), this.ballMat);
    scene.add(this.ball);
    this.squash = 0; this.squashDir = new THREE.Vector3(0, 1, 0);
    // contact shadow under the ball (always crisp, helps read depth)
    const sc = document.createElement('canvas'); sc.width = sc.height = 64;
    const sg = sc.getContext('2d'); const gr = sg.createRadialGradient(32, 32, 2, 32, 32, 30);
    gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); sg.fillStyle = gr; sg.fillRect(0, 0, 64, 64);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.08),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2; scene.add(this.shadow);

    this.trailN = 48;
    this.trail = pointCloud(this.trailN); scene.add(this.trail);
    this.trailPts = []; this.trailHeat = 0; this.trailColor = new THREE.Color(0x9fe8ff);

    this.sparkN = 260;
    this.sparks = pointCloud(this.sparkN); scene.add(this.sparks);
    this.sp = Array.from({ length: this.sparkN }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, size: 1, c: new THREE.Color() }));
    this.spi = 0;

    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.8, 1, 48);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x7ff0ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      m.visible = false; scene.add(m); this.rings.push({ m, life: 0, max: 1, grow: 1, flat: false });
    }
    this.timing = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color: 0xffffff, transparent: true, depthTest: false, depthWrite: false }));
    this.timing.renderOrder = 10; this.timing.visible = false; scene.add(this.timing);

    const mk = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.07, 32),
      new THREE.MeshBasicMaterial({ color: 0x7ff0ff, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    mk.rotation.x = -Math.PI / 2; mk.visible = false; scene.add(mk); this.marker = mk;
    this.flash = 0;
  }

  setPointScale(h, fovDeg) {
    const s = h / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    this.trail.material.uniforms.uScale.value = s; this.sparks.material.uniforms.uScale.value = s;
  }

  setBall(p, w, dt) {
    this.ball.position.copy(p);
    const wl = w.length();
    if (wl > 0.01) this.ball.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(w.clone().divideScalar(wl), Math.min(wl * dt, 0.5)));
    // brief squash on impacts
    this.squash = Math.max(0, this.squash - dt * 14);
    const s = 1 - this.squash * 0.35;
    this.ball.scale.set(1 + this.squash * 0.2, s, 1 + this.squash * 0.2);
    const onTable = Math.abs(p.x) < T.halfW && Math.abs(p.z) < T.halfL;
    const gy = onTable ? T.top + 0.002 : 0.004;
    this.shadow.position.set(p.x, gy, p.z);
    const hgt = Math.max(0, p.y - gy);
    this.shadow.scale.setScalar(1 + hgt * 1.2);
    this.shadow.material.opacity = Math.max(0, 0.9 - hgt * 0.7);
  }

  impactSquash() { this.squash = 1; }

  pushTrail(p, heat) {
    this.trailPts.unshift(p.clone());
    if (this.trailPts.length > this.trailN) this.trailPts.pop();
    this.trailHeat = heat;
  }
  clearTrail() { this.trailPts.length = 0; }

  burst(p, n, color, speed = 3, size = 0.05, life = 0.6, up = 0) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const s = this.sp[this.spi]; this.spi = (this.spi + 1) % this.sparkN;
      s.p.copy(p);
      s.v.set(Math.random() - 0.5, Math.random() - 0.5 + up, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      s.life = s.max = life * (0.5 + Math.random() * 0.7); s.size = size * (0.6 + Math.random() * 0.8);
      s.c.copy(c).lerp(new THREE.Color(0xffffff), Math.random() * 0.4);
    }
  }

  ring(p, color, size, life, flatOnTable = false, faceDir = null) {
    const r = this.rings.find(r => r.life <= 0) || this.rings[0];
    r.m.visible = true; r.m.position.copy(p); r.life = r.max = life; r.grow = size; r.flat = flatOnTable;
    r.m.material.color.set(color);
    if (flatOnTable) r.m.rotation.set(-Math.PI / 2, 0, 0);
    else if (faceDir) r.m.lookAt(v.copy(p).add(faceDir));
    r.billboard = !flatOnTable && !faceDir;
  }

  showMarker(p, color) {
    this.marker.visible = !!p;
    if (p) { this.marker.position.set(p.x, T.top + 0.003, p.z); this.marker.material.color.set(color); }
  }

  update(dt, camera, time) {
    // trail
    const tp = this.trail.geometry.attributes;
    const heat = this.trailHeat;
    const col = this.trailColor;
    for (let i = 0; i < this.trailN; i++) {
      const q = this.trailPts[i];
      if (q) {
        tp.position.setXYZ(i, q.x, q.y, q.z);
        const f = 1 - i / this.trailN;
        tp.aSize.setX(i, (0.035 + heat * 0.06) * (0.4 + f * 0.6));
        tp.aAlpha.setX(i, f * f * (0.25 + heat * 0.75));
        tp.aColor.setXYZ(i, col.r, col.g, col.b);
      } else tp.aAlpha.setX(i, 0);
    }
    tp.position.needsUpdate = tp.aSize.needsUpdate = tp.aAlpha.needsUpdate = tp.aColor.needsUpdate = true;
    // sparks
    const sa = this.sparks.geometry.attributes;
    for (let i = 0; i < this.sparkN; i++) {
      const s = this.sp[i];
      if (s.life > 0) {
        s.life -= dt; s.v.y -= 6 * dt; s.v.multiplyScalar(1 - 2.2 * dt); s.p.addScaledVector(s.v, dt);
        const k = Math.max(0, s.life / s.max);
        sa.position.setXYZ(i, s.p.x, s.p.y, s.p.z); sa.aSize.setX(i, s.size * (0.4 + k)); sa.aAlpha.setX(i, k);
        sa.aColor.setXYZ(i, s.c.r, s.c.g, s.c.b);
      } else sa.aAlpha.setX(i, 0);
    }
    sa.position.needsUpdate = sa.aSize.needsUpdate = sa.aAlpha.needsUpdate = sa.aColor.needsUpdate = true;
    // rings
    for (const r of this.rings) {
      if (r.life <= 0) { r.m.visible = false; continue; }
      r.life -= dt;
      const k = 1 - Math.max(0, r.life) / r.max;
      r.m.scale.setScalar(0.02 + r.grow * (1 - (1 - k) * (1 - k)));
      r.m.material.opacity = (1 - k) * 0.9;
      if (r.billboard) r.m.quaternion.copy(camera.quaternion);
    }
    this.ballMat.emissive.setRGB(heat * 0.3, heat * 0.8, heat * 1.0);
    this.marker.scale.setScalar(1 + Math.sin(time * 8) * 0.12);
  }
}
const v = new THREE.Vector3();

// ---------------- Sound: everything synthesized, no files needed
export class Sound {
  constructor() { this.on = true; this.ctx = null; }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.8; this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 1.5;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { this.ctx = null; }
  }
  _env(node, t, a, peak, decay) {
    peak = Math.max(peak, 0.001);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + decay);
    node.connect(g); g.connect(this.master); return g;
  }
  // Hollow celluloid "tock": a short noise click through a resonant band + a pitched body.
  tock(freq, vol, decay = 0.06, q = 6) {
    if (!this.on || !this.ctx || !(vol > 0.003)) return;
    const t = this.ctx.currentTime;
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    n.connect(bp); this._env(bp, t, 0.001, vol, decay); n.start(t); n.stop(t + decay + 0.05);
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(freq * 0.8, t); o.frequency.exponentialRampToValueAtTime(freq * 0.45, t + decay);
    this._env(o, t, 0.001, vol * 0.5, decay * 0.8); o.start(t); o.stop(t + decay + 0.05);
  }
  paddle(speed) { this.tock(1500 + Math.random() * 200, Math.min(0.9, 0.25 + speed / 30), 0.05, 3.5); }
  table(speed) { this.tock(2300 + Math.random() * 300, Math.min(0.8, 0.15 + speed / 14), 0.045, 5); }
  floor(speed) { this.tock(1100, Math.min(0.4, speed / 12), 0.05, 4); }
  net() { this.tock(420, 0.4, 0.09, 1.5); }
  boom() {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.5);
    this._env(o, t, 0.005, 0.9, 0.55); o.start(t); o.stop(t + 0.7);
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.Q.value = 0.7;
    hp.frequency.setValueAtTime(600, t); hp.frequency.exponentialRampToValueAtTime(5000, t + 0.35);
    n.connect(hp); this._env(hp, t, 0.02, 0.35, 0.4); n.start(t); n.stop(t + 0.6);
  }
  crowd(level = 1) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime, dur = 1.2 + level;
    const n = this.ctx.createBufferSource(); n.buffer = this.noise; n.loop = true;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.5;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 7; const lg = this.ctx.createGain(); lg.gain.value = 250;
    lfo.connect(lg); lg.connect(bp.frequency); lfo.start(t); lfo.stop(t + dur);
    n.connect(bp); this._env(bp, t, 0.25, 0.12 * level, dur); n.start(t); n.stop(t + dur + 0.3);
  }
  ui() { this.tock(3000, 0.15, 0.03, 8); }
}
