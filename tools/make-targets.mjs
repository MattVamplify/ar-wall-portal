// Builds 8th Wall image targets for the trigger image named in config.json.
//
//   npm install
//   npm run targets                # uses config.json
//   npm run targets -- my-config.json
//
// Writes image-targets/<name>.json + luminance images (via the official @8thwall/image-target-cli)
// and image-targets/index.json, which tells the app where each crop sits on the print.

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { applyCrop } from '@8thwall/image-target-cli/src/apply.js';
import { targetLayout } from '../js/targets.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cfgFile = path.resolve(root, process.argv[2] || 'config.json');
const cfg = JSON.parse(await fs.readFile(cfgFile, 'utf8'));
const trigger = path.resolve(root, cfg.trigger);
const outDir = path.resolve(root, cfg.targetsDir || 'image-targets');

const meta = await sharp(trigger).rotate().metadata();
const W = meta.width, H = meta.height;
const rects = targetLayout(W, H, cfg.targetOptions || {});

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const targets = [];
for (const [i, r] of rects.entries()) {
  const name = `t${i}`;
  await applyCrop(sharp(trigger).rotate(), {
    type: 'PLANAR',
    geometry: { ...r, level: undefined, isRotated: false, originalWidth: W, originalHeight: H },
  }, outDir, name, true);
  // The CLI points imagePath at "image-targets/..."; make it match our folder name.
  const jf = path.join(outDir, `${name}.json`);
  const data = JSON.parse(await fs.readFile(jf, 'utf8'));
  data.imagePath = `${path.relative(root, outDir).split(path.sep).join('/')}/${data.resources.luminanceImage}`;
  delete data.properties.level;
  await fs.writeFile(jf, JSON.stringify(data, null, 2));
  // Only the luminance image is needed at runtime; drop the big copies.
  for (const k of ['originalImage', 'croppedImage']) await fs.rm(path.join(outDir, data.resources[k]), { force: true });
  targets.push({ name, file: `${name}.json`, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, level: r.level });
  console.log(`${name}: ${r.width}x${r.height} at (${r.left}, ${r.top})  level ${r.level}`);
}
await fs.writeFile(path.join(outDir, 'index.json'), JSON.stringify({ trigger: cfg.trigger, width: W, height: H, targets }, null, 2));
console.log(`\n${targets.length} targets written to ${path.relative(root, outDir)}/`);
