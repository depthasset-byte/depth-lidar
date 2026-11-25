// 위상 연산: 연결 조각, 경계(구멍) 검출, 구멍 메우기, 스무딩.
import { MeshData, computeNormals, deleteElements, positionRemap, vertexCount } from './mesh';

/** 방향 간선 (a→b) 집합. 개방 주소 해시. */
class EdgeSet {
  private ka: Uint32Array;
  private kb: Uint32Array;
  private used: Uint8Array;
  private mask: number;
  constructor(capacity: number) {
    let size = 16;
    while (size < capacity * 2) size <<= 1;
    this.mask = size - 1;
    this.ka = new Uint32Array(size);
    this.kb = new Uint32Array(size);
    this.used = new Uint8Array(size);
  }
  private slot(a: number, b: number): number {
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) >>> 0;
    h = (h ^ (h >>> 15)) & this.mask;
    while (this.used[h] && (this.ka[h] !== a || this.kb[h] !== b)) h = (h + 1) & this.mask;
    return h;
  }
  add(a: number, b: number) {
    const h = this.slot(a, b);
    this.used[h] = 1;
    this.ka[h] = a;
    this.kb[h] = b;
  }
  has(a: number, b: number): boolean {
    return this.used[this.slot(a, b)] === 1;
  }
}

/** 면별 연결 조각 번호와 조각별 삼각형 수. */
export function componentLabels(m: MeshData): { labels: Uint32Array; sizes: Uint32Array } {
  const idx = m.indices!;
  const { ids, count } = positionRemap(m.positions);
  const parent = new Uint32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (x: number) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let i = 0; i < idx.length; i += 3) {
    const a = find(ids[idx[i]]), b = find(ids[idx[i + 1]]), c = find(ids[idx[i + 2]]);
    if (a !== b) parent[b] = a;
    const a2 = find(a), c2 = find(c);
    if (a2 !== c2) parent[c2] = a2;
  }
  const compOf = new Int32Array(count).fill(-1);
  const tc = idx.length / 3;
  const labels = new Uint32Array(tc);
  const sizes: number[] = [];
  for (let f = 0; f < tc; f++) {
    const r = find(ids[idx[f * 3]]);
    let c = compOf[r];
    if (c < 0) {
      c = compOf[r] = sizes.length;
      sizes.push(0);
    }
    labels[f] = c;
    sizes[c]++;
  }
  return { labels, sizes: Uint32Array.from(sizes) };
}

export interface RemoveSmallOptions {
  mode: 'largest' | 'threshold';
  minTriangles: number;
}

export function removeSmallComponents(m: MeshData, opts: RemoveSmallOptions) {
  if (!m.indices) return { mesh: m, removedComponents: 0, removedTriangles: 0, components: 0 };
  const { labels, sizes } = componentLabels(m);
  let largest = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[largest]) largest = i;
  const drop = new Uint8Array(sizes.length);
  let removedComponents = 0;
  for (let i = 0; i < sizes.length; i++) {
    const d = opts.mode === 'largest' ? i !== largest : sizes[i] < opts.minTriangles;
    if (d) {
      drop[i] = 1;
      removedComponents++;
    }
  }
  if (!removedComponents) return { mesh: m, removedComponents: 0, removedTriangles: 0, components: sizes.length };
  const mask = new Uint8Array(labels.length);
  let removedTriangles = 0;
  for (let f = 0; f < labels.length; f++)
    if (drop[labels[f]]) {
      mask[f] = 1;
      removedTriangles++;
    }
  return { mesh: deleteElements(m, mask), removedComponents, removedTriangles, components: sizes.length };
}

export interface HoleLoop {
  /** 경계 반간선 방향 순서의 실제 정점 번호 */
  vertices: Uint32Array;
  perimeter: number;
}

