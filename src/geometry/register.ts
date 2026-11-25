// 지상 라이다 스캔 여러 장의 자동 정합.
// 전제: 각 스캔은 수평이 맞춰져 있고(Y가 위) 원점이 스캐너 위치다. 단위는 mm.
// 순서: (1) 벽 방향 분포를 맞춰 회전 후보를 정하고
//       (2) 벽 점을 바닥에 투영한 그림끼리의 상관(FFT)으로 이동 후보를 넓게 뽑는다(복도처럼 미끄러지는 방향도 훑는다).
//       (3) "한 스캔이 뚫고 본 공간에 다른 스캔의 표면이 있으면 안 된다"는 가시성 검사로 후보를 추리고
//       (4) 남은 후보를 ICP로 다듬어 다시 엄격하게 채점해 고른다.
//       (5) 쌍들을 점수 높은 순으로 이어 붙이고 전체를 다시 ICP로 다듬는다.
import { IcpResult, icp, makeIcpTarget } from './align';
import { IDENTITY, Mat4, mat4Invert, mat4Multiply, transformNormals, transformPoints } from './mesh';

export interface RegScan {
  positions: Float32Array;
  normals: Float32Array;
}

export interface RegisterOptions {
  /** 거친 탐색의 칸 크기 (mm) */
  cell?: number;
  /** 쌍마다 ICP로 다듬어 볼 후보 수 */
  candidates?: number;
  log?: (text: string) => void;
}

export interface PairResult {
  a: number;
  b: number;
  /** b의 좌표를 a의 좌표로 옮기는 행렬 */
  matrix: Mat4;
  score: number;
  /** 서로의 표면과 겹친 표본 비율 */
  agree: number;
  /** 상대가 뚫고 본 공간에 놓인 표본 비율 */
  violate: number;
  rms: number;
}

interface Prepared {
  /** 줄인 점과 법선 */
  p: Float32Array;
  n: Float32Array;
  /** 채점용으로 더 줄인 점과 그 법선 */
  q: Float32Array;
  qn: Float32Array;
  /** 벽 점의 x, z */
  wall: Float32Array;
  /** 벽 법선 방향 분포 (0~180도, 0.5도 칸) */
  dirHist: Float64Array;
  floorY: number | null;
  ceilY: number | null;
  depth: DepthMap;
  radius: number;
}

// ───────── 방향별 거리 지도 (가시성 검사용) ─────────
const AZ_BINS = 720;
const EL_BINS = 360;
interface DepthMap {
  min: Float32Array;
  max: Float32Array;
}

function binOf(x: number, y: number, z: number, r: number): number {
  let az = Math.floor(((Math.atan2(z, x) + Math.PI) / (2 * Math.PI)) * AZ_BINS);
  if (az >= AZ_BINS) az = AZ_BINS - 1;
  let el = Math.floor((Math.acos(Math.max(-1, Math.min(1, y / r))) / Math.PI) * EL_BINS);
  if (el >= EL_BINS) el = EL_BINS - 1;
  return el * AZ_BINS + az;
}

function buildDepth(p: Float32Array): DepthMap {
  const size = AZ_BINS * EL_BINS;
  const min0 = new Float32Array(size).fill(Infinity);
  const max0 = new Float32Array(size);
  for (let i = 0; i < p.length; i += 3) {
    const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
    if (r < 1) continue;
    const b = binOf(p[i], p[i + 1], p[i + 2], r);
    if (r < min0[b]) min0[b] = r;
    if (r > max0[b]) max0[b] = r;
  }
  // 이웃 칸까지 넓혀 둔다: 가장 가까운 값은 더 가깝게, 가장 먼 값은 더 멀게. 물체 가장자리에서 헛위반이 나지 않게 한다.
  const min = new Float32Array(size).fill(Infinity);
  const max = new Float32Array(size);
  for (let e = 0; e < EL_BINS; e++) for (let a = 0; a < AZ_BINS; a++) {
    let lo = Infinity, hi = 0;
    for (let de = -1; de <= 1; de++) {
      const ee = e + de;
      if (ee < 0 || ee >= EL_BINS) continue;
      for (let da = -1; da <= 1; da++) {
        const k = ee * AZ_BINS + ((a + da + AZ_BINS) % AZ_BINS);
        if (min0[k] < lo) lo = min0[k];
        if (max0[k] > hi) hi = max0[k];
      }
    }
    // 가운데 칸에 관측이 있을 때만 쓴다
    if (min0[e * AZ_BINS + a] !== Infinity) { min[e * AZ_BINS + a] = lo; max[e * AZ_BINS + a] = hi; }
  }
  return { min, max };
}

