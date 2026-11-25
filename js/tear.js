// Torn-paper hole, crack-and-shatter reveal, floating particles.
// All coordinates are in print space (1 unit = print width, origin = print centre, y up).

import * as THREE from 'three';

// Small deterministic RNG so a given seed always gives the same tear.
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Hole outline: a rounded rectangle inside the opening, roughened into a torn edge. */
export function holePolygon(P, open) {
  const t = P.torn ?? {};
  const shape = P.shape ?? 'torn';
  const l = open.cx - open.w / 2, r = open.cx + open.w / 2, b = open.cy - open.h / 2, tp = open.cy + open.h / 2;
  if (shape === 'rect') return [new THREE.Vector2(l, b), new THREE.Vector2(r, b), new THREE.Vector2(r, tp), new THREE.Vector2(l, tp)];

  const rand = rng(t.seed ?? 7);
  const inset = t.inset ?? 0.04;               // fraction of the opening kept as border
  const rough = t.roughness ?? 0.05;           // size of the jaggedness, fraction of the opening
  const n = 2 + (t.squareness ?? 0.5) * 8;     // superellipse exponent (2 = oval, 10 = almost square)
  const ax = open.w * (0.5 - inset), ay = open.h * (0.5 - inset);
  const N = 220;
  // low-frequency wobble (big bites) + per-vertex spikes (torn fibres)
  const waves = Array.from({ length: 5 }, (_, k) => ({ f: 2 + k * 2 + Math.floor(rand() * 3), p: rand() * Math.PI * 2, a: (rand() * 0.6 + 0.4) / (k + 1) }));
  const pts = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    const x0 = ax * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y0 = ay * Math.sign(s) * Math.abs(s) ** (2 / n);
    let w = 0;
    for (const q of waves) w += q.a * Math.sin(q.f * th + q.p);
    const spike = (rand() - 0.5) * (rand() < 0.15 ? 2.2 : 0.8);
    const k = Math.min(open.w, open.h) * rough * (0.7 * w + 0.5 * spike);
    const len = Math.hypot(x0, y0) || 1;
    pts.push(new THREE.Vector2(open.cx + x0 + (x0 / len) * k, open.cy + y0 + (y0 / len) * k));
  }
  return pts;
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Big square with the hole cut out (invisible occluder / wall). */
export function wallWithHole(poly, size = 40) {
  const shape = new THREE.Shape([new THREE.Vector2(-size, -size), new THREE.Vector2(size, -size), new THREE.Vector2(size, size), new THREE.Vector2(-size, size)]);
  shape.holes.push(new THREE.Path(poly));
  return new THREE.ShapeGeometry(shape);
}

/** The print with the hole cut out, UV-mapped to the trigger image (desktop preview). */
export function printWithHole(poly, aspect) {
  const shape = new THREE.Shape([new THREE.Vector2(-0.5, -aspect / 2), new THREE.Vector2(0.5, -aspect / 2), new THREE.Vector2(0.5, aspect / 2), new THREE.Vector2(-0.5, aspect / 2)]);
  shape.holes.push(new THREE.Path(poly));
  const g = new THREE.ShapeGeometry(shape);
  printUV(g, aspect);
  return g;
}

function printUV(g, aspect) {
  const p = g.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) + 0.5; uv[i * 2 + 1] = p.getY(i) / aspect + 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function polyCentre(poly) {
  const c = new THREE.Vector2();
  poly.forEach(p => c.add(p));
  return c.multiplyScalar(1 / poly.length);
}

