// 텍스처 굽기: (1) 방 방향에 맞춘 상자 투영으로 UV 아틀라스를 짜고 (2) 점군 색을 텍셀마다 입힌다.
// 스캐너로 찍은 방·복도처럼 면이 거의 축에 평행한 메시를 위한 단순한 방식이다. 유기적인 형상에는 맞지 않는다.
import type { MeshData } from './mesh';

// ───────── 색 격자: 점군의 색을 작은 칸에 모아 평균을 낸다 ─────────
export class ColorGrid {
  readonly cell: number;
  private readonly mask: number;
  private readonly kx: Int16Array;
  private readonly ky: Int16Array;
  private readonly kz: Int16Array;
  private readonly cnt: Uint16Array;
  private readonly rgb: Float32Array;
  occupied = 0;

  /** cell: 칸 크기(모델 단위, mm). capacityPow: 슬롯 수 = 2^capacityPow (점이 많으면 키운다) */
  constructor(cell: number, capacityPow = 24) {
    this.cell = cell;
    const cap = 2 ** capacityPow;
    this.mask = cap - 1;
    this.kx = new Int16Array(cap);
    this.ky = new Int16Array(cap);
    this.kz = new Int16Array(cap);
    this.cnt = new Uint16Array(cap);
    this.rgb = new Float32Array(cap * 3);
  }

  private find(ix: number, iy: number, iz: number, create: boolean): number {
    let s = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & this.mask;
    for (let probe = 0; probe <= this.mask; probe++) {
      if (this.cnt[s] === 0) {
        if (!create) return -1;
        this.kx[s] = ix; this.ky[s] = iy; this.kz[s] = iz;
        return s;
      }
      if (this.kx[s] === ix && this.ky[s] === iy && this.kz[s] === iz) return s;
      s = (s + 1) & this.mask;
    }
    return -1;
  }

  /** 점과 색(0..1, 점마다 3값)을 더한다. 격자가 가득 차면 나머지는 버리고 false를 돌려준다. */
  add(P: Float32Array, C: Float32Array): boolean {
    const inv = 1 / this.cell;
    let ok = true;
    for (let i = 0; i < P.length; i += 3) {
      const ix = Math.floor(P[i] * inv), iy = Math.floor(P[i + 1] * inv), iz = Math.floor(P[i + 2] * inv);
      if (ix < -32768 || ix > 32767 || iy < -32768 || iy > 32767 || iz < -32768 || iz > 32767) continue;
      const s = this.find(ix, iy, iz, true);
      if (s < 0) { ok = false; break; }
      if (this.cnt[s] === 0) this.occupied++;
      if (this.cnt[s] >= 65535) continue;
      this.cnt[s]++;
      this.rgb[s * 3] += C[i]; this.rgb[s * 3 + 1] += C[i + 1]; this.rgb[s * 3 + 2] += C[i + 2];
    }
    return ok;
  }

  /** (x,y,z) 주변 27칸의 평균 색을 거리·개수로 가중해 out[o..o+2]에 쓴다. 주변에 점이 없으면 false. */
  sample(x: number, y: number, z: number, out: Float32Array, o: number): boolean {
    const c = this.cell, inv = 1 / c;
    const bx = Math.floor(x * inv), by = Math.floor(y * inv), bz = Math.floor(z * inv);
    const reach = 1.75 * c;
    let r = 0, g = 0, b = 0, ws = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const s = this.find(bx + dx, by + dy, bz + dz, false);
      if (s < 0) continue;
      const cx = (bx + dx + 0.5) * c - x, cy = (by + dy + 0.5) * c - y, cz = (bz + dz + 0.5) * c - z;
      const w = 1 - Math.sqrt(cx * cx + cy * cy + cz * cz) / reach;
      if (w <= 0) continue;
      const n = this.cnt[s];
      const ww = w * Math.sqrt(n);
      r += (this.rgb[s * 3] / n) * ww; g += (this.rgb[s * 3 + 1] / n) * ww; b += (this.rgb[s * 3 + 2] / n) * ww;
      ws += ww;
    }
    if (ws <= 0) return false;
    out[o] = r / ws; out[o + 1] = g / ws; out[o + 2] = b / ws;
    return true;
  }
}