interface Tolerance {
  abs: number;
  rel: number;
}
const LOOSE: Tolerance = { abs: 400, rel: 0.04 };
const TIGHT: Tolerance = { abs: 80, rel: 0.01 };

/** 지도 한 칸의 각도 폭(라디안). 이웃 칸까지 넓혀 쓰므로 1.5배. */
const BIN_RAD = ((2 * Math.PI) / AZ_BINS) * 1.5;
/** 지도 주인 쪽을 향한 정도(코사인)가 이보다 작은 점은 채점에서 뺀다: 비스듬히 스친 면은 칸 안의 거리 폭이 너무 커서 판정이 틀린다. */
const MIN_FACING = 0.5;

/** m으로 옮긴 pts(법선 nrm)를 거리 지도에 비춰 겹침·위반 수를 센다. */
function consistency(map: DepthMap, pts: Float32Array, nrm: Float32Array, m: Mat4, tol: Tolerance): { agree: number; violate: number; n: number } {
  let agree = 0, violate = 0, n = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const px = pts[i], py = pts[i + 1], pz = pts[i + 2];
    const x = m[0] * px + m[4] * py + m[8] * pz + m[12];
    const y = m[1] * px + m[5] * py + m[9] * pz + m[13];
    const z = m[2] * px + m[6] * py + m[10] * pz + m[14];
    const r = Math.hypot(x, y, z);
    if (r < 300) continue;
    const qx = nrm[i], qy = nrm[i + 1], qz = nrm[i + 2];
    const nx = m[0] * qx + m[4] * qy + m[8] * qz;
    const ny = m[1] * qx + m[5] * qy + m[9] * qz;
    const nz = m[2] * qx + m[6] * qy + m[10] * qz;
    const d = -(nx * x + ny * y + nz * z) / r;
    if (d < MIN_FACING) continue;
    const b = binOf(x, y, z, r);
    const lo = map.min[b];
    if (lo === Infinity) continue;
    n++;
    const t = tol.abs + r * tol.rel + (r * BIN_RAD * Math.sqrt(Math.max(0, 1 - d * d))) / d;
    if (r < lo - t) violate++;
    else if (r <= map.max[b] + t) agree++;
  }
  return { agree, violate, n };
}

/** 위반은 겹침보다 훨씬 무겁게 친다: 올바른 정합에서는 움직인 물체 말고는 위반이 거의 없다. */
const VIOLATION_WEIGHT = 40;

function scorePair(A: Prepared, B: Prepared, m: Mat4, tol: Tolerance) {
  const c1 = consistency(A.depth, B.q, B.qn, m, tol);
  const c2 = consistency(B.depth, A.q, A.qn, mat4Invert(m), tol);
  const n = c1.n + c2.n;
  const total = A.q.length / 3 + B.q.length / 3;
  if (n < 100) return { agree: 0, violate: 1, score: -VIOLATION_WEIGHT };
  const agree = (c1.agree + c2.agree) / n;
  const violate = (c1.violate + c2.violate) / n;
  // 서로 마주 보는 표본이 적은(거의 안 겹치는) 배치가 높은 점수를 받지 않게 겹친 정도를 곱한다.
  const coverage = Math.min(1, n / (0.08 * total));
  return { agree, violate, score: (agree - VIOLATION_WEIGHT * violate) * coverage };
}

// ───────── 준비 ─────────
function stride(p: Float32Array, nrm: Float32Array, target: number): { p: Float32Array; n: Float32Array } {
  const count = p.length / 3;
  const step = Math.max(1, Math.floor(count / target));
  const m = Math.ceil(count / step);
  const op = new Float32Array(m * 3), on = new Float32Array(m * 3);
  let k = 0;
  // 격자 순서의 줄무늬를 피하려고 간격 안에서 위치를 흩뜨린다
  for (let i = 0; i < count && k < m; i += step) {
    const j = Math.min(count - 1, i + ((i * 7919) % step));
    op[k * 3] = p[j * 3]; op[k * 3 + 1] = p[j * 3 + 1]; op[k * 3 + 2] = p[j * 3 + 2];
    on[k * 3] = nrm[j * 3]; on[k * 3 + 1] = nrm[j * 3 + 1]; on[k * 3 + 2] = nrm[j * 3 + 2];
    k++;
  }
  return { p: op.subarray(0, k * 3), n: on.subarray(0, k * 3) };
}

