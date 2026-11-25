// 간이 퓨전: 여러 스캔의 점·법선을 복셀 격자에 부호 거리로 누적한 뒤 마칭 큐브로 하나의 메시를 뽑는다.
import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';
import { KdTree, estimateNormals } from './align';
import { Mat4, MeshData, bakeMatrix, bbox, computeNormals } from './mesh';

export interface FusionOptions {
  /** 복셀 크기(모델 단위). 0이면 자동 */
  voxel: number;
  /** 누적 반경(복셀 단위) */
  radius?: number;
}

const B = 8; // 블록 한 변의 노드 수
const B3 = B * B * B;

class Grow {
  data: Float32Array;
  constructor(n: number) { this.data = new Float32Array(n); }
  ensure(n: number) {
    if (n <= this.data.length) return;
    const d = new Float32Array(Math.max(n, this.data.length * 2));
    d.set(this.data);
    this.data = d;
  }
}

export function autoVoxel(items: { mesh: MeshData; matrix: Mat4 }[]): number {
  let d = 0;
  for (const it of items) {
    const b = bbox(bakeMatrix(it.mesh, it.matrix).positions);
    d = Math.max(d, b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  }
  return d / 160 || 1;
}

/** 점군의 대표 점 간격(가장 가까운 이웃까지 거리의 중앙값). */
export function pointSpacing(points: Float32Array): number {
  const n = points.length / 3;
  if (n < 2) return 0;
  const tree = new KdTree(points);
  const q = Math.min(600, n);
  const d: number[] = [];
  for (let i = 0; i < q; i++) {
    const s = Math.floor((i * n) / q) * 3;
    const nb = tree.nearestK(points[s], points[s + 1], points[s + 2], 2);
    if (nb.length < 2) continue;
    const o = nb[1] * 3;
    d.push(Math.hypot(points[s] - points[o], points[s + 1] - points[o + 1], points[s + 2] - points[o + 2]));
  }
  d.sort((a, b) => a - b);
  return d[d.length >> 1] ?? 0;
}

export function fuse(items: { mesh: MeshData; matrix: Mat4 }[], opts: FusionOptions) {
  // 1) 월드 좌표 표본 수집
  let voxel = opts.voxel > 0 ? opts.voxel : autoVoxel(items);
  // 점군은 점 사이를 메워 줄 삼각형이 없으므로, 자동 해상도가 점 간격보다 촘촘해지지 않게 한다.
  if (!(opts.voxel > 0)) for (const it of items) if (!it.mesh.indices) voxel = Math.max(voxel, 2 * pointSpacing(bakeMatrix(it.mesh, it.matrix).positions));
  const R = opts.radius ?? 2;
  const px: number[] = [], nx: number[] = [], cx: number[] = [];
  let anyColor = false;
  for (const it of items) {
    const m = bakeMatrix(it.mesh, it.matrix);
    const P = m.positions;
    const N = m.indices ? computeNormals(P, m.indices) : m.normals ?? estimateNormals(P);
    const C = m.colors;
    if (C) anyColor = true;
    const nv = P.length / 3;
    for (let i = 0; i < nv; i++) {
      px.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      nx.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
      if (C) cx.push(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]);
      else cx.push(-1, 0, 0);
    }
    // 복셀보다 큰 삼각형은 내부에도 표본을 둔다.
    if (m.indices) {
      const idx = m.indices;
      const lim = voxel * 0.9;
      for (let f = 0; f < idx.length; f += 3) {
        const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
        const e = Math.max(
          Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]),
          Math.hypot(P[b] - P[c], P[b + 1] - P[c + 1], P[b + 2] - P[c + 2]),
          Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]),
        );
        if (e <= lim) continue;
        const div = Math.min(64, Math.ceil(e / lim));
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        let fnx = uy * vz - uz * vy, fny = uz * vx - ux * vz, fnz = ux * vy - uy * vx;
        const fl = Math.hypot(fnx, fny, fnz) || 1;
        fnx /= fl; fny /= fl; fnz /= fl;
        for (let i = 0; i <= div; i++)
          for (let j = 0; j <= div - i; j++) {
            if ((i === 0 && j === 0) || (i === div && j === 0) || (i === 0 && j === div)) continue;
            const s = i / div, t = j / div, w = 1 - s - t;
            px.push(P[a] + ux * s + vx * t, P[a + 1] + uy * s + vy * t, P[a + 2] + uz * s + vz * t);
            nx.push(fnx, fny, fnz);
            if (C) cx.push(C[a] * w + C[b] * s + C[c] * t, C[a + 1] * w + C[b + 1] * s + C[c + 1] * t, C[a + 2] * w + C[b + 2] * s + C[c + 2] * t);
            else cx.push(-1, 0, 0);
          }
      }
    }
  }
  const ns = px.length / 3;
  if (!ns) throw new Error('퓨전할 점이 없습니다.');
  const SP = Float32Array.from(px);
  const bb = bbox(SP);
  // 2) 격자 설정 (가장 긴 변이 1024 노드를 넘지 않게)
  const maxSize = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
  if (maxSize / voxel > 1000) voxel = maxSize / 1000;
  const pad = (R + 2) * voxel;
  const origin = [bb.min[0] - pad, bb.min[1] - pad, bb.min[2] - pad];
  const dims = [0, 1, 2].map((k) => Math.ceil((bb.max[k] - bb.min[k] + 2 * pad) / voxel) + 1);
  const bd = dims.map((d) => Math.ceil(d / B));
  const blockIndex = new Int32Array(bd[0] * bd[1] * bd[2]).fill(-1);
  let blocks = 0;
  const sdf = new Grow(B3 * 256), wgt = new Grow(B3 * 256);
  const cr = new Grow(anyColor ? B3 * 256 : 0), cg = new Grow(anyColor ? B3 * 256 : 0), cb = new Grow(anyColor ? B3 * 256 : 0), cw = new Grow(anyColor ? B3 * 256 : 0);
  const slotOf = (i: number, j: number, k: number, create: boolean): number => {
    const bi = (i >> 3) + bd[0] * ((j >> 3) + bd[1] * (k >> 3));
    let b = blockIndex[bi];
    if (b < 0) {
      if (!create) return -1;
      b = blockIndex[bi] = blocks++;
      const need = blocks * B3;
      sdf.ensure(need); wgt.ensure(need);
      if (anyColor) { cr.ensure(need); cg.ensure(need); cb.ensure(need); cw.ensure(need); }
    }
    return b * B3 + (i & 7) + B * ((j & 7) + B * (k & 7));
  };
  // 3) 누적
  const sigma2 = 2 * (R / 2) * (R / 2);
  const R2 = R * R;
  for (let s = 0; s < ns; s++) {
    const gx = (SP[s * 3] - origin[0]) / voxel, gy = (SP[s * 3 + 1] - origin[1]) / voxel, gz = (SP[s * 3 + 2] - origin[2]) / voxel;
    const n0 = nx[s * 3], n1 = nx[s * 3 + 1], n2 = nx[s * 3 + 2];
    const hasC = cx[s * 3] >= 0;
    const i0 = Math.ceil(gx - R), i1 = Math.floor(gx + R);
    const j0 = Math.ceil(gy - R), j1 = Math.floor(gy + R);
    const k0 = Math.ceil(gz - R), k1 = Math.floor(gz + R);
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const dx = i - gx, dy = j - gy, dz = k - gz;
          const dd = dx * dx + dy * dy + dz * dz;
          if (dd > R2) continue;
          const w = Math.exp(-dd / sigma2);
          const sl = slotOf(i, j, k, true);
          sdf.data[sl] += w * (dx * n0 + dy * n1 + dz * n2) * voxel;
          wgt.data[sl] += w;
          if (hasC) {
            cr.data[sl] += w * cx[s * 3];
            cg.data[sl] += w * cx[s * 3 + 1];
            cb.data[sl] += w * cx[s * 3 + 2];
            cw.data[sl] += w;
          }
        }
  }
  // 4) 마칭 큐브
  const WMIN = 0.35;
  const CO = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const EV = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const outP: number[] = [], outC: number[] = [], outI: number[] = [];
  const vmap = new Map<number, number>();
  const val = new Float64Array(8), slot = new Int32Array(8);
  const ev = new Int32Array(12);
  let orient = 0, orientN = 0;
  const nodeId = (i: number, j: number, k: number) => i + dims[0] * (j + dims[1] * k);
  for (let bz = 0; bz < bd[2]; bz++)
    for (let by = 0; by < bd[1]; by++)
      for (let bx = 0; bx < bd[0]; bx++) {
        if (blockIndex[bx + bd[0] * (by + bd[1] * bz)] < 0) continue;
        for (let kk = 0; kk < B; kk++)
          for (let jj = 0; jj < B; jj++)
            for (let ii = 0; ii < B; ii++) {
              const i = bx * B + ii, j = by * B + jj, k = bz * B + kk;
              if (i + 1 >= dims[0] || j + 1 >= dims[1] || k + 1 >= dims[2]) continue;
              let ok = true, ci = 0;
              for (let c = 0; c < 8; c++) {
                const sl = slotOf(i + CO[c][0], j + CO[c][1], k + CO[c][2], false);
                if (sl < 0 || wgt.data[sl] < WMIN) { ok = false; break; }
                slot[c] = sl;
                val[c] = sdf.data[sl] / wgt.data[sl];
                if (val[c] < 0) ci |= 1 << c;
              }
              if (!ok) continue;
              const bits = edgeTable[ci];
              if (!bits) continue;
              for (let e = 0; e < 12; e++) {
                if (!(bits & (1 << e))) continue;
                const a = EV[e][0], b = EV[e][1];
                // 간선의 고유 키: 작은 쪽 노드 + 축
                const ax = CO[a][0] !== CO[b][0] ? 0 : CO[a][1] !== CO[b][1] ? 1 : 2;
                const lo = CO[a][ax] < CO[b][ax] ? a : b;
                const key = nodeId(i + CO[lo][0], j + CO[lo][1], k + CO[lo][2]) * 3 + ax;
                let v = vmap.get(key);
                if (v === undefined) {
                  const t = val[a] / (val[a] - val[b]);
                  v = outP.length / 3;
                  outP.push(
                    origin[0] + (i + CO[a][0] + (CO[b][0] - CO[a][0]) * t) * voxel,
                    origin[1] + (j + CO[a][1] + (CO[b][1] - CO[a][1]) * t) * voxel,
                    origin[2] + (k + CO[a][2] + (CO[b][2] - CO[a][2]) * t) * voxel,
                  );
                  if (anyColor) {
                    const sa = slot[a], sb = slot[b];
                    const wa = cw.data[sa], wb = cw.data[sb];
                    if (wa > 1e-9 || wb > 1e-9) {
                      // 색 정보가 없는 쪽은 있는 쪽 색을 그대로 쓴다.
                      const fa = wa > 1e-9 ? sa : sb, fb = wb > 1e-9 ? sb : sa;
                      const da = cw.data[fa], db = cw.data[fb];
                      outC.push(
                        (cr.data[fa] / da) * (1 - t) + (cr.data[fb] / db) * t,
                        (cg.data[fa] / da) * (1 - t) + (cg.data[fb] / db) * t,
                        (cb.data[fa] / da) * (1 - t) + (cb.data[fb] / db) * t,
                      );
                    } else outC.push(0.7, 0.7, 0.7);
                  }
                  vmap.set(key, v);
                }
                ev[e] = v;
              }
              for (let t = ci * 16; triTable[t] !== -1; t += 3) {
                const a = ev[triTable[t]], b = ev[triTable[t + 1]], c = ev[triTable[t + 2]];
                if (a === b || b === c || a === c) continue;
                outI.push(a, b, c);
                if (orientN < 4000) {
                  // 삼각형 법선이 부호 거리 증가 방향(바깥)을 향하는지 표본 조사
                  const A = a * 3, Bq = b * 3, Cq = c * 3;
                  const ux = outP[Bq] - outP[A], uy = outP[Bq + 1] - outP[A + 1], uz = outP[Bq + 2] - outP[A + 2];
                  const vx = outP[Cq] - outP[A], vy = outP[Cq + 1] - outP[A + 1], vz = outP[Cq + 2] - outP[A + 2];
                  const tnx = uy * vz - uz * vy, tny = uz * vx - ux * vz, tnz = ux * vy - uy * vx;
                  const gxv = val[1] + val[2] + val[5] + val[6] - val[0] - val[3] - val[4] - val[7];
                  const gyv = val[2] + val[3] + val[6] + val[7] - val[0] - val[1] - val[4] - val[5];
                  const gzv = val[4] + val[5] + val[6] + val[7] - val[0] - val[1] - val[2] - val[3];
                  orient += Math.sign(tnx * gxv + tny * gyv + tnz * gzv);
                  orientN++;
                }
              }
            }
      }
  const positions = Float32Array.from(outP);
  const indices = Uint32Array.from(outI);
  if (orient < 0)
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
  const mesh: MeshData = {
    positions,
    indices,
    normals: computeNormals(positions, indices),
    colors: anyColor ? Float32Array.from(outC) : null,
    uvs: null,
  };
  return { mesh, voxel, samples: ns, blocks };
}