/** Inside of the hole: the thickness of the paper/wall, shaded darker towards the back. */
export function holeWalls(poly, depth, color) {
  const base = new THREE.Color(color), pos = [], col = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    // fake light from above: walls facing up (bottom of the hole) are brighter
    const nx = b.y - a.y, ny = -(b.x - a.x), len = Math.hypot(nx, ny) || 1;
    const lit = 0.55 + 0.45 * Math.max(0, -ny / len);
    const f = base.clone().multiplyScalar(lit), k = base.clone().multiplyScalar(lit * 0.35);
    pos.push(a.x, a.y, 0, b.x, b.y, 0, b.x, b.y, -depth, a.x, a.y, 0, b.x, b.y, -depth, a.x, a.y, -depth);
    for (const c of [f, f, k, f, k, k]) col.push(c.r, c.g, c.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

/** White torn-paper fringe just outside the hole edge, sitting on the print surface. */
export function paperRim(poly, color, seed = 3, width = 0.008) {
  const rand = rng(seed), c = polyCentre(poly), n = poly.length;
  const outer = poly.map(p => {
    const d = p.clone().sub(c).normalize();
    return p.clone().add(d.multiplyScalar(width * (0.25 + rand() * 1.1)));
  });
  const pos = [], col = [], base = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = poly[i], b = poly[j], A = outer[i], B = outer[j];
    const ci = base.clone().multiplyScalar(0.82), co = base;
    pos.push(a.x, a.y, 0, b.x, b.y, 0, B.x, B.y, 0, a.x, a.y, 0, B.x, B.y, 0, A.x, A.y, 0);
    for (const k of [ci, ci, co, ci, co, co]) col.push(k.r, k.g, k.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m.position.z = 0.0008;
  return m;
}

// Sutherland-Hodgman: clip any polygon (the torn hole) by a convex polygon (one crack cell).
function clipConvex(subject, clip) {
  // make the clip polygon counter-clockwise
  let area = 0;
  for (let i = 0; i < clip.length; i++) { const a = clip[i], b = clip[(i + 1) % clip.length]; area += a.x * b.y - b.x * a.y; }
  if (area < 0) clip = [...clip].reverse();
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const A = clip[i], B = clip[(i + 1) % clip.length];
    const inside = p => (B.x - A.x) * (p.y - A.y) - (B.y - A.y) * (p.x - A.x) >= 0;
    const cut = (p, q) => {
      const d1 = (B.x - A.x) * (p.y - A.y) - (B.y - A.y) * (p.x - A.x);
      const d2 = (B.x - A.x) * (q.y - A.y) - (B.y - A.y) * (q.x - A.x);
      return p.clone().lerp(q, d1 / (d1 - d2));
    };
    const input = out; out = [];
    for (let k = 0; k < input.length; k++) {
      const P = input[k], Q = input[(k + 1) % input.length];
      if (inside(Q)) { if (!inside(P)) out.push(cut(P, Q)); out.push(Q); }
      else if (inside(P)) out.push(cut(P, Q));
    }
  }
  return out;
}
const polyArea = pts => Math.abs(pts.reduce((s, a, i) => { const b = pts[(i + 1) % pts.length]; return s + a.x * b.y - b.x * a.y; }, 0)) / 2;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * The print over the hole, pre-broken into thick paper shards. reveal() plays:
 *   cracks spread out from the centre -> shards burst towards the viewer and fall away.
 */
export class Shatter {
  constructor(poly, aspect, printMaterial, opts = {}) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.t = -1;
    const rand = rng(opts.seed ?? 11);
    const centre = polyCentre(poly);
    this.centre = centre;
    const R = Math.max(...poly.map(p => p.distanceTo(centre))) * 1.08;
    this.R = R;
    const thick = opts.thickness ?? 0.006;
    const sideMat = new THREE.MeshBasicMaterial({ color: opts.edgeColor ?? '#e9e4da' });

    // Radial crack pattern: rays out from the impact point, crossed by uneven rings.
    const rays = opts.rays ?? 13, rings = opts.rings ?? 6;
    const angles = Array.from({ length: rays }, (_, i) => ((i + 0.2 + rand() * 0.6) / rays) * Math.PI * 2);
    const radii = Array.from({ length: rings + 1 }, (_, j) => R * ((j / rings) ** 1.25));
    const grid = angles.map(a => radii.map((r, j) => {
      if (j === 0) return centre.clone();
      const aa = a + (rand() - 0.5) * 0.25, rr = j === rings ? r * 1.15 : r * (0.88 + rand() * 0.24);
      return new THREE.Vector2(centre.x + Math.cos(aa) * rr, centre.y + Math.sin(aa) * rr);
    }));
    const cells = [];
    for (let i = 0; i < rays; i++) {
      const i2 = (i + 1) % rays;
      for (let j = 0; j < rings; j++) {
        const a = grid[i][j], b = grid[i2][j], c = grid[i2][j + 1], d = grid[i][j + 1];
        if (j === 0) cells.push([a, c, d]);
        else if (rand() < 0.5) cells.push([a, b, c], [a, c, d]);
        else cells.push([a, b, d], [b, c, d]);
      }
    }

    this.shards = [];
    const crackPts = [];
    // Each shard = the hole outline clipped to one crack cell, so the pieces tile the hole exactly.
    const pieces = cells.map(c => clipConvex(poly, c)).filter(pc => pc.length >= 3 && polyArea(pc) > 1e-6);
    for (const cell of pieces) {
      const cen = cell.reduce((s, p) => s.add(p), new THREE.Vector2()).multiplyScalar(1 / cell.length);
      const g = new THREE.ExtrudeGeometry(new THREE.Shape(cell), { depth: thick, bevelEnabled: false });
      printUV(g, aspect);
      g.translate(-cen.x, -cen.y, -thick + 0.0015);
      const m = new THREE.Mesh(g, [printMaterial, sideMat]);
      m.position.set(cen.x, cen.y, 0);
      m.renderOrder = 5;
      const dist = cen.distanceTo(centre) / R;
      const dir = cen.clone().sub(centre).normalize();
      this.shards.push({
        mesh: m, dist, home: m.position.clone(),
        vel: new THREE.Vector3(dir.x * (0.12 + rand() * 0.3), dir.y * (0.12 + rand() * 0.3) + 0.15, 0.45 + rand() * 0.7),
        spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
        spinRate: 3 + rand() * 6,
      });
      this.group.add(m);
      for (let k = 0; k < cell.length; k++) {
        const p = cell[k], q = cell[(k + 1) % cell.length];
        crackPts.push({ p, q, d: p.clone().add(q).multiplyScalar(0.5).distanceTo(centre) });
      }
    }
    crackPts.sort((a, b) => a.d - b.d);
    const cp = new Float32Array(crackPts.length * 6);
    crackPts.forEach((s, i) => cp.set([s.p.x, s.p.y, 0.0018, s.q.x, s.q.y, 0.0018], i * 6));
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(cp, 3));
    cg.setDrawRange(0, 0);
    this.cracks = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: opts.crackColor ?? '#141414' }));
    this.cracks.renderOrder = 6;
    this.crackCount = crackPts.length * 2;
    this.group.add(this.cracks);

    this.crackTime = opts.crackSec ?? 0.7;
    this.flyTime = opts.flySec ?? 1.8;
  }

  start() { this.t = 0; this.group.visible = true; }
  get done() { return this.t >= this.crackTime + this.flyTime + 0.4; }

  update(dt) {
    if (this.t < 0 || this.done) { if (this.done) this.group.visible = false; return; }
    this.t += dt;
    const t = this.t;
    // 1. cracks race outwards; shards shrink a touch so the dark gaps open up
    const cr = smooth(0, this.crackTime, t);
    this.cracks.geometry.setDrawRange(0, Math.floor(this.crackCount * Math.min(1, cr * 1.3) / 2) * 2);
    for (const s of this.shards) {
      const local = smooth(s.dist * 0.8, s.dist * 0.8 + 0.25, cr);
      const tf = t - this.crackTime - s.dist * 0.35; // centre pieces go first
      if (tf <= 0) {
        s.mesh.scale.setScalar(1 - 0.06 * local);
        s.mesh.position.z = s.home.z + 0.003 * local;
        continue;
      }
      this.cracks.visible = false;
      const g = -1.6;
      s.mesh.position.set(
        s.home.x + s.vel.x * tf,
        s.home.y + s.vel.y * tf + 0.5 * g * tf * tf,
        s.home.z + 0.003 + s.vel.z * tf);
      s.mesh.setRotationFromAxisAngle(s.spin, s.spinRate * tf);
      s.mesh.scale.setScalar(0.94 * (1 - smooth(this.flyTime * 0.6, this.flyTime, tf)));
    }
  }
}

