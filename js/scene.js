// Arena: floor, barriers, stands with crowd, light rigs, the table and a scoreboard screen.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { T } from './physics.js';

export const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

export function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.75 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060a16);
  scene.fog = new THREE.Fog(0x060a16, 12, 30);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 80);

  // ---------- lights
  scene.add(new THREE.HemisphereLight(0x9ab8ff, 0x0b1020, 0.55));
  const sun = new THREE.DirectionalLight(0xf2f6ff, 2.4);
  sun.position.set(1.2, 9, 2.5);
  sun.castShadow = true;
  const sm = MOBILE ? 1024 : 2048;
  sun.shadow.mapSize.set(sm, sm);
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 5.5, bottom: -5.5, near: 3, far: 14 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const rimA = new THREE.SpotLight(0x5fd8ff, 30, 16, 0.5, 0.6, 1.6);
  rimA.position.set(-5, 6, -5); rimA.target.position.set(0, 0.8, 0);
  const rimB = new THREE.SpotLight(0x9b7bff, 30, 16, 0.5, 0.6, 1.6);
  rimB.position.set(5, 6, 5); rimB.target.position.set(0, 0.8, 0);
  scene.add(rimA, rimA.target, rimB, rimB.target);

  // ---------- floor
  const floorTex = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#0d1a33'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {               // subtle grain
      g.fillStyle = `rgba(${150 + Math.random() * 80},${170 + Math.random() * 60},255,${Math.random() * 0.025})`;
      g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 30, 1);
    }
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x223355, map: floorTex, roughness: 0.92, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);
  // court area (classic sports-floor rubber, here a deep cobalt)
  const court = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 13.6),
    new THREE.MeshStandardMaterial({ color: 0x1c3f86, roughness: 0.55, metalness: 0.0 }));
  court.rotation.x = -Math.PI / 2; court.position.y = 0.002; court.receiveShadow = true;
  scene.add(court);

  // ---------- barriers
  const boardTex = canvasTex(1024, 128, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, '#0a1530'); grd.addColorStop(0.5, '#12224a'); grd.addColorStop(1, '#0a1530');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.font = '800 64px Unbounded, Arial Black, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#7de3ff'; g.fillText('СПИН АРЕНА', w * 0.3, h / 2 + 4);
    g.fillStyle = '#b9a6ff'; g.fillText('TOPSPIN', w * 0.78, h / 2 + 4);
    g.fillStyle = '#5ef0ff'; g.fillRect(0, h - 6, w, 6);
  });
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.6, emissive: 0x1a2a55, emissiveMap: boardTex, emissiveIntensity: 0.9 });
  const boardGeo = new THREE.BoxGeometry(1.95, 0.7, 0.04);
  const addBoard = (x, z, ry) => {
    const b = new THREE.Mesh(boardGeo, boardMat);
    b.position.set(x, 0.35, z); b.rotation.y = ry; b.castShadow = false; b.receiveShadow = true;
    scene.add(b);
  };
  for (let i = -3; i <= 3; i++) { addBoard(3.85, i * 1.95, -Math.PI / 2); addBoard(-3.85, i * 1.95, Math.PI / 2); }
  for (let i = -1.5; i <= 1.5; i++) { addBoard(i * 1.95, -6.85, 0); addBoard(i * 1.95, 6.85, Math.PI); }

  // ---------- stands + crowd
  const standMat = new THREE.MeshStandardMaterial({ color: 0x0d1428, roughness: 0.9 });
  for (const side of [-1, 1]) {
    for (let r = 0; r < 6; r++) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(1, 0.45, 16), standMat);
      st.position.set(side * (5.2 + r * 0.9), 0.225 + r * 0.45, 0);
      st.scale.y = 1 + r * 2; st.position.y = (0.45 * (1 + r * 2)) / 2;
      scene.add(st);
    }
  }
  const crowd = buildCrowd(scene);

  // ---------- ceiling light rigs (visible fixtures + soft volumetric cones)
  const coneMat = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.045, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const fixMat = new THREE.MeshBasicMaterial({ color: 0xe8f4ff });
  for (const [x, z] of [[-1.6, -2.4], [1.6, -2.4], [-1.6, 2.4], [1.6, 2.4]]) {
    const fx = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.35), fixMat);
    fx.position.set(x, 7.5, z); scene.add(fx);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.3, 7.4, 32, 1, true), coneMat);
    cone.position.set(x * 0.8, 3.8, z * 0.8); scene.add(cone);
  }

  // ---------- table
  const table = buildTable();
  scene.add(table);

  // ---------- big screen (scoreboard texture is redrawn by the game)
  const sbCanvas = document.createElement('canvas'); sbCanvas.width = 1024; sbCanvas.height = 384;
  const sbTex = new THREE.CanvasTexture(sbCanvas); sbTex.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 1.95),
    new THREE.MeshBasicMaterial({ map: sbTex, toneMapped: false }));
  screen.position.set(0, 4.6, -8.6); scene.add(screen);
  const screen2 = screen.clone(); screen2.position.z = 8.6; screen2.rotation.y = Math.PI; scene.add(screen2);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(5.4, 2.15, 0.1), standMat);
  frame.position.set(0, 4.6, -8.67); scene.add(frame);

  return { renderer, scene, camera, crowd, sun, scoreboard: { canvas: sbCanvas, tex: sbTex }, flip: table.userData.flip };
}