function histPeak(values: number[], bin: number): number | null {
  if (values.length < 200) return null;
  const h = new Map<number, number>();
  for (const v of values) {
    const k = Math.round(v / bin);
    h.set(k, (h.get(k) ?? 0) + 1);
  }
  let best = 0, bk = 0;
  for (const [k, c] of h) {
    const s = c + (h.get(k - 1) ?? 0) + (h.get(k + 1) ?? 0);
    if (s > best) { best = s; bk = k; }
  }
  if (best < values.length * 0.15) return null;
  let sum = 0, w = 0;
  for (let d = -1; d <= 1; d++) { const c = h.get(bk + d) ?? 0; sum += (bk + d) * bin * c; w += c; }
  return sum / w;
}

const DIR_BINS = 360; // 0.5도 칸, 0~180도

function prepare(s: RegScan): Prepared {
  const sub = stride(s.positions, s.normals, 250000);
  const wall: number[] = [];
  const floor: number[] = [], ceil: number[] = [];
  const radii: number[] = [];
  const dirHist = new Float64Array(DIR_BINS);
  for (let i = 0; i < sub.p.length; i += 3) {
    const ny = sub.n[i + 1];
    // 탐색 범위(반경)는 모든 점의 수평 거리로 잰다. 먼 벽은 비스듬해 벽 점으로는 잘 안 잡힌다.
    if ((i / 3) % 16 === 0) radii.push(Math.hypot(sub.p[i], sub.p[i + 2]));
    if (Math.abs(ny) < 0.3) {
      wall.push(sub.p[i], sub.p[i + 2]);
      let ang = (Math.atan2(sub.n[i + 2], sub.n[i]) * 180) / Math.PI;
      if (ang < 0) ang += 180;
      if (ang >= 180) ang -= 180;
      dirHist[Math.min(DIR_BINS - 1, Math.floor(ang * 2))]++;
    } else if (ny > 0.9 && sub.p[i + 1] < 0) floor.push(sub.p[i + 1]);
    else if (ny < -0.9 && sub.p[i + 1] > 0) ceil.push(sub.p[i + 1]);
  }
  radii.sort((a, b) => a - b);
  const qs = stride(s.positions, s.normals, 40000);
  return {
    p: sub.p,
    n: sub.n,
    q: qs.p,
    qn: qs.n,
    wall: Float32Array.from(wall),
    dirHist,
    floorY: histPeak(floor, 20),
    ceilY: histPeak(ceil, 20),
    depth: buildDepth(s.positions),
    radius: radii.length ? radii[Math.floor(radii.length * 0.9995)] : 10000,
  };
}

/** 벽 방향 분포를 맞춰 b를 돌릴 각도 후보(도)를 고른다. 분포는 180도 주기라 반대 방향도 함께 넣는다. */
function yawCandidates(A: Prepared, B: Prepared): number[] {
  const smooth = (h: Float64Array) => {
    const o = new Float64Array(DIR_BINS);
    for (let i = 0; i < DIR_BINS; i++) for (let d = -2; d <= 2; d++) o[i] += h[(i + d + DIR_BINS) % DIR_BINS];
    return o;
  };
  const ha = smooth(A.dirHist), hb = smooth(B.dirHist);
  const corr = new Float64Array(DIR_BINS);
  // b의 벽 법선 각도 φ는 yaw만큼 돌리면 φ - yaw가 된다 (Y축 회전 행렬의 부호 규약).
  for (let s = 0; s < DIR_BINS; s++) {
    let v = 0;
    for (let i = 0; i < DIR_BINS; i++) v += ha[(i - s + DIR_BINS) % DIR_BINS] * hb[i];
    corr[s] = v;
  }
  const order = Array.from(corr.keys()).sort((x, y) => corr[y] - corr[x]);
  const picks: number[] = [];
  for (const s of order) {
    if (picks.length >= 6) break;
    if (corr[s] < corr[order[0]] * 0.35) break;
    if (picks.some((p) => { const d = Math.abs(p - s); return Math.min(d, DIR_BINS - d) < 16; })) continue;
    picks.push(s);
  }
  const out: number[] = [];
  for (const s of picks) {
    const yaw = s / 2;
    out.push(yaw, yaw + 180);
  }
  return out;
}