/** 경계 루프(구멍과 바깥 테두리) 검출. 둘레가 큰 순으로 정렬한다. */
export function findBoundaryLoops(m: MeshData): HoleLoop[] {
  const idx = m.indices;
  if (!idx) return [];
  const { ids } = positionRemap(m.positions);
  const set = new EdgeSet(idx.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = ids[idx[i]], b = ids[idx[i + 1]], c = ids[idx[i + 2]];
    set.add(a, b);
    set.add(b, c);
    set.add(c, a);
  }
  const eo: number[] = []; // 시작 정점(실제 번호)
  const ed: number[] = []; // 끝 정점(실제 번호)
  for (let i = 0; i < idx.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const u = idx[i + k], v = idx[i + ((k + 1) % 3)];
      if (!set.has(ids[v], ids[u])) {
        eo.push(u);
        ed.push(v);
      }
    }
  const from = new Map<number, number[]>();
  for (let e = 0; e < eo.length; e++) {
    const k = ids[eo[e]];
    const l = from.get(k);
    if (l) l.push(e);
    else from.set(k, [e]);
  }
  const used = new Uint8Array(eo.length);
  const loops: HoleLoop[] = [];
  const p = m.positions;
  for (let e0 = 0; e0 < eo.length; e0++) {
    if (used[e0]) continue;
    const verts: number[] = [];
    let cur = e0;
    let closed = false;
    const startKey = ids[eo[e0]];
    for (let guard = 0; guard <= eo.length; guard++) {
      used[cur] = 1;
      verts.push(eo[cur]);
      const dk = ids[ed[cur]];
      if (dk === startKey) {
        closed = true;
        break;
      }
      const cand = from.get(dk);
      let next = -1;
      if (cand) for (const c of cand) if (!used[c]) { next = c; break; }
      if (next < 0) break;
      cur = next;
    }
    if (!closed || verts.length < 3) continue;
    let perimeter = 0;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i] * 3, b = verts[(i + 1) % verts.length] * 3;
      perimeter += Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
    }
    loops.push({ vertices: Uint32Array.from(verts), perimeter });
  }
  loops.sort((a, b) => b.perimeter - a.perimeter);
  return loops;
}

export function countBoundaryEdges(m: MeshData): number {
  let n = 0;
  for (const l of findBoundaryLoops(m)) n += l.vertices.length;
  return n;
}

/** 늘어나는 정점 속성 버퍼. */
class GrowAttr {
  data: Float32Array;
  count: number;
  constructor(src: Float32Array, private stride: number) {
    this.data = src;
    this.count = src.length / stride;
  }
  push(vals: number[]): number {
    if ((this.count + 1) * this.stride > this.data.length) {
      const n = new Float32Array(Math.max(this.data.length * 2, 1024));
      n.set(this.data);
      this.data = n;
    }
    this.data.set(vals, this.count * this.stride);
    return this.count++;
  }
  finish(): Float32Array {
    return this.data.length === this.count * this.stride ? this.data : this.data.slice(0, this.count * this.stride);
  }
}

/** 최소 각 귀 자르기로 루프 다각형을 삼각 분할. poly는 채움 면의 감는 방향 순서. */
function triangulateLoop(poly: number[], P: Float32Array): number[] {
  const n = poly.length;
  // 뉴웰 법선
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i] * 3, b = poly[(i + 1) % n] * 3;
    nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
    ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
    nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
  }
  const prev = new Int32Array(n), next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n;
    next[i] = (i + 1) % n;
  }
  const angle = new Float64Array(n);
  const calc = (i: number) => {
    const c = poly[i] * 3, a = poly[prev[i]] * 3, b = poly[next[i]] * 3;
    const ux = P[b] - P[c], uy = P[b + 1] - P[c + 1], uz = P[b + 2] - P[c + 2];
    const vx = P[a] - P[c], vy = P[a + 1] - P[c + 1], vz = P[a + 2] - P[c + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const dot = ux * vx + uy * vy + uz * vz;
    const ang = Math.atan2(Math.hypot(cx, cy, cz), dot);
    const convex = cx * nx + cy * ny + cz * nz >= 0;
    angle[i] = convex ? ang : 2 * Math.PI - ang;
  };
  for (let i = 0; i < n; i++) calc(i);
  const alive = new Uint8Array(n).fill(1);
  const tris: number[] = [];
  let remaining = n;
  while (remaining > 3) {
    let best = -1, bestA = Infinity;
    for (let i = 0; i < n; i++) if (alive[i] && angle[i] < bestA) { bestA = angle[i]; best = i; }
    const a = prev[best], b = next[best];
    tris.push(poly[a], poly[best], poly[b]);
    alive[best] = 0;
    next[a] = b;
    prev[b] = a;
    calc(a);
    calc(b);
    remaining--;
  }
  let i0 = 0;
  while (!alive[i0]) i0++;
  tris.push(poly[prev[i0]], poly[i0], poly[next[i0]]);
  return tris;
}

export interface FillHolesOptions {
  /** 이 간선 수 이하인 구멍만 메운다 (loopIndices가 없을 때) */
  maxEdges?: number;
  /** findBoundaryLoops 결과 기준으로 메울 루프 번호 */
  loopIndices?: number[];
  /** 채운 면을 주변 밀도에 맞게 세분하고 매끄럽게 한다 */
  refine?: boolean;
}

