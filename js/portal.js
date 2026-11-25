// Builds the "window into another world" that sits behind a tracked print.
//
// Units: 1 unit = the full width of the print. Origin = centre of the print,
// x right, y up, z towards the viewer (app.js maps each 8th Wall image target into this space).
// Everything "inside" the portal sits at negative z, hidden by an invisible wall at z=0
// that has the opening cut out of it, so it looks like a hole in the wall.
// Real parallax comes for free: the content really is behind the print in 3D,
// and the tracked camera moves around it.

import * as THREE from 'three';
import { holePolygon, wallWithHole, holeWalls, paperRim, Shatter, Particles } from './tear.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

const PLANE_VERT = /* glsl */`
  uniform sampler2D depthMap;
  uniform vec4 depthRect;      // uv sub-rect for depth (x, y, w, h)
  uniform float useDepth;
  uniform float depthAmount;   // how far white (near) pixels move towards the viewer
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position;
    if (useDepth > 0.5) {
      float d = texture2D(depthMap, depthRect.xy + uv * depthRect.zw).r;
      p.z += d * depthAmount;
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

const PLANE_FRAG = /* glsl */`
  uniform sampler2D map;
  uniform vec4 colorRect;      // uv sub-rect for colour (x, y, w, h)
  uniform float opacity;
  uniform float edgeFade;      // 0..0.5, fraction of the plane that fades out at the edges
  uniform vec3 fadeColor;
  uniform float fadeToColor;   // 1 = fade to fadeColor (opaque planes), 0 = fade alpha
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(map, colorRect.xy + vUv * colorRect.zw);
    float e = 1.0;
    if (edgeFade > 0.0) {
      vec2 k = smoothstep(vec2(0.0), vec2(edgeFade), vUv) * smoothstep(vec2(0.0), vec2(edgeFade), 1.0 - vUv);
      e = k.x * k.y;
    }
    vec3 rgb = c.rgb;
    float a = c.a * opacity;
    if (fadeToColor > 0.5) rgb = mix(fadeColor, rgb, e); else a *= e;
    if (a < 0.003) discard;
    gl_FragColor = vec4(rgb, a);
  }`;

// Colour is passed straight through (sRGB in, sRGB out) so video/images look exactly as authored.
function planeMaterial(map, { transparent = false, edgeFade = 0, fadeColor = '#000', depth = null } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: PLANE_VERT,
    fragmentShader: PLANE_FRAG,
    transparent,
    depthWrite: !transparent,
    side: THREE.DoubleSide,
    uniforms: {
      map: { value: map },
      colorRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      opacity: { value: 1 },
      edgeFade: { value: edgeFade },
      fadeColor: { value: new THREE.Color(fadeColor) },
      fadeToColor: { value: transparent ? 0 : 1 },
      depthMap: { value: depth?.map ?? null },
      depthRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      useDepth: { value: depth ? 1 : 0 },
      depthAmount: { value: depth?.amount ?? 0 },
    },
  });
}

// Content inside the portal needs nothing special: the occluder (below) hides whatever is
// not seen through the hole, using the depth buffer. No stencil buffer needed, so it works
// with whatever WebGL context the AR engine creates.
function insidePortal(mat) { return mat; }

// "Print surface with a hole in it". Discards fragments inside the opening (rectangle or mask image).
// With colorWrite off it is an invisible occluder; with a map it draws the print (desktop preview).
export function holeMaterial({ map = null, mask = null, openingUV = [0, 0, 1, 1], colorWrite = true }) {
  const m = new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D map; uniform sampler2D mask; uniform float useMap; uniform float useMask; uniform vec4 opening; varying vec2 vUv;
      void main(){
        bool inside;
        if (useMask > 0.5) { vec4 mk = texture2D(mask, vUv); inside = mk.r * mk.a > 0.5; }
        else inside = all(greaterThan(vUv, opening.xy)) && all(lessThan(vUv, opening.xy + opening.zw));
        if (inside) discard;
        gl_FragColor = useMap > 0.5 ? texture2D(map, vUv) : vec4(0.0);
      }`,
    uniforms: {
      map: { value: map }, mask: { value: mask }, useMap: { value: map ? 1 : 0 }, useMask: { value: mask ? 1 : 0 },
      opening: { value: new THREE.Vector4(...openingUV) },
    },
    colorWrite,
  });
  return m;
}

// Big flat ring around the print (the rest of the wall), with a hole exactly the size of the print.
export function wallRingGeometry(aspect, size = 40) {
  const shape = new THREE.Shape();
  shape.moveTo(-size, -size); shape.lineTo(size, -size); shape.lineTo(size, size); shape.lineTo(-size, size); shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-0.5, -aspect / 2); hole.lineTo(-0.5, aspect / 2); hole.lineTo(0.5, aspect / 2); hole.lineTo(0.5, -aspect / 2); hole.closePath();
  shape.holes.push(hole);
  return new THREE.ShapeGeometry(shape);
}

