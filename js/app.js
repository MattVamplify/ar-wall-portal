import * as THREE from 'three';
import { buildPortal, loadImage, loadConfig } from './portal.js';
import { printToTarget } from './targets.js';
import { printWithHole } from './tear.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
// Hosts that block the camera (e.g. a Claude artifact) set window.PORTAL_PREVIEW_ONLY in index.html.
const previewOnly = params.has('preview') || !!window.PORTAL_PREVIEW_ONLY;
const status = msg => { $('#status').textContent = msg; };
const show = (sel, on = true) => { $(sel).hidden = !on; };

let cfg, trigger;

async function init() {
  cfg = await loadConfig();
  document.title = cfg.title || document.title;
  $('#title').textContent = cfg.title || 'AR Portal';
  $('#subtitle').textContent = cfg.instructions || 'Point your camera at the poster';
  if (cfg.ui?.accent) document.documentElement.style.setProperty('--accent', cfg.ui.accent);
  trigger = await loadImage(cfg.trigger);
  $('#thumb').src = cfg.trigger;
  // scan guide matches the print's shape
  const a = trigger.naturalWidth / trigger.naturalHeight;
  $('#guide-frame').style.aspectRatio = String(a);
  $('#start').disabled = false;
  $('#start').addEventListener('click', () => (previewOnly ? startPreview() : startAR()).catch(fail));
  if (window.PORTAL_PREVIEW_ONLY) { show('#preview', false); document.querySelector('.kicker').textContent = 'Interactive preview'; $('#subtitle').textContent = cfg.previewInstructions || 'Tap Continue, then tap the screen to break the photo open. Move your mouse or drag to look around inside.'; }
  $('#preview').addEventListener('click', e => { e.preventDefault(); startPreview().catch(fail); });
  if (params.has('preview')) startPreview().catch(fail);
}

function fail(err) {
  console.error(err);
  show('#overlay');
  status(String(err?.message || err));
}

// ---- Reveal flow shared by AR and preview: found -> "Tap the screen to explore" -> shatter ----
function setupRevealFlow(portal) {
  const mode = params.get('reveal') || cfg.reveal?.trigger || 'tap'; // tap | auto | open
  let prompted = false;
  const go = () => { show('#tap', false); portal.reveal(); $('#sound').hidden = !!cfg.video?.muted; };
  document.addEventListener('pointerdown', e => {
    if (prompted && portal.state === 'closed' && !e.target.closest('button')) go();
  });
  return {
    onFound() {
      show('#guide', false);
      if (portal.state !== 'closed' || prompted) return;
      prompted = true;
      if (mode === 'open') { portal.reveal(); portal.open(); return; }
      if (mode === 'auto') { setTimeout(go, 800); return; }
      show('#tap');
    },
    onLost() { if (portal.state === 'closed') show('#guide'); },
  };
}

// Load the 8th Wall engine (open-source build, image targets only) on demand.
function loadXR8() {
  if (window.XR8) return Promise.resolve(window.XR8);
  return new Promise((resolve, reject) => {
    window.addEventListener('xrloaded', () => resolve(window.XR8), { once: true });
    const s = document.createElement('script');
    s.src = 'vendor/8thwall/xr.js';
    s.async = true;
    s.setAttribute('data-preload-chunks', 'slam'); // "slam" = the image-target tracking chunk in the open-source engine
    s.onerror = () => reject(new Error('Could not load the 8th Wall engine'));
    document.head.appendChild(s);
  });
}

async function startAR() {
  $('#start').disabled = true;
  status('Loading…');
  const dir = cfg.targetsDir || 'image-targets';
  const index = await fetch(`${dir}/index.json`, { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error(`No image targets found in ${dir}/. Run "npm run targets" first.`);
    return r.json();
  });
  const targetData = await Promise.all(index.targets.map(t => fetch(`${dir}/${t.file}`).then(r => r.json())));
  const W = index.width, H = index.height;

  window.THREE = THREE; // 8th Wall's three.js module looks for a global THREE
  const [XR8, portal] = await Promise.all([loadXR8(), buildPortal(cfg, H / W, trigger)]);

  // Unlock video playback inside the tap gesture (iOS needs this).
  await portal.video.play().catch(() => {});
  portal.pause();
  const flow = setupRevealFlow(portal);

  // One anchor per target. Each holds a wrapper that maps print space into that crop's space.
  const anchors = new Map();
  for (const t of index.targets) {
    const group = new THREE.Group();
    group.visible = false;
    const wrap = new THREE.Group();
    const m = printToTarget(t.rect, W, H);
    wrap.position.set(m.x, m.y, 0);
    wrap.scale.setScalar(m.scale);
    group.add(wrap);
    anchors.set(t.name, { group, wrap, visible: false, level: t.level });
  }

  let active = null, lostTimer = null;
  const choose = () => {
    // Stick with the current target while it is tracked; otherwise prefer a whole-print target.
    if (active && anchors.get(active).visible) return;
    const vis = [...anchors.entries()].filter(([, a]) => a.visible).sort((a, b) => a[1].level - b[1].level);
    active = vis.length ? vis[0][0] : null;
    for (const [name, a] of anchors) a.group.visible = name === active;
    if (active) {
      anchors.get(active).wrap.add(portal.root);
      clearTimeout(lostTimer);
      if (portal.state !== 'closed') portal.play();
      flow.onFound();
    } else {
      lostTimer = setTimeout(() => { portal.pause(); flow.onLost(); }, 600);
    }
  };
  const place = ({ detail }) => {
    const a = anchors.get(detail.name);
    if (!a) return;
    a.group.position.copy(detail.position);
    a.group.quaternion.copy(detail.rotation);
    a.group.scale.setScalar(detail.scale);
  };

  let last = performance.now();
  XR8.XrController.configure({ imageTargetData: targetData, disableWorldTracking: true });
  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(), // draws the camera feed
    XR8.Threejs.pipelineModule(),           // three.js scene + camera synced to the device camera
    XR8.XrController.pipelineModule(),      // image target tracking
    {
      name: 'wall-portal',
      onStart: () => {
        const { scene } = XR8.Threejs.xrScene();
        for (const a of anchors.values()) scene.add(a.group);
        show('#overlay', false);
        show('#guide');
      },
      onUpdate: () => {
        const now = performance.now();
        portal.update(Math.min(0.05, (now - last) / 1000), XR8.Threejs.xrScene().renderer);
        last = now;
      },
      listeners: [
        { event: 'reality.imagefound', process: e => { place(e); anchors.get(e.detail.name).visible = true; choose(); } },
        { event: 'reality.imageupdated', process: place },
        { event: 'reality.imagelost', process: e => { anchors.get(e.detail.name).visible = false; choose(); } },
      ],
      onCameraStatusChange: ({ status: s }) => {
        if (s === 'requesting') status('Allow camera access to continue');
        if (s === 'failed') fail(new Error('Camera access was blocked. Allow it in your browser settings and reload.'));
      },
      onException: err => fail(err),
    },
  ]);
  // The canvas fills the window. Its drawing buffer is in device pixels; its CSS size is pinned by
  // the stylesheet (!important), because three.js setSize() would otherwise set the CSS size to the
  // device-pixel size and the view would appear zoomed in by the screen's pixel ratio (2-3x on phones).
  const canvas = $('#xr-canvas');
  const fit = () => { canvas.width = Math.round(innerWidth * devicePixelRatio); canvas.height = Math.round(innerHeight * devicePixelRatio); };
  fit();
  addEventListener('resize', fit);
  XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().ANY });

  $('#sound').onclick = () => { portal.video.muted = !portal.video.muted; $('#sound').textContent = portal.video.muted ? 'Sound on' : 'Sound off'; };
}