function buildTable() {
  const g = new THREE.Group();
  const W = T.halfW * 2, L = T.halfL * 2;
  // playing surface: painted lines + fine grain so the clearcoat highlight breaks up
  const topTex = canvasTex(1140, 2048, (c, w, h) => {
    const grd = c.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#1d56a8'); grd.addColorStop(1, '#1a4c97');
    c.fillStyle = grd; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 22000; i++) {
      c.fillStyle = 'rgba(' + (Math.random() < 0.5 ? '255,255,255' : '0,10,40') + ',' + (Math.random() * 0.035) + ')';
      c.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
    c.fillStyle = '#f5f8ff';
    const e = Math.round(w * 0.02 / W);                 // 2 cm side and end lines
    c.fillRect(0, 0, w, e); c.fillRect(0, h - e, w, e); c.fillRect(0, 0, e, h); c.fillRect(w - e, 0, e, h);
    c.fillRect(w / 2 - 2, 0, 4, h);                     // 3 mm centre line along the length
  });
  const topMat = new THREE.MeshPhysicalMaterial({ map: topTex, roughness: 0.42, clearcoat: 0.25, clearcoatRoughness: 0.4 });
  const top = new THREE.Mesh(new THREE.PlaneGeometry(W, L), topMat);
  top.rotation.x = -Math.PI / 2; top.position.y = T.top + 0.0005; top.receiveShadow = true;
  g.add(top);
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0x163f80, roughness: 0.45, clearcoat: 0.3 });
  const slab = new THREE.Mesh(new RoundedBoxGeometry(W, T.thick, L, 2, 0.006), bodyMat);
  slab.position.y = T.top - T.thick / 2; slab.castShadow = true; slab.receiveShadow = true; g.add(slab);
  // apron with brand print
  const apronTex = canvasTex(2048, 64, (c, w, h) => {
    c.fillStyle = '#0b1530'; c.fillRect(0, 0, w, h);
    c.font = '800 34px Unbounded, Arial Black, sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'center';
    c.fillStyle = '#e8f1ff'; c.fillText('СПИН АРЕНА', w * 0.25, h / 2 + 2); c.fillText('СПИН АРЕНА', w * 0.75, h / 2 + 2);
    c.fillStyle = '#5ef0ff'; c.fillText('•', w * 0.5, h / 2);
    c.fillStyle = 'rgba(200,220,255,0.75)'; c.fillRect(0, 0, w, 3);
  });
  const apronMat = new THREE.MeshStandardMaterial({ map: apronTex, roughness: 0.5, metalness: 0.2 });
  const apronEnd = new THREE.MeshStandardMaterial({ color: 0x0b1530, roughness: 0.5, metalness: 0.2 });
  const sideApron = new THREE.PlaneGeometry(L - 0.04, 0.06);
  for (const sx of [-1, 1]) {
    const a = new THREE.Mesh(sideApron, apronMat);
    a.rotation.y = sx * Math.PI / 2; a.position.set(sx * (T.halfW - 0.024), T.top - T.thick - 0.03, 0); g.add(a);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.06, L - 0.04), apronEnd);
    back.position.set(sx * (T.halfW - 0.03), T.top - T.thick - 0.03, 0); g.add(back);
  }
  for (const sz of [-1, 1]) {
    const a = new THREE.Mesh(new THREE.BoxGeometry(W - 0.04, 0.06, 0.012), apronEnd);
    a.position.set(0, T.top - T.thick - 0.03, sz * (T.halfL - 0.03)); g.add(a);
  }
  // steel undercarriage: two folding halves with end frames, centre legs, braces and wheels
  const steel = new THREE.MeshPhysicalMaterial({ color: 0x1b2130, roughness: 0.3, metalness: 0.85, clearcoat: 0.6 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd9e2f2, roughness: 0.15, metalness: 1 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.9 });
  const Y = new THREE.Vector3(0, 1, 0);
  const tube = (a, b, r = 0.022, mat = steel) => {
    const d = new THREE.Vector3().subVectors(b, a); const len = d.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(Y, d.normalize());
    m.castShadow = true; g.add(m); return m;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const legX = T.halfW - 0.16, under = T.top - T.thick - 0.06;
  for (const sz of [-1, 1]) {
    const zEnd = sz * (T.halfL - 0.32), zMid = sz * 0.32;
    for (const sx of [-1, 1]) {
      tube(V(sx * legX, 0.1, zEnd), V(sx * legX, under, zEnd), 0.026);
      tube(V(sx * legX, 0.1, zMid), V(sx * legX, under, zMid), 0.02);
      tube(V(sx * legX, 0.24, zEnd), V(sx * legX, under - 0.02, zMid), 0.013);
      tube(V(sx * legX, 0.1, zEnd), V(sx * legX, 0.1, zMid), 0.018);
      for (const zz of [zEnd, zMid]) {
        const fork = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.05), steel); fork.position.set(sx * legX, 0.085, zz); g.add(fork);
        const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.016, 10, 22), rubber);
        tyre.rotation.y = Math.PI / 2; tyre.position.set(sx * legX, 0.052, zz); tyre.castShadow = true; g.add(tyre);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.028, 16), chrome);
        hub.rotation.z = Math.PI / 2; hub.position.set(sx * legX, 0.052, zz); g.add(hub);
      }
    }
    tube(V(-legX, 0.24, zEnd), V(legX, 0.24, zEnd), 0.02);
    tube(V(-legX, under, zEnd), V(legX, under, zEnd), 0.02);
    tube(V(-legX, under, zMid), V(legX, under, zMid), 0.02);
    for (const sx of [-1, 1]) {
      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 16), chrome);
      hinge.rotation.z = Math.PI / 2; hinge.position.set(sx * (legX - 0.06), under, sz * 0.06); g.add(hinge);
    }
  }
  tube(V(0, under, -T.halfL + 0.32), V(0, under, T.halfL - 0.32), 0.024);
  // net assembly
  const netTex = canvasTex(512, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h); c.strokeStyle = 'rgba(10,18,36,0.92)'; c.lineWidth = 1.4;
    for (let x = 0; x <= w; x += 5) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 5) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  }, [8, 1]);
  const net = new THREE.Mesh(new THREE.PlaneGeometry(T.netHalfW * 2, T.netH - 0.012),
    new THREE.MeshStandardMaterial({ map: netTex, transparent: true, side: THREE.DoubleSide, roughness: 1, depthWrite: false, alphaTest: 0.05 }));
  net.position.set(0, T.top + (T.netH - 0.012) / 2, 0); g.add(net);
  const tape = new THREE.Mesh(new RoundedBoxGeometry(T.netHalfW * 2, 0.016, 0.007, 2, 0.003),
    new THREE.MeshStandardMaterial({ color: 0xf6f9ff, roughness: 0.75 }));
  tape.position.set(0, T.top + T.netH - 0.008, 0); tape.castShadow = true; g.add(tape);
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, T.netHalfW * 2, 6), rubber);
  cord.rotation.z = Math.PI / 2; cord.position.set(0, T.top + 0.004, 0); g.add(cord);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, T.netH + 0.03, 14), chrome);
    post.position.set(sx * T.netHalfW, T.top + (T.netH + 0.03) / 2 - 0.02, 0); post.castShadow = true; g.add(post);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 8), chrome); cap.position.set(sx * T.netHalfW, T.top + T.netH + 0.012, 0); g.add(cap);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.022, 0.05), steel);
    arm.position.set(sx * (T.halfW + 0.07), T.top - 0.004, 0); g.add(arm);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.05), steel);
    jaw.position.set(sx * (T.halfW - 0.005), T.top - 0.03, 0); g.add(jaw);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 18), new THREE.MeshStandardMaterial({ color: 0x5ef0ff, roughness: 0.4, emissive: 0x0f3a44 }));
    knob.position.set(sx * (T.halfW - 0.005), T.top - 0.08, 0); g.add(knob);
  }
  // court props: umpire desk with a flip scoreboard, towel boxes
  const desk = new THREE.Group();
  const deskTop = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.04, 0.5, 2, 0.01), new THREE.MeshPhysicalMaterial({ color: 0x0e1834, roughness: 0.4, clearcoat: 0.5 }));
  deskTop.position.y = 0.74; desk.add(deskTop);
  const front = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.02), apronEnd); front.position.set(0, 0.37, 0.24); desk.add(front);
  const flipCanvas = document.createElement('canvas'); flipCanvas.width = 512; flipCanvas.height = 256;
  const flipTex = new THREE.CanvasTexture(flipCanvas); flipTex.colorSpace = THREE.SRGBColorSpace;
  const flipFace = new THREE.MeshBasicMaterial({ map: flipTex, toneMapped: false });
  const flip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.08), [steel, steel, steel, steel, flipFace, flipFace]);
  flip.position.set(0, 0.885, 0); desk.add(flip);
  desk.position.set(2.45, 0, 0); desk.rotation.y = -Math.PI / 2;
  desk.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.add(desk);
  g.userData.flip = { canvas: flipCanvas, tex: flipTex };
  for (const [x, z] of [[1.9, 3.1], [-1.9, -3.1]]) {
    const box = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.62, 0.32, 2, 0.02), new THREE.MeshPhysicalMaterial({ color: 0x14244d, roughness: 0.5, clearcoat: 0.4 }));
    box.position.set(x, 0.31, z); box.castShadow = true; g.add(box);
    const towel = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.06, 0.26, 2, 0.025), new THREE.MeshStandardMaterial({ color: 0xaebbd6, roughness: 1 }));
    towel.position.set(x, 0.65, z); g.add(towel);
  }
  return g;
}