// ───────── 2차원 FFT ─────────
function fft1(re: Float64Array, im: Float64Array, off: number, n: number, stridePx: number, inverse: boolean, cosT: Float64Array, sinT: Float64Array) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = off + i * stridePx, b = off + j * stridePx;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step], wi = inverse ? sinT[k * step] : -sinT[k * step];
        const a = off + (i + k) * stridePx, b = off + (i + k + half) * stridePx;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, n: number, inverse: boolean, cosT: Float64Array, sinT: Float64Array) {
  for (let y = 0; y < n; y++) fft1(re, im, y * n, n, 1, inverse, cosT, sinT);
  for (let x = 0; x < n; x++) fft1(re, im, x, n, n, inverse, cosT, sinT);
}

interface Candidate {
  yaw: number;
  tx: number;
  tz: number;
  value: number;
}

/** 벽 그림의 상관으로 (회전, 이동) 후보를 뽑는다. b를 yaw만큼 돌리고 (tx, tz)만큼 옮기면 a와 겹친다. */
function coarseCandidates(A: Prepared, B: Prepared, cell: number, yaws: number[]): Candidate[] {
  const need = (2 * (A.radius + B.radius)) / cell;
  let N = 256;
  while (N < need && N < 1024) N <<= 1;
  const c = Math.max(cell, (2 * (A.radius + B.radius)) / N);
  const half = N >> 1;
  const cosT = new Float64Array(half), sinT = new Float64Array(half);
  for (let i = 0; i < half; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / N); sinT[i] = Math.sin((2 * Math.PI * i) / N); }
  const size = N * N;
  // a 그림: 점유 칸은 1, 그 둘레 한 칸은 0.5
  const occ = new Uint8Array(size);
  for (let i = 0; i < A.wall.length; i += 2) {
    const x = Math.floor(A.wall[i] / c) + half, z = Math.floor(A.wall[i + 1] / c) + half;
    if (x >= 1 && z >= 1 && x < N - 1 && z < N - 1) occ[z * N + x] = 1;
  }
  const aRe = new Float64Array(size), aIm = new Float64Array(size);
  for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
    if (occ[z * N + x]) { aRe[z * N + x] = 1; continue; }
    let s = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) s += occ[(z + dz) * N + x + dx];
    if (s) aRe[z * N + x] = 0.5;
  }
  fft2(aRe, aIm, N, false, cosT, sinT);
  const bRe = new Float64Array(size), bIm = new Float64Array(size);
  const all: Candidate[] = [];
  for (const yaw of yaws) {
    const t = (yaw * Math.PI) / 180, cs = Math.cos(t), sn = Math.sin(t);
    bRe.fill(0); bIm.fill(0);
    for (let i = 0; i < B.wall.length; i += 2) {
      const x0 = B.wall[i], z0 = B.wall[i + 1];
      const x = Math.floor((x0 * cs + z0 * sn) / c) + half, z = Math.floor((-x0 * sn + z0 * cs) / c) + half;
      if (x >= 0 && z >= 0 && x < N && z < N) bRe[z * N + x] = 1;
    }
    fft2(bRe, bIm, N, false, cosT, sinT);
    for (let i = 0; i < size; i++) {
      const r = aRe[i] * bRe[i] + aIm[i] * bIm[i];
      const m = aIm[i] * bRe[i] - aRe[i] * bIm[i];
      bRe[i] = r; bIm[i] = m;
    }
    fft2(bRe, bIm, N, true, cosT, sinT);
    let mx = 0;
    for (let i = 0; i < size; i++) if (bRe[i] > mx) mx = bRe[i];
    // 상관이 최고값의 1/4을 넘는 칸을 모두 후보로 둔다(많으면 높은 순 4000개).
    // 복도처럼 한 방향으로 미끄러져도 상관이 비슷한 곳에서는 봉우리만 고르면 정답을 놓치기 때문이다.
    let idx: number[] = [];
    for (let i = 0; i < size; i++) if (bRe[i] > mx * 0.25) idx.push(i);
    if (idx.length > 4000) {
      idx.sort((p, q) => bRe[q] - bRe[p]);
      idx = idx.slice(0, 4000);
    }
    for (const i of idx) {
      let sx = i % N, sz = (i - sx) / N;
      if (sx >= half) sx -= N;
      if (sz >= half) sz -= N;
      all.push({ yaw, tx: sx * c, tz: sz * c, value: bRe[i] / (mx || 1) });
    }
  }
  return all;
}