// ───────── UV 아틀라스 ─────────
export interface AtlasOptions {
  /** 처음 시도할 텍셀 크기(mm). 아틀라스에 안 들어가면 키운다. */
  texelMm: number;
  /** 아틀라스 한 변의 최대 크기(픽셀) */
  maxSize: number;
  /** 조각 둘레 여백(픽셀) */
  padding?: number;
  /** 아틀라스 한 변의 최소 크기(픽셀). 납품용 8K처럼 크기를 고정할 때 쓴다. */
  minSize?: number;
}

export interface Atlas {
  /** 조각 경계에서 정점이 갈라진 메시(uvs 포함) */
  mesh: MeshData;
  width: number;
  height: number;
  texelMm: number;
  charts: number;
  /** 아틀라스에서 조각이 차지한 비율 */
  fill: number;
  /** 방 방향(도): 상자 투영 축을 이만큼 돌렸다 */
  roomAngleDeg: number;
}

class DSU {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  find(x: number): number {
    const p = this.p;
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  }
  union(a: number, b: number) {
    a = this.find(a); b = this.find(b);
    if (a !== b) this.p[Math.max(a, b)] = Math.min(a, b);
  }
}

interface Chart {
  tris: number[];
  axis: number;
  u0: number; v1: number; // 왼쪽 위(v는 위쪽이 큼)
  w: number; h: number; // 픽셀 (여백 포함)
  x: number; y: number;
}