function buildCrowd(scene) {
  const n = MOBILE ? 260 : 520;
  const bodyGeo = new THREE.CapsuleGeometry(0.2, 0.35, 3, 8);
  const headGeo = new THREE.SphereGeometry(0.12, 10, 8);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  const bodies = new THREE.InstancedMesh(bodyGeo, mat, n);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), n);
  const shirts = [0x2a6dd6, 0x5ad1ff, 0x7b5cff, 0x1f2a44, 0xd9e4f5, 0x3a3f58, 0x2fb3a5, 0x9aa7c7];
  const skins = [0xf1c7a6, 0xd9a37e, 0xa8714f, 0x6e452d, 0xe8b996];
  const seats = [];
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    const row = Math.floor(Math.random() * 6);
    const s = { x: side * (5.2 + row * 0.9), y: 0.45 * (1 + row * 2), z: (Math.random() - 0.5) * 15.4, ph: Math.random() * 6.28, amp: 0.4 + Math.random() * 0.6 };
    seats.push(s);
    bodies.setColorAt(i, c.setHex(shirts[i % shirts.length]));
    heads.setColorAt(i, c.setHex(skins[(i * 7) % skins.length]));
  }
  scene.add(bodies, heads);
  const m = new THREE.Matrix4();
  let excite = 0;
  return {
    cheer(v = 1) { excite = Math.max(excite, v); },
    update(t, dt) {
      excite = Math.max(0, excite - dt * 0.6);
      for (let i = 0; i < n; i++) {
        const s = seats[i];
        const jump = excite > 0 ? Math.max(0, Math.sin(t * 9 + s.ph)) * 0.25 * excite * s.amp : 0;
        const sway = Math.sin(t * 1.3 + s.ph) * 0.02;
        m.makeTranslation(s.x, s.y + 0.45 + jump + sway, s.z);
        bodies.setMatrixAt(i, m);
        m.makeTranslation(s.x, s.y + 0.92 + jump + sway, s.z);
        heads.setMatrixAt(i, m);
      }
      bodies.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true;
    },
  };
}