const yawMatrix = (yawDeg: number, tx: number, ty: number, tz: number): Mat4 => {
  const t = (yawDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1];
};

function refine(src: Float32Array, target: ReturnType<typeof makeIcpTarget>, start: Mat4, dists: number[], samples: number): { matrix: Mat4; last: IcpResult } {
  let m = start;
  let last!: IcpResult;
  for (const d of dists) {
    last = icp(src, target, { initial: m, maxDistance: d, maxIterations: 40, samples });
    m = last.matrix;
  }
  return { matrix: m, last };
}

// ───────── 복도 후보 ─────────
/** 벽 법선 방향의 대표값(도, 0~180)과 그 방향(±6도)에 몰린 비율 */
function axisInfo(P: Prepared): { phi: number; share: number } {
  let best = 0;
  for (let i = 0; i < DIR_BINS; i++) if (P.dirHist[i] > P.dirHist[best]) best = i;
  let near = 0, all = 0, sx = 0, sy = 0;
  for (let i = 0; i < DIR_BINS; i++) {
    all += P.dirHist[i];
    let d = i - best;
    if (d > DIR_BINS / 2) d -= DIR_BINS;
    if (d < -DIR_BINS / 2) d += DIR_BINS;
    if (Math.abs(d) <= 12) {
      near += P.dirHist[i];
      const ang = ((best + d + 0.5) / 2) * (Math.PI / 180);
      sx += P.dirHist[i] * Math.cos(ang);
      sy += P.dirHist[i] * Math.sin(ang);
    }
  }
  let phi = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (phi < 0) phi += 180;
  return { phi, share: all ? near / all : 0 };
}

/** 두 벽의 중간 위치(벽 법선 방향 좌표). 양쪽 벽을 못 찾으면 null */
function wallMid(lat: number[]): number | null {
  const pos = lat.filter((v) => v > 0), neg = lat.filter((v) => v < 0).map((v) => -v);
  const a = histPeak(pos, 20), b = histPeak(neg, 20);
  return a !== null && b !== null ? (a - b) / 2 : null;
}

/**
 * 복도처럼 벽이 한 방향으로만 늘어선 쌍: b를 돌려 축을 맞춘 뒤 길 방향으로 0.25 m씩 밀면서
 * 가시성 점수(겹침 - 위반)를 잰다. 벽이 어디서나 같아도 끝벽·문·구조물이 엉뚱한 자리에 오면 "뚫고 본 공간"에
 * 놓여 위반이 크게 나오므로 맞는 위치에서만 점수가 높다.
 */
