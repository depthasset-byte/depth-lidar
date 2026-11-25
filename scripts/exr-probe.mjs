// Development probe: decode the colour cubemap (EXR, DWAB) of one Ray II scan with three's EXRLoader and print statistics.
// Usage: node scripts/exr-probe.mjs "<scan folder>"
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { EXRLoader } from '../src/vendor/EXRLoader.js';

const dir = process.argv[2];
const toc = fs.readFileSync(path.join(dir, 'VGFibGVPZkNvbnRlbnQ='), 'utf8');
const m = /<LwpoSlice [^>]*format="17" filename="([^"]+)"/.exec(toc);
console.log('colour file:', m?.[1]);
console.log('LwpoColorCorrection:', /LwpoColorCorrection="([^"]*)"/.exec(toc)?.[1].replace(/&quot;/g, '"').slice(0, 300));
console.log('WhitePoint:', /WhitePoint="([^"]*)"/.exec(toc)?.[1]);
const b = fs.readFileSync(path.join(dir, m[1]));
const magic = Buffer.from([0x76, 0x2f, 0x31, 0x01]);
const starts = [];
for (let p = 0; (p = b.indexOf(magic, p)) >= 0; p += 4) starts.push(p);
const loader = new EXRLoader().setDataType(THREE.FloatType);
for (let i = 0; i < starts.length; i++) {
  const s = starts[i], e = i + 1 < starts.length ? starts[i + 1] - 11 : b.length;
  const name = b.subarray(s - 5, s - 1).toString('ascii');
  const t0 = Date.now();
  const ab = b.buffer.slice(b.byteOffset + s, b.byteOffset + e);
  const r = loader.parse(ab);
  const d = r.data;
  const ch = d.length / (r.width * r.height);
  const lum = [];
  for (let k = 0; k < r.width * r.height; k += 97) lum.push(0.2126 * d[k * ch] + 0.7152 * d[k * ch + 1] + 0.0722 * d[k * ch + 2]);
  lum.sort((x, y) => x - y);
  const q = (p) => lum[Math.floor(p * (lum.length - 1))];
  console.log(`${name}: ${r.width}x${r.height} ch=${ch} type=${d.constructor.name} ${Date.now() - t0}ms lum p1 ${q(0.01).toFixed(4)} p50 ${q(0.5).toFixed(4)} p90 ${q(0.9).toFixed(4)} p99 ${q(0.99).toFixed(4)} max ${q(1).toFixed(3)} centerRGB ${[0, 1, 2].map((c) => d[((r.height >> 1) * r.width + (r.width >> 1)) * ch + c].toFixed(4)).join(',')}`);
}
