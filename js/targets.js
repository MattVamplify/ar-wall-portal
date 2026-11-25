// Shared by the browser app and tools/make-targets.mjs (no dependencies).
//
// 8th Wall image targets are always a 3:4 portrait crop. Big prints come in every shape
// (a 48-sheet billboard is 3:1, a wall mural could be anything), so we cover the print with
// several overlapping 3:4 crops. Each crop knows where it sits on the print, so whichever one
// the camera locks onto, the portal lands in the same place.
//
//   level 1: the biggest 3:4 crops that fit, spread along the long side (far away / whole print in view)
//   level 2: smaller crops for when you walk up close and only see part of the wall

export const MAX_TARGETS = 10;
const MIN_W = 480, MIN_H = 640; // 8th Wall minimum crop size in source pixels

function cover(W, H, w, h, overlap) {
  const n = (len, size) => (len <= size + 1 ? 1 : Math.ceil((len - size) / (size * (1 - overlap))) + 1);
  const nx = n(W, w), ny = n(H, h), out = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    out.push({
      left: Math.round(nx === 1 ? (W - w) / 2 : (i * (W - w)) / (nx - 1)),
      top: Math.round(ny === 1 ? (H - h) / 2 : (j * (H - h)) / (ny - 1)),
      width: Math.round(w),
      height: Math.round(h),
    });
  }
  return out;
}

/**
 * @param {number} W source image width (px)
 * @param {number} H source image height (px)
 * @param {{closeRange?: boolean, closeRangeSize?: number, overlap?: number}} opts
 * @returns {{left:number, top:number, width:number, height:number, level:number}[]}
 */
export function targetLayout(W, H, opts = {}) {
  const overlap = opts.overlap ?? 0.3;
  let h = Math.min(H, (W * 4) / 3), w = (h * 3) / 4;
  w = Math.floor(w); h = Math.floor((w * 4) / 3);
  if (w < MIN_W || h < MIN_H) throw new Error(`Trigger image too small: each 3:4 crop must be at least ${MIN_W}x${MIN_H}px. Use a bigger image (2000px+ recommended).`);
  const rects = cover(W, H, w, h, overlap).map(r => ({ ...r, level: 1 }));

  if (opts.closeRange !== false) {
    // Close-range crops: a fraction of the main crop size, as long as they stay above the minimum.
    let k = opts.closeRangeSize ?? 0.55;
    for (; k < 0.95; k += 0.1) {
      const cw = Math.floor(w * k), ch = Math.floor((cw * 4) / 3);
      if (cw < MIN_W || ch < MIN_H) continue;
      const close = cover(W, H, cw, ch, overlap);
      if (rects.length + close.length <= MAX_TARGETS) { rects.push(...close.map(r => ({ ...r, level: 2 }))); break; }
    }
  }
  return rects.slice(0, MAX_TARGETS);
}

// Transform that maps print space (1 unit = print width, origin = print centre, y up)
// into an 8th Wall target's space (1 unit = crop height, origin = crop centre, y up).
export function printToTarget(rect, W, H) {
  const A = H / W;
  const rx = rect.left / W, ry = rect.top / W, rw = rect.width / W, rh = rect.height / W;
  const s = 1 / rh;
  return {
    scale: s,
    x: (0.5 - (rx + rw / 2)) * s,
    y: -(A / 2 - (ry + rh / 2)) * s,
  };
}