function corridorCandidates(A: Prepared, B: Prepared, dy: number, A0: Prepared, B0: Prepared, log?: (t: string) => void): Candidate[] {
  const ia = axisInfo(A), ib = axisInfo(B);
  if (ia.share < 0.5 || ib.share < 0.5) return [];
  const rad = Math.PI / 180;
  const nA = [Math.cos(ia.phi * rad), Math.sin(ia.phi * rad)];
  const aA = [-nA[1], nA[0]];
  const latA: number[] = [];
  for (let i = 0; i < A.wall.length; i += 2) latA.push(A.wall[i] * nA[0] + A.wall[i + 1] * nA[1]);
  const midA = wallMid(latA);
  const T = Math.min(100, (A.radius + B.radius) / 1000);
  const step = 0.25;
  const out: Candidate[] = [];
  for (const flip of [0, 180]) {
    const theta = (((ib.phi - ia.phi + flip) % 360) + 360) % 360;
    const c = Math.cos(theta * rad), sn = Math.sin(theta * rad);
    const latB: number[] = [];
    for (let i = 0; i < B.wall.length; i += 2) {
      const x = c * B.wall[i] + sn * B.wall[i + 1], z = -sn * B.wall[i] + c * B.wall[i + 1];
      latB.push(x * nA[0] + z * nA[1]);
    }
    const midB = wallMid(latB);
    const delta = midA !== null && midB !== null ? midA - midB : 0;
    const steps = Math.floor((2 * T) / step) + 1;
    const score = new Float64Array(steps);
    for (let k = 0; k < steps; k++) {
      const t = (-T + k * step) * 1000;
      score[k] = scorePair(A0, B0, yawMatrix(theta, t * aA[0] + delta * nA[0], dy, t * aA[1] + delta * nA[1]), LOOSE).score;
    }
    const idx = Array.from(score.keys()).sort((i, j) => score[j] - score[i]);
    const taken: number[] = [];
    for (const k of idx) {
      if (taken.length >= 6) break;
      if (taken.some((q) => Math.abs(q - k) * step < 1.5)) continue;
      taken.push(k);
      const t = (-T + k * step) * 1000;
      out.push({ yaw: theta, tx: t * aA[0] + delta * nA[0], tz: t * aA[1] + delta * nA[1], value: score[k] });
    }
    if (log) log(`   복도 훑기 (회전 ${theta.toFixed(1)}도, 옆 보정 ${delta.toFixed(0)}mm, 범위 ±${T.toFixed(0)}m): 상위 ${taken.slice(0, 4).map((k) => `${(-T + k * step).toFixed(2)}m=${score[k].toFixed(2)}`).join('  ')}`);
  }
  out.sort((x, y) => y.value - x.value);
  return out.slice(0, 8);
}

function registerPair(A: Prepared, B: Prepared, ia: number, ib: number, opts: RegisterOptions): PairResult {
  const yaws = yawCandidates(A, B);
  const cands = coarseCandidates(A, B, opts.cell ?? 200, yaws);
  const dy = A.floorY !== null && B.floorY !== null ? A.floorY - B.floorY : A.ceilY !== null && B.ceilY !== null ? A.ceilY - B.ceilY : 0;
  // 거친 채점으로 추린다: 먼저 적은 표본으로 전부 훑고, 상위 400개를 전체 표본으로 다시 채점한다.
  const lite = (P: Prepared): Prepared => {
    const count = P.q.length / 3, step = Math.max(1, Math.floor(count / 4000));
    const o = new Float32Array(Math.ceil(count / step) * 3), on = new Float32Array(o.length);
    let k = 0;
    for (let i = 0; i < count; i += step) {
      for (let c = 0; c < 3; c++) { o[k] = P.q[i * 3 + c]; on[k] = P.qn[i * 3 + c]; k++; }
    }
    return { ...P, q: o.subarray(0, k), qn: on.subarray(0, k) };
  };
  const A0 = lite(A), B0 = lite(B);
  const first = cands.map((c) => ({ c, pre: scorePair(A0, B0, yawMatrix(c.yaw, c.tx, dy, c.tz), LOOSE).score }));
  first.sort((p, q) => q.pre - p.pre);
  const second = first.slice(0, 400).map(({ c }) => {
    const m = yawMatrix(c.yaw, c.tx, dy, c.tz);
    return { c, m, pre: scorePair(A, B, m, LOOSE).score };
  });
  second.sort((p, q) => q.pre - p.pre);
  // 서로 가까운 후보는 하나만 남긴다
  const scored: { m: Mat4 }[] = [];
  const keptC: Candidate[] = [];
  for (const s of second) {
    if (scored.length >= (opts.candidates ?? 12)) break;
    if (keptC.some((k) => Math.abs(k.yaw - s.c.yaw) < 1 && Math.hypot(k.tx - s.c.tx, k.tz - s.c.tz) < 1000)) continue;
    keptC.push(s.c);
    scored.push({ m: s.m });
  }
  // 복도라면 길 방향 전수 훑기로 얻은 후보도 함께 다듬어 본다
  for (const c of corridorCandidates(A, B, dy, A0, B0, opts.log)) scored.push({ m: yawMatrix(c.yaw, c.tx, dy, c.tz) });
  const target = makeIcpTarget(A.p, A.n);
  let best: PairResult | null = null;
  for (const c of scored) {
    const r = refine(B.p, target, c.m, [800, 250], 6000);
    const s = scorePair(A, B, r.matrix, TIGHT);
    if (!best || s.score > best.score) best = { a: ia, b: ib, matrix: r.matrix, score: s.score, agree: s.agree, violate: s.violate, rms: r.last.rms };
  }
  if (!best) return { a: ia, b: ib, matrix: IDENTITY.slice(), score: -1, agree: 0, violate: 1, rms: Infinity };
  const fine = refine(B.p, target, best.matrix, [120, 50], 20000);
  const s = scorePair(A, B, fine.matrix, TIGHT);
  return { ...best, matrix: fine.matrix, rms: fine.last.rms, score: s.score, agree: s.agree, violate: s.violate };
}

