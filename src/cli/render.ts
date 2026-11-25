/// <reference types="node" />
// 점군·메시를 창 없이 그림(PNG)으로 그린다. 정합·정리 결과를 눈으로 확인하는 검토 그림용이다.
import zlib from 'node:zlib';
import type { MeshData } from '../geometry/mesh';

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGB(8비트) 화소를 PNG 파일 바이트로 만든다. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]);
}

export type RenderView = 'top' | 'front' | 'side';
export interface RenderOptions {
  view: RenderView;
  size: number;
  /** 이 높이(Y)보다 위·아래의 점은 그리지 않는다 */
  clipAbove?: number;
  clipBelow?: number;
  /** 'scan': 입력마다 다른 색, 'own': 점 자체의 색 */
  color: 'scan' | 'own';
}

const TINTS: [number, number, number][] = [
  [230, 80, 70], [70, 160, 240], [90, 200, 110], [240, 190, 60], [190, 110, 230], [70, 210, 210], [240, 130, 180], [170, 170, 170],
];

/** 여러 객체를 직교 투영으로 한 장에 그린다. 가까운(시점 쪽) 점이 위에 온다. */
export function renderViews(items: MeshData[], o: RenderOptions): { width: number; height: number; rgb: Uint8Array; scale: number } {
  // 화면 가로(u)·세로(v)·깊이(d) 축
  const axes = o.view === 'top' ? [0, 2, 1] : o.view === 'front' ? [0, 1, 2] : [2, 1, 0];
  const us: number[] = [], vs: number[] = [];
  const keep = (y: number) => (o.clipAbove === undefined || y <= o.clipAbove) && (o.clipBelow === undefined || y >= o.clipBelow);
  for (const m of items) {
    const p = m.positions;
    const step = Math.max(3, Math.floor(p.length / 3 / 20000) * 3);
    for (let i = 0; i < p.length; i += step) {
      if (!keep(p[i + 1])) continue;
      us.push(p[i + axes[0]]);
      vs.push(p[i + axes[1]]);
    }
  }
  if (!us.length) throw new Error('그릴 점이 없습니다.');
  us.sort((a, b) => a - b);
  vs.sort((a, b) => a - b);
  const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(f * (arr.length - 1)))];
  const u0 = q(us, 0.003), u1 = q(us, 0.997), v0 = q(vs, 0.003), v1 = q(vs, 0.997);
  const pad = 0.03 * Math.max(u1 - u0, v1 - v0);
  const scale = (o.size - 1) / (Math.max(u1 - u0, v1 - v0) + 2 * pad);
  const width = Math.max(16, Math.ceil((u1 - u0 + 2 * pad) * scale) + 1);
  const height = Math.max(16, Math.ceil((v1 - v0 + 2 * pad) * scale) + 1);
  const rgb = new Uint8Array(width * height * 3).fill(18);
  const depth = new Float32Array(width * height).fill(-Infinity);
  items.forEach((m, idx) => {
    const p = m.positions, c = m.colors;
    const tint = TINTS[idx % TINTS.length];
    for (let i = 0; i < p.length; i += 3) {
      if (!keep(p[i + 1])) continue;
      const x = Math.round((p[i + axes[0]] - u0 + pad) * scale);
      // 위에서 볼 때는 z가 아래로, 앞·옆에서 볼 때는 y가 위로 가게 한다
      const yv = (p[i + axes[1]] - v0 + pad) * scale;
      const y = o.view === 'top' ? Math.round(yv) : height - 1 - Math.round(yv);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const d = o.view === 'top' ? p[i + 1] : p[i + axes[2]];
      const k = y * width + x;
      if (d <= depth[k]) continue;
      depth[k] = d;
      const g = c ? c[i] : 0.7;
      if (o.color === 'own' && c) {
        rgb[k * 3] = Math.round(c[i] * 255);
        rgb[k * 3 + 1] = Math.round(c[i + 1] * 255);
        rgb[k * 3 + 2] = Math.round(c[i + 2] * 255);
      } else {
        const s = 0.45 + 0.55 * g;
        rgb[k * 3] = Math.round(tint[0] * s);
        rgb[k * 3 + 1] = Math.round(tint[1] * s);
        rgb[k * 3 + 2] = Math.round(tint[2] * s);
      }
    }
  });
  return { width, height, rgb, scale };
}