export function buildAtlas(src: MeshData, opts: AtlasOptions): Atlas {
  const P = src.positions, I = src.indices;
  if (!I) throw new Error('텍스처는 메시에만 입힐 수 있습니다.');
  const nt = I.length / 3, nv = P.length / 3;
  const pad = opts.padding ?? 4;

  // 면 법선과 방 방향(벽이 가장 많이 향한 각도, 90도 주기)
  const fn = new Float32Array(nt * 3);
  let sx = 0, sy = 0;
  for (let f = 0; f < nt; f++) {
    const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) { fn[f * 3 + 1] = 1; continue; }
    fn[f * 3] = nx / len; fn[f * 3 + 1] = ny / len; fn[f * 3 + 2] = nz / len;
    if (Math.abs(fn[f * 3 + 1]) < 0.5) {
      const th = Math.atan2(fn[f * 3 + 2], fn[f * 3]);
      sx += len * Math.cos(4 * th);
      sy += len * Math.sin(4 * th);
    }
  }
  const phi = sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx) / 4;
  const cs = Math.cos(phi), sn = Math.sin(phi);
  const EX = [cs, 0, sn], EY = [0, 1, 0], EZ = [-sn, 0, cs];
  // 축마다 (U, V) 기저
  const BASIS: [number[], number[]][] = [[EZ, EY], [EX, EZ], [EX, EY]];

  // 면의 투영 축(0: EX 법선, 1: EY 법선, 2: EZ 법선)과 부호
  const cls = new Uint8Array(nt);
  for (let f = 0; f < nt; f++) {
    const n0 = fn[f * 3], n1 = fn[f * 3 + 1], n2 = fn[f * 3 + 2];
    const a = n0 * EX[0] + n2 * EX[2], b = n1, g = n0 * EZ[0] + n2 * EZ[2];
    const aa = Math.abs(a), ab = Math.abs(b), ag = Math.abs(g);
    const axis = ab >= aa && ab >= ag ? 1 : aa >= ag ? 0 : 2;
    const val = axis === 0 ? a : axis === 1 ? b : g;
    cls[f] = axis * 2 + (val < 0 ? 1 : 0);
  }
  // 같은 방향이고 꼭짓점을 공유하는 면끼리 한 덩어리
  const dsu = new DSU(nt);
  const first = new Int32Array(nv * 6).fill(-1);
  for (let f = 0; f < nt; f++) {
    for (let k = 0; k < 3; k++) {
      const key = I[f * 3 + k] * 6 + cls[f];
      if (first[key] < 0) first[key] = f;
      else dsu.union(f, first[key]);
    }
  }
  const comps = new Map<number, number[]>();
  for (let f = 0; f < nt; f++) {
    const r = dsu.find(f);
    let l = comps.get(r);
    if (!l) { l = []; comps.set(r, l); }
    l.push(f);
  }

  const dotU = (v: number, axis: number) => P[v * 3] * BASIS[axis][0][0] + P[v * 3 + 1] * BASIS[axis][0][1] + P[v * 3 + 2] * BASIS[axis][0][2];
  const dotV = (v: number, axis: number) => P[v * 3] * BASIS[axis][1][0] + P[v * 3 + 1] * BASIS[axis][1][1] + P[v * 3 + 2] * BASIS[axis][1][2];

  /** 텍셀 크기에 맞춰 큰 덩어리를 타일로 쪼개고 조각 목록을 만든다. */
  const layout = (texel: number): Chart[] => {
    const tile = 1536 * texel;
    const charts: Chart[] = [];
    for (const tris of comps.values()) {
      const axis = (cls[tris[0]] >> 1) as number;
      // 큰 덩어리만 타일로 나눈다
      let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
      for (const f of tris) for (let k = 0; k < 3; k++) {
        const v = I[f * 3 + k], u = dotU(v, axis), w = dotV(v, axis);
        if (u < umin) umin = u; if (u > umax) umax = u; if (w < vmin) vmin = w; if (w > vmax) vmax = w;
      }
      const groups = new Map<number, number[]>();
      if (umax - umin <= tile && vmax - vmin <= tile) groups.set(0, tris);
      else {
        for (const f of tris) {
          let cu = 0, cv = 0;
          for (let k = 0; k < 3; k++) { const v = I[f * 3 + k]; cu += dotU(v, axis); cv += dotV(v, axis); }
          const tx = Math.floor((cu / 3 - umin) / tile), ty = Math.floor((cv / 3 - vmin) / tile);
          const key = tx * 4096 + ty;
          let l = groups.get(key);
          if (!l) { l = []; groups.set(key, l); }
          l.push(f);
        }
      }
      for (const g of groups.values()) {
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const f of g) for (let k = 0; k < 3; k++) {
          const v = I[f * 3 + k], u = dotU(v, axis), w = dotV(v, axis);
          if (u < u0) u0 = u; if (u > u1) u1 = u; if (w < v0) v0 = w; if (w > v1) v1 = w;
        }
        charts.push({ tris: g, axis, u0, v1, w: Math.ceil((u1 - u0) / texel) + 1 + 2 * pad, h: Math.ceil((v1 - v0) / texel) + 1 + 2 * pad, x: 0, y: 0 });
      }
    }
    return charts;
  };

  const sizes = [2048, 4096, 8192, 16384].filter((s) => s <= opts.maxSize && s >= (opts.minSize ?? 0));
  if (!sizes.length) sizes.push(opts.maxSize);
  let texel = opts.texelMm;
  let charts: Chart[] = [];
  let W = 0, H = 0;
  let packed = false;
  for (let attempt = 0; attempt < 60 && !packed; attempt++, texel *= 1.08) {
    charts = layout(texel);
    charts.sort((a, b) => b.h - a.h);
    for (const size of sizes) {
      if (charts.some((c) => c.w > size)) continue;
      let x = 0, y = 0, rowH = 0;
      for (const c of charts) {
        if (x + c.w > size) { y += rowH; x = 0; rowH = 0; }
        c.x = x; c.y = y; x += c.w; if (c.h > rowH) rowH = c.h;
      }
      const used = y + rowH;
      if (used <= size) { W = size; H = Math.max(8, Math.ceil(used / 8) * 8); packed = true; break; }
    }
  }
  if (!packed) throw new Error('아틀라스에 조각이 들어가지 않습니다. 최대 크기를 키우거나 메시를 줄이세요.');

  // 새 메시: 조각마다 꼭짓점을 따로 둔다
  const outP: number[] = [], outU: number[] = [], outC: number[] = [], outI = new Uint32Array(nt * 3);
  const hasC = !!src.colors;
  let area = 0;
  let t = 0;
  for (const c of charts) {
    area += c.w * c.h;
    const map = new Map<number, number>();
    for (const f of c.tris) {
      for (let k = 0; k < 3; k++) {
        const v = I[f * 3 + k];
        let nvIdx = map.get(v);
        if (nvIdx === undefined) {
          nvIdx = outP.length / 3;
          map.set(v, nvIdx);
          outP.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
          const px = c.x + pad + (dotU(v, c.axis) - c.u0) / texel;
          const py = c.y + pad + (c.v1 - dotV(v, c.axis)) / texel;
          outU.push(px / W, 1 - py / H);
          if (hasC) outC.push(src.colors![v * 3], src.colors![v * 3 + 1], src.colors![v * 3 + 2]);
        }
        outI[t++] = nvIdx;
      }
    }
  }
  const mesh: MeshData = { positions: Float32Array.from(outP), indices: outI, normals: null, colors: hasC ? Float32Array.from(outC) : null, uvs: Float32Array.from(outU) };
  return { mesh, width: W, height: H, texelMm: texel, charts: charts.length, fill: area / (W * H), roomAngleDeg: (phi * 180) / Math.PI };
}