export interface RegisterResult {
  /** 각 스캔을 첫 스캔 좌표로 옮기는 행렬. 이어 붙이지 못한 스캔은 null */
  matrices: (Mat4 | null)[];
  pairs: PairResult[];
  /** 이어 붙일 때 쓴 쌍 (부모 → 자식) */
  links: { parent: number; child: number; score: number }[];
  /** 마지막 다듬기 뒤, 각 스캔과 나머지 사이의 오차(mm) */
  finalRms: (number | null)[];
}

/** 쌍 점수가 이 값보다 낮으면 이어 붙이지 않는다 */
export const MIN_PAIR_SCORE = -1.2;

export function registerScans(scans: RegScan[], opts: RegisterOptions = {}): RegisterResult {
  const log = opts.log ?? (() => {});
  const P = scans.map(prepare);
  const n = scans.length;
  const pairs: PairResult[] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const t0 = Date.now();
    const r = registerPair(P[a], P[b], a, b, opts);
    pairs.push(r);
    log(`쌍 ${a + 1}-${b + 1}: 점수 ${r.score.toFixed(3)} (겹침 ${(r.agree * 100).toFixed(1)}%, 위반 ${(r.violate * 100).toFixed(2)}%, 오차 ${r.rms.toFixed(1)}mm, 거리 ${(Math.hypot(r.matrix[12], r.matrix[14]) / 1000).toFixed(2)}m, ${((Date.now() - t0) / 1000).toFixed(1)}초)`);
  }
  // 점수 높은 쌍부터 이어 붙인다 (첫 스캔에서 시작하는 최대 신장 트리)
  const matrices: (Mat4 | null)[] = new Array(n).fill(null);
  matrices[0] = IDENTITY.slice();
  const links: RegisterResult['links'] = [];
  for (;;) {
    let pick: PairResult | null = null;
    for (const pr of pairs) {
      const ina = matrices[pr.a] !== null, inb = matrices[pr.b] !== null;
      if (ina === inb || pr.score < MIN_PAIR_SCORE) continue;
      if (!pick || pr.score > pick.score) pick = pr;
    }
    if (!pick) break;
    if (matrices[pick.a]) {
      matrices[pick.b] = mat4Multiply(matrices[pick.a]!, pick.matrix);
      links.push({ parent: pick.a, child: pick.b, score: pick.score });
    } else {
      matrices[pick.a] = mat4Multiply(matrices[pick.b]!, mat4Invert(pick.matrix));
      links.push({ parent: pick.b, child: pick.a, score: pick.score });
    }
  }
  // 전체 다듬기: 스캔 하나를 나머지 전부에 다시 맞춘다 (2바퀴)
  const finalRms: (number | null)[] = new Array(n).fill(null);
  const placed = matrices.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
  if (placed.length > 1) {
    for (let round = 0; round < 2; round++) {
      for (const s of placed) {
        if (s === 0) continue;
        const others = placed.filter((o) => o !== s);
        let total = 0;
        for (const o of others) total += P[o].p.length;
        const tp = new Float32Array(total), tn = new Float32Array(total);
        let off = 0;
        for (const o of others) {
          tp.set(transformPoints(P[o].p, matrices[o]!), off);
          tn.set(transformNormals(P[o].n, matrices[o]!), off);
          off += P[o].p.length;
        }
        const target = makeIcpTarget(tp, tn);
        const r = refine(P[s].p, target, matrices[s]!, round === 0 ? [100, 40] : [40], 20000);
        matrices[s] = r.matrix;
        finalRms[s] = r.last.rms;
      }
    }
    log(`전체 다듬기 뒤 오차(mm): ${placed.map((s) => `${s + 1}:${finalRms[s] === null ? '기준' : finalRms[s]!.toFixed(1)}`).join('  ')}`);
  }
  return { matrices, pairs, links, finalRms };
}