/** Soft floating specks inside the portal; cheap but strong depth cue. */
export class Particles {
  constructor(open, zNear, zFar, opts = {}) {
    const n = opts.count ?? 120, rand = rng(opts.seed ?? 5);
    this.box = { x: open.cx, y: open.cy, w: open.w * 1.6, h: open.h * 1.6, zNear, zFar };
    const p = new Float32Array(n * 3), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      p.set([open.cx + (rand() - 0.5) * this.box.w, open.cy + (rand() - 0.5) * this.box.h, -(zNear + rand() * (zFar - zNear))], i * 3);
      ph[i] = rand() * 6.28;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { size: { value: opts.size ?? 0.006 }, viewH: { value: 1000 }, time: { value: 0 }, color: { value: new THREE.Color(opts.color ?? '#ffffff') }, opacity: { value: opts.opacity ?? 0.7 } },
      vertexShader: `uniform float size; uniform float viewH; uniform float time; attribute float phase; varying float vTw;
        void main(){ vec3 p = position; p.x += 0.01 * sin(time * 0.6 + phase * 3.0); p.y += 0.012 * sin(time * 0.45 + phase);
          vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
          vec3 sx = vec3(modelViewMatrix[0][0], modelViewMatrix[0][1], modelViewMatrix[0][2]);
          gl_PointSize = size * length(sx) * projectionMatrix[1][1] * viewH * 0.5 / -mv.z;
          vTw = 0.6 + 0.4 * sin(time * 2.0 + phase * 7.0); }`,
      fragmentShader: `uniform vec3 color; uniform float opacity; varying float vTw;
        void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(color, opacity * vTw * smoothstep(0.5, 0.0, d)); }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.renderOrder = 4;
    this.points.frustumCulled = false;
  }
  update(dt, renderer) {
    this.mat.uniforms.time.value += dt;
    if (renderer) this.mat.uniforms.viewH.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  }
}