// ───────── 굽기 ─────────
export interface BakeResult {
  rgb: Uint8Array;
  /** 점군에서 색을 얻은 텍셀 수, 메시 정점 색으로 대신한 수, 못 채워 이웃으로 메운 수 */
  fromPoints: number;
  fromVertex: number;
  filled: number;
}

/** 아틀라스 메시의 UV 삼각형을 훑으며 텍셀마다 3D 위치의 색을 점군 격자에서 찾아 입힌다. */
export function bakeTexture(atlas: Atlas, grid: ColorGrid): BakeResult {
  const { mesh, width: W, height: H } = atlas;
  const P = mesh.positions, I = mesh.indices!, UV = mesh.uvs!, VC = mesh.colors;
  const rgb = new Uint8Array(W * H * 3);
  const state = new Uint8Array(W * H); // 0 비어 있음, 1 점군, 2 정점 색
  const col = new Float32Array(3);
  let fromPoints = 0, fromVertex = 0;
  for (let f = 0; f < I.length; f += 3) {
    const ia = I[f], ib = I[f + 1], ic = I[f + 2];
    const ax = UV[ia * 2] * W, ay = (1 - UV[ia * 2 + 1]) * H;
    const bx = UV[ib * 2] * W, by = (1 - UV[ib * 2 + 1]) * H;
    const cx = UV[ic * 2] * W, cy = (1 - UV[ic * 2 + 1]) * H;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
      const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -0.001 || l2 < -0.001 || l3 < -0.001) continue;
      const k = y * W + x;
      if (state[k]) continue;
      const wx = l1 * P[ia * 3] + l2 * P[ib * 3] + l3 * P[ic * 3];
      const wy = l1 * P[ia * 3 + 1] + l2 * P[ib * 3 + 1] + l3 * P[ic * 3 + 1];
      const wz = l1 * P[ia * 3 + 2] + l2 * P[ib * 3 + 2] + l3 * P[ic * 3 + 2];
      if (grid.sample(wx, wy, wz, col, 0)) {
        state[k] = 1; fromPoints++;
      } else if (VC) {
        col[0] = l1 * VC[ia * 3] + l2 * VC[ib * 3] + l3 * VC[ic * 3];
        col[1] = l1 * VC[ia * 3 + 1] + l2 * VC[ib * 3 + 1] + l3 * VC[ic * 3 + 1];
        col[2] = l1 * VC[ia * 3 + 2] + l2 * VC[ib * 3 + 2] + l3 * VC[ic * 3 + 2];
        state[k] = 2; fromVertex++;
      } else continue;
      rgb[k * 3] = Math.max(0, Math.min(255, Math.round(col[0] * 255)));
      rgb[k * 3 + 1] = Math.max(0, Math.min(255, Math.round(col[1] * 255)));
      rgb[k * 3 + 2] = Math.max(0, Math.min(255, Math.round(col[2] * 255)));
    }
  }
  // 조각 둘레 여백과 빈 텍셀은 이웃 색으로 번지게 메운다
  let filled = 0;
  let cur = state;
  for (let pass = 0; pass < 6; pass++) {
    const next = Uint8Array.from(cur);
    let changed = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (cur[k]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W || (dx === 0 && dy === 0)) continue;
          const kk = yy * W + xx;
          if (cur[kk]) { r += rgb[kk * 3]; g += rgb[kk * 3 + 1]; b += rgb[kk * 3 + 2]; n++; }
        }
      }
      if (n) { rgb[k * 3] = r / n; rgb[k * 3 + 1] = g / n; rgb[k * 3 + 2] = b / n; next[k] = 3; changed++; }
    }
    filled += changed;
    cur = next;
    if (!changed) break;
  }
  for (let k = 0; k < W * H; k++) if (!cur[k]) { rgb[k * 3] = rgb[k * 3 + 1] = rgb[k * 3 + 2] = 128; }
  return { rgb, fromPoints, fromVertex, filled };
}