export function fillHoles(m: MeshData, opts: FillHolesOptions = {}) {
  if (!m.indices) return { mesh: m, filled: 0, addedTriangles: 0 };
  const loops = findBoundaryLoops(m);
  const chosen = opts.loopIndices
    ? opts.loopIndices.map((i) => loops[i]).filter(Boolean)
    : loops.filter((l) => l.vertices.length <= (opts.maxEdges ?? 100));
  if (!chosen.length) return { mesh: m, filled: 0, addedTriangles: 0 };

  const pos = new GrowAttr(m.positions.slice(), 3);
  const col = m.colors ? new GrowAttr(m.colors.slice(), 3) : null;
  const uv = m.uvs ? new GrowAttr(m.uvs.slice(), 2) : null;
  const added: number[] = [];
  const key = (a: number, b: number) => (a < b ? a * 67108864 + b : b * 67108864 + a);

  for (const loop of chosen) {
    if (loop.vertices.length > 20000) continue;
    const poly = Array.from(loop.vertices).reverse();
    let tris = triangulateLoop(poly, pos.data);
    if (opts.refine !== false && poly.length > 4) {
      const fixedCount = pos.count;
      const target = (loop.perimeter / poly.length) * 1.5;
      const elen = (a: number, b: number) => {
        const P = pos.data;
        return Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
      };
      const buildEdges = () => {
        const em = new Map<number, number[]>();
        for (let t = 0; t < tris.length; t += 3)
          for (let k = 0; k < 3; k++) {
            const kk = key(tris[t + k], tris[t + ((k + 1) % 3)]);
            const l = em.get(kk);
            if (l) l.push(t);
            else em.set(kk, [t]);
          }
        return em;
      };
      const third = (t: number, a: number, b: number) => {
        for (let k = 0; k < 3; k++) if (tris[t + k] !== a && tris[t + k] !== b) return tris[t + k];
        return -1;
      };
      const hasDir = (t: number, a: number, b: number) => {
        for (let k = 0; k < 3; k++) if (tris[t + k] === a && tris[t + ((k + 1) % 3)] === b) return true;
        return false;
      };
      const smooth = (iters: number) => {
        if (pos.count === fixedCount) return;
        const nb = new Map<number, Set<number>>();
        for (let t = 0; t < tris.length; t += 3)
          for (let k = 0; k < 3; k++) {
            const v = tris[t + k];
            if (v < fixedCount) continue;
            let s = nb.get(v);
            if (!s) nb.set(v, (s = new Set()));
            s.add(tris[t + ((k + 1) % 3)]);
            s.add(tris[t + ((k + 2) % 3)]);
          }
        const P = pos.data;
        for (let it = 0; it < iters; it++)
          for (const [v, s] of nb) {
            let x = 0, y = 0, z = 0;
            for (const u of s) {
              x += P[u * 3];
              y += P[u * 3 + 1];
              z += P[u * 3 + 2];
            }
            P[v * 3] = x / s.size;
            P[v * 3 + 1] = y / s.size;
            P[v * 3 + 2] = z / s.size;
          }
      };
      for (let pass = 0; pass < 14 && pos.count - fixedCount < 60000; pass++) {
        // 1) 긴 내부 간선 분할
        let em = buildEdges();
        const cand: { a: number; b: number; len: number; ts: number[] }[] = [];
        for (const [kk, ts] of em) {
          if (ts.length !== 2) continue;
          const a = Math.floor(kk / 67108864), b = kk % 67108864;
          const len = elen(a, b);
          if (len > target) cand.push({ a, b, len, ts });
        }
        if (!cand.length) break;
        cand.sort((x, y) => y.len - x.len);
        const touched = new Set<number>();
        for (const c of cand) {
          const [t1, t2] = c.ts;
          if (touched.has(t1) || touched.has(t2)) continue;
          touched.add(t1);
          touched.add(t2);
          const { a, b } = c;
          const P = pos.data;
          const mIdx = pos.push([(P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2]);
          if (col) {
            const C = col.data;
            col.push([(C[a * 3] + C[b * 3]) / 2, (C[a * 3 + 1] + C[b * 3 + 1]) / 2, (C[a * 3 + 2] + C[b * 3 + 2]) / 2]);
          }
          if (uv) {
            const U = uv.data;
            uv.push([(U[a * 2] + U[b * 2]) / 2, (U[a * 2 + 1] + U[b * 2 + 1]) / 2]);
          }
          for (const t of [t1, t2]) {
            const o = third(t, a, b);
            // (x→y) 방향을 유지하며 두 삼각형으로 나눈다.
            const [x, y] = hasDir(t, a, b) ? [a, b] : [b, a];
            tris[t] = x; tris[t + 1] = mIdx; tris[t + 2] = o;
            tris.push(mIdx, y, o);
          }
        }
        smooth(2);
        // 2) 간선 뒤집기 (들로네 조건)
        em = buildEdges();
        const flipped = new Set<number>();
        const P = pos.data;
        const ang = (apex: number, a: number, b: number) => {
          const ux = P[a * 3] - P[apex * 3], uy = P[a * 3 + 1] - P[apex * 3 + 1], uz = P[a * 3 + 2] - P[apex * 3 + 2];
          const vx = P[b * 3] - P[apex * 3], vy = P[b * 3 + 1] - P[apex * 3 + 1], vz = P[b * 3 + 2] - P[apex * 3 + 2];
          const d = (ux * vx + uy * vy + uz * vz) / ((Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) || 1);
          return Math.acos(Math.max(-1, Math.min(1, d)));
        };
        for (const [kk, ts] of em) {
          if (ts.length !== 2) continue;
          const [t1, t2] = ts;
          if (flipped.has(t1) || flipped.has(t2)) continue;
          let a = Math.floor(kk / 67108864), b = kk % 67108864;
          if (!hasDir(t1, a, b)) [a, b] = [b, a];
          if (!hasDir(t1, a, b) || !hasDir(t2, b, a)) continue;
          const c = third(t1, a, b), d = third(t2, a, b);
          if (c < 0 || d < 0 || c === d) continue;
          if (ang(c, a, b) + ang(d, a, b) <= Math.PI + 1e-6) continue;
          if (em.has(key(c, d))) continue;
          tris[t1] = a; tris[t1 + 1] = d; tris[t1 + 2] = c;
          tris[t2] = d; tris[t2 + 1] = b; tris[t2 + 2] = c;
          flipped.add(t1);
          flipped.add(t2);
        }
      }
      smooth(30);
    }
    for (const t of tris) added.push(t);
  }
  const indices = new Uint32Array(m.indices.length + added.length);
  indices.set(m.indices);
  indices.set(added, m.indices.length);
  const positions = pos.finish();
  return {
    mesh: {
      positions,
      indices,
      normals: computeNormals(positions, indices),
      colors: col ? col.finish() : null,
      uvs: uv ? uv.finish() : null,
    } as MeshData,
    filled: chosen.length,
    addedTriangles: added.length / 3,
  };
}

export interface SmoothOptions {
  iterations: number;
  /** 0..1 */
  strength: number;
  /** true면 부피 수축이 적은 타우빈 방식 */
  taubin: boolean;
}

export function smoothMesh(m: MeshData, opts: SmoothOptions): MeshData {
  const idx = m.indices;
  if (!idx) return m;
  const { ids, count } = positionRemap(m.positions);
  const n = vertexCount(m);
  let cur = new Float64Array(count * 3);
  for (let i = 0; i < n; i++) {
    const c = ids[i] * 3;
    cur[c] = m.positions[i * 3];
    cur[c + 1] = m.positions[i * 3 + 1];
    cur[c + 2] = m.positions[i * 3 + 2];
  }
  const sum = new Float64Array(count * 3);
  const cnt = new Uint32Array(count);
  for (let i = 0; i < idx.length; i += 3) {
    const a = ids[idx[i]], b = ids[idx[i + 1]], c = ids[idx[i + 2]];
    cnt[a] += 2; cnt[b] += 2; cnt[c] += 2;
  }
  const lambda = Math.max(0, Math.min(1, opts.strength));
  const mu = -lambda / (1 - 0.1 * lambda);
  const step = (f: number) => {
    sum.fill(0);
    for (let i = 0; i < idx.length; i += 3) {
      const a = ids[idx[i]] * 3, b = ids[idx[i + 1]] * 3, c = ids[idx[i + 2]] * 3;
      for (let k = 0; k < 3; k++) {
        const pa = cur[a + k], pb = cur[b + k], pc = cur[c + k];
        sum[a + k] += pb + pc;
        sum[b + k] += pa + pc;
        sum[c + k] += pa + pb;
      }
    }
    const nxt = new Float64Array(count * 3);
    for (let v = 0; v < count; v++) {
      const c = cnt[v];
      for (let k = 0; k < 3; k++) {
        const p = cur[v * 3 + k];
        nxt[v * 3 + k] = c ? p + f * (sum[v * 3 + k] / c - p) : p;
      }
    }
    cur = nxt;
  };
  for (let it = 0; it < opts.iterations; it++) {
    step(lambda);
    if (opts.taubin) step(mu);
  }
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = ids[i] * 3;
    positions[i * 3] = cur[c];
    positions[i * 3 + 1] = cur[c + 1];
    positions[i * 3 + 2] = cur[c + 2];
  }
  return { ...m, positions, normals: computeNormals(positions, idx) };
}

export function flipNormals(m: MeshData): MeshData {
  if (!m.indices) {
    if (!m.normals) return m;
    const normals = m.normals.slice();
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
    return { ...m, normals };
  }
  const indices = m.indices.slice();
  for (let i = 0; i < indices.length; i += 3) {
    const t = indices[i + 1];
    indices[i + 1] = indices[i + 2];
    indices[i + 2] = t;
  }
  return { ...m, indices, normals: computeNormals(m.positions, indices) };
}