function loadTexture(url) {
  return new Promise((res, rej) => new THREE.TextureLoader().load(url, res, undefined, rej));
}

// Quad with per-vertex colours (used for the reveal / wall thickness, shaded darker towards the back).
function shadedQuad(p0, p1, p2, p3, cFront, cBack) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...p0.toArray(), ...p1.toArray(), ...p2.toArray(), ...p3.toArray()], 3));
  const col = [cFront, cFront, cBack, cBack].flatMap(c => [c.r, c.g, c.b]);
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/**
 * @param {object} cfg       parsed config.json
 * @param {number} aspect    print height / width (from the trigger image)
 * @param {HTMLImageElement} printImage  the trigger image (used for the shards of the shatter reveal)
 */
export async function buildPortal(cfg, aspect, printImage = null) {
  const P = cfg.portal ?? {};
  const toUnits = m => m / (cfg.printWidthMeters || 1);
  const root = new THREE.Group();
  root.name = 'portal';

  // Opening rectangle, normalised to the trigger image (x, y, w, h from the top-left).
  const [ox, oy, ow, oh] = P.opening ?? [0, 0, 1, 1];
  const open = {
    cx: ox + ow / 2 - 0.5,
    cy: aspect / 2 - (oy + oh / 2) * aspect,
    w: ow,
    h: oh * aspect,
  };
  const bg = P.backgroundColor ?? '#05060a';

  // Everything seen through the hole lives in `inner`, hidden until the reveal starts.
  const inner = new THREE.Group();
  root.add(inner);
  const poly = holePolygon(P, open);

  // 1. Occluder: an invisible wall at z=0 with the hole cut out, drawn first. It only writes depth,
  //    so the camera feed stays visible but anything behind the wall is hidden except through the hole.
  if (P.mask) {
    const maskTex = await loadTexture(P.mask);
    const occluder = new THREE.Mesh(new THREE.PlaneGeometry(1, aspect), holeMaterial({ mask: maskTex, colorWrite: false }));
    const ring = new THREE.Mesh(wallRingGeometry(aspect), new THREE.MeshBasicMaterial({ colorWrite: false }));
    for (const m of [occluder, ring]) { m.renderOrder = -10; root.add(m); }
  } else {
    const occluder = new THREE.Mesh(wallWithHole(poly), new THREE.MeshBasicMaterial({ colorWrite: false }));
    occluder.renderOrder = -10;
    root.add(occluder);
  }

  // 2. The thickness of the wall/paper around the hole, and a torn white paper fringe on the surface.
  const reveal = toUnits(P.revealDepthMeters ?? 0);
  if (reveal > 0 && !P.mask) { const w = holeWalls(poly, reveal, P.revealColor ?? '#3a3a3a'); w.renderOrder = 1; inner.add(w); }
  let rim = null;
  if ((P.shape ?? 'torn') === 'torn' && !P.mask && P.paperEdge !== false) {
    rim = paperRim(poly, P.paperEdgeColor ?? '#f6f3ec', 3, toUnits(P.paperEdgeMeters ?? 0.008));
    rim.renderOrder = 7;
    rim.visible = false;
    root.add(rim);
  }

  // 3. Video (or still image) at depth, optionally displaced by a depth map for 2.5D parallax.
  const vc = cfg.video ?? {};
  const depthU = toUnits(vc.depthMeters ?? 4);
  const video = document.createElement('video');
  Object.assign(video, { src: vc.src, loop: vc.loop ?? true, muted: vc.muted ?? true, playsInline: true, crossOrigin: 'anonymous', preload: 'auto' });
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  if (video.muted) video.setAttribute('muted', '');
  const vtex = new THREE.VideoTexture(video);
  vtex.minFilter = THREE.LinearFilter;
  vtex.generateMipmaps = false;

  const dcfg = vc.depthMap ?? { type: 'none' };
  let depth = null;
  if (dcfg.type === 'sbs') depth = { map: vtex, amount: toUnits(dcfg.amountMeters ?? depthU * 0.5) };
  if (dcfg.type === 'image') depth = { map: await loadTexture(dcfg.src), amount: toUnits(dcfg.amountMeters ?? 1) };

  const segs = depth ? [256, 144] : [1, 1];
  const vmat = planeMaterial(vtex, { edgeFade: vc.edgeFade ?? 0.06, fadeColor: bg, depth });
  if (dcfg.type === 'sbs') {
    vmat.uniforms.colorRect.value.set(0, 0, 0.5, 1);
    vmat.uniforms.depthRect.value.set(0.5, 0, 0.5, 1);
  }
  insidePortal(vmat);
  const vmesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, ...segs), vmat);
  vmesh.renderOrder = 2;
  vmesh.position.set(open.cx + (vc.offset?.[0] ?? 0) * open.w, open.cy + (vc.offset?.[1] ?? 0) * open.h, -depthU);
  inner.add(vmesh);

  // Size the video so its edges stay out of view through the hole from reasonable angles.
  // "auto" scale grows with depth: the further back, the more of it you can see by moving
  // (covers viewing angles up to roughly 35-40 degrees off-axis).
  const scale = vc.scale === 'auto' || vc.scale == null ? 1 + 2 * depthU : vc.scale;
  const sizeVideo = () => {
    let va = video.videoWidth / video.videoHeight || 16 / 9;
    if (dcfg.type === 'sbs') va /= 2;
    let w = open.w * scale, h = w / va;
    if (h < open.h * scale) { h = open.h * scale; w = h * va; }
    vmesh.scale.set(w, h, 1);
  };
  sizeVideo();
  video.addEventListener('loadedmetadata', sizeVideo);

  // 4. Backdrop so nothing ever shows "through" the world (the camera feed is behind the canvas in AR).
  const bmat = new THREE.MeshBasicMaterial({ color: new THREE.Color(bg) });
  insidePortal(bmat);
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), bmat);
  backdrop.position.set(open.cx, open.cy, -depthU - 0.05);
  backdrop.renderOrder = 0;
  inner.add(backdrop);

  const layerVideos = [];
  // 5. Extra cut-out layers (PNG with alpha, or video) between the wall and the main video.
  for (const L of cfg.layers ?? []) {
    let tex, el = null;
    if (/\.(mp4|webm|mov)$/i.test(L.src)) {
      el = document.createElement('video');
      Object.assign(el, { src: L.src, loop: true, muted: true, playsInline: true, crossOrigin: 'anonymous' });
      el.setAttribute('playsinline', '');
      tex = new THREE.VideoTexture(el);
    } else {
      tex = await loadTexture(L.src);
    }
    const mat = planeMaterial(tex, { transparent: true, edgeFade: L.edgeFade ?? 0 });
    insidePortal(mat);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.renderOrder = 3;
    const d = toUnits(L.depthMeters ?? 0.5);
    const iw = tex.image?.videoWidth || tex.image?.width || 1, ih = tex.image?.videoHeight || tex.image?.height || 1;
    const w = open.w * (L.scale ?? 1 + d);
    m.scale.set(w, w * ih / iw, 1);
    m.position.set(open.cx + (L.offset?.[0] ?? 0) * open.w, open.cy + (L.offset?.[1] ?? 0) * open.h, -d);
    inner.add(m);
    if (el) layerVideos.push(el);
  }

  // 6. Optional overlay drawn ON the print surface, in front of the hole (frame, glass, logo...).
  if (P.overlay) {
    const tex = await loadTexture(P.overlay);
    const mat = planeMaterial(tex, { transparent: true });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, aspect), mat);
    m.position.z = 0.0005;
    m.renderOrder = 20;
    root.add(m);
  }

  // 7. Floating specks between the wall and the video (optional depth cue).
  let particles = null;
  if (cfg.particles?.count) {
    particles = new Particles(open, reveal + 0.02, depthU * 0.9, { ...cfg.particles, size: toUnits(cfg.particles.sizeMeters ?? 0.006) });
    inner.add(particles.points);
  }

  // 8. Shatter reveal: the print over the hole breaks into shards and flies out.
  const R = cfg.reveal ?? {};
  let shatter = null;
  if (R.effect !== 'none' && printImage) {
    const tex = new THREE.Texture(printImage);
    tex.needsUpdate = true;
    shatter = new Shatter(poly, aspect, planeMaterial(tex), { ...R, edgeColor: P.paperEdgeColor ?? '#e9e4da' });
    root.add(shatter.group);
  }

  const videos = [video, ...layerVideos];
  // state: 'closed' (print intact) -> 'revealing' -> 'open'
  const api = {
    root, video, open, poly,
    state: 'closed',
    play: () => videos.forEach(v => v.play().catch(() => {})),
    pause: () => videos.forEach(v => v.pause()),
    reveal() {
      if (api.state !== 'closed') return;
      api.state = 'revealing';
      inner.visible = true;
      video.currentTime = 0;
      api.play();
      if (shatter) shatter.start(); else api.open();
    },
    open() {
      api.state = 'open';
      inner.visible = true;
      if (rim) rim.visible = true;
      if (shatter) shatter.group.visible = false;
    },
    update(dt, renderer) {
      particles?.update(dt, renderer);
      if (api.state === 'revealing' && shatter) {
        shatter.update(dt);
        if (rim && shatter.t > shatter.crackTime) rim.visible = true;
        if (shatter.done) api.open();
      }
    },
  };
  inner.visible = false;
  return api;
}

export function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

export async function loadConfig() {
  const name = new URLSearchParams(location.search).get('config') || 'config.json';
  const r = await fetch(name, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Could not load ${name}`);
  return r.json();
}