// Desktop preview: the print on a virtual wall, camera follows the mouse (or phone tilt).
async function startPreview() {
  show('#overlay', false);
  $('#note').textContent = window.PORTAL_PREVIEW_ONLY ? 'Drag or move the mouse to look around' : 'Preview: move the mouse (or tilt your phone) to look around';
  show('#note');
  const aspect = trigger.naturalHeight / trigger.naturalWidth;
  const renderer = new THREE.WebGLRenderer({ antialias: true, canvas: $('#xr-canvas') });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor('#d9d4cc');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 200);
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

  const portal = await buildPortal(cfg, aspect, trigger);
  scene.add(portal.root);

  // Stand-ins for the real world: a wall, the intact print, and the print with the hole torn out.
  const wallTex = new THREE.CanvasTexture(wallCanvas());
  wallTex.colorSpace = THREE.SRGBColorSpace;
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
  const printTex = new THREE.Texture(trigger);
  printTex.needsUpdate = true;
  const printMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: printTex } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = texture2D(map, vUv); }',
    depthTest: false, // sits exactly on the invisible occluder; skip the depth test to avoid z-fighting
    depthWrite: false,
  });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshBasicMaterial({ map: wallTex }));
  wallTex.repeat.set(80, 80);
  wall.position.z = -0.0004;
  wall.renderOrder = -20;
  const printFull = new THREE.Mesh(new THREE.PlaneGeometry(1, aspect), printMat);
  const printHoled = new THREE.Mesh(printWithHole(portal.poly, aspect), printMat);
  printFull.renderOrder = printHoled.renderOrder = -9;
  scene.add(wall, printFull, printHoled);
  // the wall must not hide what is behind the hole: draw it before the occluder, with no depth
  wall.material.depthWrite = false;

  const flow = setupRevealFlow(portal);
  setTimeout(() => flow.onFound(), 600);

  const fixed = params.has('x') || params.has('y');
  const target = new THREE.Vector2(+params.get('x') || 0, +params.get('y') || 0);
  // camera distance that fits the whole print on screen, in portrait or landscape
  const fitDist = () => {
    if (+params.get('d')) return +params.get('d');
    const v = THREE.MathUtils.degToRad(camera.fov) / 2, h = Math.atan(Math.tan(v) * camera.aspect);
    return Math.max(0.6 / Math.tan(h), (aspect * 0.6) / Math.tan(v), 1.1);
  };
  let userMoved = fixed;
  addEventListener('pointermove', e => { userMoved = true; target.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1)); });
  addEventListener('deviceorientation', e => { if (e.gamma == null) return; userMoved = true; target.set(THREE.MathUtils.clamp(e.gamma / 35, -1, 1), THREE.MathUtils.clamp((45 - e.beta) / 35, -1, 1)); });
  const cur = target.clone();
  const clock = new THREE.Clock();
  let tt = 0;
  const tick = dt => {
    tt += dt;
    if (!userMoved) target.set(Math.sin(tt * 0.5) * 0.9, Math.sin(tt * 0.37) * 0.4);
    cur.lerp(target, fixed ? 1 : 0.08);
    const dist = fitDist();
    camera.position.set(cur.x * dist * 0.5, cur.y * dist * 0.35, dist);
    camera.lookAt(0, 0, 0);
    printFull.visible = portal.state === 'closed';
    printHoled.visible = !printFull.visible;
    portal.update(dt, renderer);
    renderer.render(scene, camera);
  };
  // ?capture: step frame by frame from a script (used to record demo videos)
  if (params.has('capture')) window.__frame = (dt = 1 / 30) => tick(dt);
  else renderer.setAnimationLoop(() => tick(Math.min(0.05, clock.getDelta())));
}

function wallCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#cfc8bd'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`; g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); }
  return c;
}

init().catch(fail);
