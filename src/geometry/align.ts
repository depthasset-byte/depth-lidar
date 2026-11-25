// 정렬: kd-트리 최근접 탐색, 강체 맞춤(Horn), ICP, PCA 거친 정렬, 점군 법선 추정.
import { IDENTITY, Mat4, mat4FromRT, mat4Multiply, transformPoints } from './mesh';

export class KdTree {
  private idx: Uint32Array;
  private axis: Uint8Array;
  private bestD = 0;
  private bestI = -1;
  private qx = 0;
  private qy = 0;
  private qz = 0;
  constructor(private pts: Float32Array) {
    const n = pts.length / 3;
    this.idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.idx[i] = i;
    this.axis = new Uint8Array(n);
    const stack: number[] = [0, n];
    while (stack.length) {
      const hi = stack.pop()!, lo = stack.pop()!;
      if (hi - lo < 1) continue;
      // 범위가 가장 넓은 축 선택
      let ax = 0, best = -1;
      for (let k = 0; k < 3; k++) {
        let mn = Infinity, mx = -Infinity;
        for (let i = lo; i < hi; i++) {
          const v = pts[this.idx[i] * 3 + k];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (mx - mn > best) { best = mx - mn; ax = k; }
      }
      const mid = (lo + hi) >> 1;
      this.select(lo, hi - 1, mid, ax);
      this.axis[mid] = ax;
      stack.push(lo, mid, mid + 1, hi);
    }
  }
  private select(lo: number, hi: number, k: number, ax: number) {
    const { idx, pts } = this;
    while (lo < hi) {
      const pivot = pts[idx[(lo + hi) >> 1] * 3 + ax];
      let i = lo, j = hi;
      while (i <= j) {
        while (pts[idx[i] * 3 + ax] < pivot) i++;
        while (pts[idx[j] * 3 + ax] > pivot) j--;
        if (i <= j) {
          const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
          i++; j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }
  private search(lo: number, hi: number) {
    if (lo >= hi) return;
    const mid = (lo + hi) >> 1;
    const i = this.idx[mid];
    const p = this.pts;
    const dx = this.qx - p[i * 3], dy = this.qy - p[i * 3 + 1], dz = this.qz - p[i * 3 + 2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < this.bestD) { this.bestD = d; this.bestI = i; }
    const ax = this.axis[mid];
    const diff = ax === 0 ? dx : ax === 1 ? dy : dz;
    if (diff < 0) {
      this.search(lo, mid);
      if (diff * diff < this.bestD) this.search(mid + 1, hi);
    } else {
      this.search(mid + 1, hi);
      if (diff * diff < this.bestD) this.search(lo, mid);
    }
  }
  /** 가장 가까운 점의 번호(-1: 없음). 거리 제곱은 lastDist2에 남는다. */
  lastDist2 = 0;
  nearest(x: number, y: number, z: number, maxDist2 = Infinity): number {
    this.qx = x; this.qy = y; this.qz = z;
    this.bestD = maxDist2;
    this.bestI = -1;
    this.search(0, this.idx.length);
    this.lastDist2 = this.bestD;
    return this.bestI;
  }
  /** k개 최근접 점 번호 (가까운 순). */
  nearestK(x: number, y: number, z: number, k: number): number[] {
    const ids: number[] = [];
    const ds: number[] = [];
    const p = this.pts;
    const rec = (lo: number, hi: number) => {
      if (lo >= hi) return;
      const mid = (lo + hi) >> 1;
      const i = this.idx[mid];
      const dx = x - p[i * 3], dy = y - p[i * 3 + 1], dz = z - p[i * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (ids.length < k || d < ds[ds.length - 1]) {
        let j = ds.length;
        while (j > 0 && ds[j - 1] > d) j--;
        ds.splice(j, 0, d);
        ids.splice(j, 0, i);
        if (ids.length > k) { ds.pop(); ids.pop(); }
      }
      const ax = this.axis[mid];
      const diff = ax === 0 ? dx : ax === 1 ? dy : dz;
      const worst = ids.length < k ? Infinity : ds[ds.length - 1];
      if (diff < 0) {
        rec(lo, mid);
        if (diff * diff < (ids.length < k ? Infinity : ds[ds.length - 1])) rec(mid + 1, hi);
      } else {
        rec(mid + 1, hi);
        if (diff * diff < (ids.length < k ? Infinity : ds[ds.length - 1])) rec(lo, mid);
      }
      void worst;
    };
    rec(0, this.idx.length);
    return ids;
  }
}

/** 대칭 행렬의 고유값·고유벡터 (야코비). vectors[i]가 values[i]의 고유벡터. 값 내림차순. */
export function eigenSym(Ain: number[][]): { values: number[]; vectors: number[][] } {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const V: number[][] = A.map((_, i) => A.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const order = A.map((_, i) => i).sort((a, b) => A[b][b] - A[a][a]);
  return { values: order.map((i) => A[i][i]), vectors: order.map((i) => V.map((row) => row[i])) };
}

/** 대응점 쌍으로 강체 변환 계산 (Horn 사원수 해). P→Q. 반환 R은 행 우선 3x3. */
export function rigidFit(P: ArrayLike<number>, Q: ArrayLike<number>): { R: number[]; t: number[] } {
  const n = P.length / 3;
  const cp = [0, 0, 0], cq = [0, 0, 0];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      cp[k] += P[i * 3 + k];
      cq[k] += Q[i * 3 + k];
    }
  for (let k = 0; k < 3; k++) { cp[k] /= n; cq[k] /= n; }
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++) S[a * 3 + b] += (P[i * 3 + a] - cp[a]) * (Q[i * 3 + b] - cq[b]);
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const [w, x, y, z] = eigenSym(N).vectors[0];
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
  const t = [0, 0, 0];
  for (let k = 0; k < 3; k++) t[k] = cq[k] - (R[k * 3] * cp[0] + R[k * 3 + 1] * cp[1] + R[k * 3 + 2] * cp[2]);
  return { R, t };
}

function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = A.slice();
  const x = b.slice();
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[piv * n + c])) piv = r;
    if (Math.abs(M[piv * n + c]) < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) [M[c * n + k], M[piv * n + k]] = [M[piv * n + k], M[c * n + k]];
      [x[c], x[piv]] = [x[piv], x[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

function rodrigues(rx: number, ry: number, rz: number): number[] {
  const th = Math.hypot(rx, ry, rz);
  if (th < 1e-14) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const x = rx / th, y = ry / th, z = rz / th;
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

function subsample(p: Float32Array, n: Float32Array | null, max: number) {
  const count = p.length / 3;
  if (count <= max) return { p, n };
  const step = count / max;
  const op = new Float32Array(max * 3);
  const on = n ? new Float32Array(max * 3) : null;
  for (let i = 0; i < max; i++) {
    const s = Math.floor(i * step) * 3;
    op[i * 3] = p[s]; op[i * 3 + 1] = p[s + 1]; op[i * 3 + 2] = p[s + 2];
    if (on && n) { on[i * 3] = n[s]; on[i * 3 + 1] = n[s + 1]; on[i * 3 + 2] = n[s + 2]; }
  }
  return { p: op, n: on };
}

export interface IcpOptions {
  maxIterations?: number;
  samples?: number;
  /** 이 거리보다 먼 대응은 버린다 (0 또는 미지정이면 자동) */
  maxDistance?: number;
  initial?: Mat4;
}

export interface IcpResult {
  /** 움직이는 객체의 월드 좌표에 추가로 곱할 변환 */
  matrix: Mat4;
  rms: number;
  initialRms: number;
  iterations: number;
  pairs: number;
  samples: number;
}

export interface IcpTarget {
  tree: KdTree;
  points: Float32Array;
  normals: Float32Array | null;
}

export function makeIcpTarget(dst: Float32Array, dstNormals: Float32Array | null): IcpTarget {
  const d = subsample(dst, dstNormals, 400000);
  return { tree: new KdTree(d.p), points: d.p, normals: d.n };
}

/** 월드 좌표의 src 점들을 dst에 맞추는 ICP (법선이 있으면 점-평면, 없으면 점-점). */
export function icp(src: Float32Array, target: IcpTarget, opts: IcpOptions = {}): IcpResult {
  const maxIter = opts.maxIterations ?? 60;
  const s = subsample(src, null, opts.samples ?? 15000).p;
  const n = s.length / 3;
  let T: Mat4 = opts.initial ? opts.initial.slice() : IDENTITY.slice();
  let cur = opts.initial ? transformPoints(s, T) : s.slice();
  const { tree, points: D, normals: DN } = target;
  const nn = new Int32Array(n);
  const d2 = new Float64Array(n);
  let rms = Infinity, initialRms = 0, pairs = 0, it = 0, prev = Infinity;
  for (; ; it++) {
    for (let i = 0; i < n; i++) {
      nn[i] = tree.nearest(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
      d2[i] = tree.lastDist2;
    }
    const sorted = Float64Array.from(d2).sort();
    let thr2 = Math.max(sorted[n >> 1] * 6.25, 1e-18); // (2.5×중앙값)^2
    if (opts.maxDistance && opts.maxDistance > 0) thr2 = Math.min(thr2, opts.maxDistance * opts.maxDistance);
    let sum = 0;
    pairs = 0;
    for (let i = 0; i < n; i++) if (d2[i] <= thr2) { sum += d2[i]; pairs++; }
    rms = pairs ? Math.sqrt(sum / pairs) : Infinity;
    if (it === 0) initialRms = rms;
    if (it >= maxIter || pairs < 6 || Math.abs(prev - rms) < 1e-5 * rms + 1e-12) break;
    prev = rms;
    let R: number[], t: number[];
    let solved = false;
    R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    t = [0, 0, 0];
    if (DN) {
      const A = new Float64Array(36), b = new Float64Array(6);
      const row = new Float64Array(6);
      for (let i = 0; i < n; i++) {
        if (d2[i] > thr2) continue;
        const j = nn[i] * 3;
        const px = cur[i * 3], py = cur[i * 3 + 1], pz = cur[i * 3 + 2];
        const nx = DN[j], ny = DN[j + 1], nz = DN[j + 2];
        row[0] = py * nz - pz * ny;
        row[1] = pz * nx - px * nz;
        row[2] = px * ny - py * nx;
        row[3] = nx; row[4] = ny; row[5] = nz;
        const r = (D[j] - px) * nx + (D[j + 1] - py) * ny + (D[j + 2] - pz) * nz;
        for (let a = 0; a < 6; a++) {
          b[a] += row[a] * r;
          for (let c = 0; c < 6; c++) A[a * 6 + c] += row[a] * row[c];
        }
      }
      const x = solveLinear(A, b, 6);
      if (x) {
        R = rodrigues(x[0], x[1], x[2]);
        t = [x[3], x[4], x[5]];
        solved = true;
      }
    }
    if (!solved) {
      const P: number[] = [], Q: number[] = [];
      for (let i = 0; i < n; i++) {
        if (d2[i] > thr2) continue;
        const j = nn[i] * 3;
        P.push(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
        Q.push(D[j], D[j + 1], D[j + 2]);
      }
      const f = rigidFit(P, Q);
      R = f.R;
      t = f.t;
    }
    const delta = mat4FromRT(R, t);
    cur = transformPoints(cur, delta);
    T = mat4Multiply(delta, T);
  }
  return { matrix: T, rms, initialRms, iterations: it, pairs, samples: n };
}

function pcaFrame(p: Float32Array) {
  const n = p.length / 3;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += p[i * 3 + k];
  for (let k = 0; k < 3; k++) c[k] /= n || 1;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++)
      for (let b = a; b < 3; b++) C[a][b] += (p[i * 3 + a] - c[a]) * (p[i * 3 + b] - c[b]);
  C[1][0] = C[0][1]; C[2][0] = C[0][2]; C[2][1] = C[1][2];
  const e = eigenSym(C).vectors;
  const e1 = e[0], e2 = e[1];
  const e3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  return { c, axes: [e1, e2, e3] };
}

/** 초기 위치와 무관한 거친 정렬: 주축(PCA)을 맞춘 4가지 후보를 ICP로 평가해 가장 좋은 것을 정밀 정렬한다. */
export function coarseAlign(src: Float32Array, target: IcpTarget, opts: IcpOptions = {}): IcpResult {
  const fs = pcaFrame(subsample(src, null, 20000).p);
  const fd = pcaFrame(subsample(target.points, null, 20000).p);
  let best: IcpResult | null = null;
  let bestScore = Infinity;
  for (const [s1, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const sg = [s1, s2, s1 * s2];
    // R = Bd · diag(s) · Bs^T
    const R = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let k = 0; k < 3; k++) v += fd.axes[k][r] * sg[k] * fs.axes[k][c];
        R[r * 3 + c] = v;
      }
    const t = [0, 0, 0];
    for (let k = 0; k < 3; k++) t[k] = fd.c[k] - (R[k * 3] * fs.c[0] + R[k * 3 + 1] * fs.c[1] + R[k * 3 + 2] * fs.c[2]);
    const r = icp(src, target, { samples: 2500, maxIterations: 25, initial: mat4FromRT(R, t) });
    const score = r.rms / Math.max(0.05, r.pairs / r.samples);
    if (score < bestScore) { bestScore = score; best = r; }
  }
  return icp(src, target, { ...opts, initial: best!.matrix });
}

/** 수동 대응점(월드 좌표)으로 변환 계산. 3쌍 이상 필요. */
export function alignByPairs(movingPts: number[], fixedPts: number[]): Mat4 {
  const f = rigidFit(movingPts, fixedPts);
  return mat4FromRT(f.R, f.t);
}

/** 점군 법선 추정 (k-최근접 PCA). 방향은 점군 중심에서 바깥쪽으로 맞춘다(휴리스틱). */
export function estimateNormals(points: Float32Array, k = 12): Float32Array {
  const n = points.length / 3;
  const tree = new KdTree(points);
  const out = new Float32Array(n * 3);
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) c[a] += points[i * 3 + a];
  for (let a = 0; a < 3; a++) c[a] /= n || 1;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
    const nb = tree.nearestK(x, y, z, k);
    const m = [0, 0, 0];
    for (const j of nb) for (let a = 0; a < 3; a++) m[a] += points[j * 3 + a];
    for (let a = 0; a < 3; a++) m[a] /= nb.length;
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const j of nb)
      for (let a = 0; a < 3; a++)
        for (let b = a; b < 3; b++) C[a][b] += (points[j * 3 + a] - m[a]) * (points[j * 3 + b] - m[b]);
    C[1][0] = C[0][1]; C[2][0] = C[0][2]; C[2][1] = C[1][2];
    const v = eigenSym(C).vectors[2];
    const s = v[0] * (x - c[0]) + v[1] * (y - c[1]) + v[2] * (z - c[2]) < 0 ? -1 : 1;
    out[i * 3] = v[0] * s; out[i * 3 + 1] = v[1] * s; out[i * 3 + 2] = v[2] * s;
  }
  return out;
}
