// Artec Ray II(라이카 RTC360 기반) 원본 스캔을 포인트 클라우드로 바꾼다.
// 도우미(electron/raydecode.*)가 줄여서 풀어 준 거리·밝기 표를 받아 각도 모델로 좌표를 계산한다.
//
// 각도·거리 해석은 사용자 스캔 파일을 직접 분석해 얻은 것이다(Artec 프로그램 코드를 참고하지 않음).
//  - 한 줄 = 거울 한 바퀴 중 수직 창(보통 300도, 천정 중심) 구간. 표본은 등각 간격.
//  - 줄 번호가 늘수록 본체가 수평으로 돈다(보통 183도 → 앞·뒤 양쪽으로 360도를 덮음).
//  - 거리(m) = (원시값 / 2^30 + 0.5) × 149.85. 원시값을 "왕복 시간(마이크로초) - 0.5"의 고정소수점으로 본 해석이다.
//    같은 촬영의 납품 모델(복도·수술실)과 바닥~천장 높이를 대조해 약 0.5% 안에서 맞는 것을 확인했다.
//  - 장비 내부 보정값(거울 편심 등)과 표본별 각도 보정은 반영하지 않는다(근사).
import type { MeshData } from '../geometry/mesh';
import { CubeColor, sampleCube } from './rayColor';

export interface RayScanMeta {
  dir: string;
  folder: string;
  name: string;
  device: string;
  created: string;
  resolution: string;
  /** 수평 줄 수(전체 해상도) */
  lines: number;
  /** 한 줄의 표본 수(전체 해상도) */
  samples: number;
  azCenterDeg: number;
  elCenterDeg: number;
  hSizeDeg: number;
  vSizeDeg: number;
  clockwise: boolean;
  /** 기울기 센서 행렬(행 우선 3x3) */
  tilt: number[] | null;
  /** 컬러 파노라마가 있는지 */
  hasColor?: boolean;
  /** 색 보정 행렬(행 우선 3x3) */
  colorMatrix?: number[] | null;
  sliceCount: number;
}

export interface RayProject {
  name: string;
  folder: string;
  scans: RayScanMeta[];
}

export interface RayOpenResult {
  root: string;
  projects: RayProject[];
}

export interface RayCloudOptions {
  /** 이보다 가까운 점은 버린다 (m). 0에 가까운 값은 반사가 없었던 표본이다. */
  minRange?: number;
  /** 이보다 먼 점은 버린다 (m) */
  maxRange?: number;
  /** 기울기 센서 값으로 수평을 맞춘다 */
  level?: boolean;
  /** false면 기울기 행렬을 전치해서 곱한다 (방향 점검용). 기본은 그대로 곱함 */
  tiltDirect?: boolean;
  /** 밝기를 보기 좋게 끌어올리는 감마 (1이면 그대로) */
  gamma?: number;
  /** 격자 이웃으로 법선을 계산한다(스캐너 쪽을 향함). 이웃이 없는 가장자리 점은 버린다. */
  normals?: boolean;
  /** 컬러 파노라마. 주면 레이저 밝기 대신 이 색을 쓴다(색이 없는 방향만 밝기로 채움). */
  color?: CubeColor | null;
  /** 법선을 계산할 때, 표면을 스친 각도의 코사인이 이보다 작으면 버린다 (기본 0.1 ≈ 84도) */
  minIncidenceCos?: number;
}

/** 빛이 공기 중에서 1마이크로초 동안 왕복으로 재는 거리 (m). 진공 광속 / 2 / 표준 대기 굴절률 1.00028 */
const HALF_C_PER_US = 299.792458 / 2 / 1.00028;
/** 원시값 1당 거리 (m). 원시값은 왕복 시간(마이크로초)에서 0.5를 뺀 값을 2^30배 한 정수로 해석한다. */
export const RAY_RANGE_SCALE = HALF_C_PER_US / 1073741824;
export const RAY_RANGE_OFFSET_M = HALF_C_PER_US * 0.5;
const RAY_MAGIC = 0x31594152;
const DEG = Math.PI / 180;

export interface RayBinHeader {
  sampleStep: number;
  lineStep: number;
  samplesPerLine: number;
  keptLines: number;
  fullWidth: number;
  totalLines: number;
}

export function readRayBinHeader(buf: ArrayBuffer): RayBinHeader {
  if (buf.byteLength < 28) throw new Error('스캔 변환 결과가 비어 있습니다.');
  const dv = new DataView(buf);
  if (dv.getInt32(0, true) !== RAY_MAGIC) throw new Error('스캔 변환 결과 형식이 다릅니다.');
  const h: RayBinHeader = {
    sampleStep: dv.getInt32(4, true),
    lineStep: dv.getInt32(8, true),
    samplesPerLine: dv.getInt32(12, true),
    keptLines: dv.getInt32(16, true),
    fullWidth: dv.getInt32(20, true),
    totalLines: dv.getInt32(24, true),
  };
  const rec = 4 + h.samplesPerLine * 5;
  if (h.samplesPerLine <= 0 || h.keptLines < 0 || buf.byteLength < 28 + rec * h.keptLines) throw new Error('스캔 변환 결과가 잘렸습니다.');
  return h;
}

/** 스캔 한 개를 mm 단위, Y축이 위인 포인트 클라우드로 바꾼다. 원점은 스캐너 중심이다. */
export function rayBinToCloud(buf: ArrayBuffer, meta: RayScanMeta, opts: RayCloudOptions = {}): { data: MeshData; total: number; kept: number } {
  const h = readRayBinHeader(buf);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const minR = opts.minRange ?? 0.3;
  const maxR = opts.maxRange ?? 200;
  const gamma = opts.gamma ?? 0.55;
  const n = h.samplesPerLine;
  const rec = 4 + n * 5;
  const lines = meta.lines > 0 ? meta.lines : h.totalLines;
  const width = h.fullWidth;
  const hSize = (Number.isFinite(meta.hSizeDeg) ? meta.hSizeDeg : 183) * DEG;
  const vSize = (Number.isFinite(meta.vSizeDeg) ? meta.vSizeDeg : 300) * DEG;
  // 방위 기준은 스캐너의 큐브맵 좌표에 맞춘다: 첫 줄의 방위 = -(창 중심 방위 + 창 절반 + 90도).
  // 큐브맵의 레이저 밝기 영상과 스캔 격자를 맞춰 구한 값이다(스캔 3개에서 0.1도 안으로 일치).
  const az0 = -((Number.isFinite(meta.azCenterDeg) ? meta.azCenterDeg : 0) * DEG + hSize / 2 + Math.PI / 2) * (meta.clockwise ? -1 : 1);
  const dAz = (hSize / lines) * (meta.clockwise ? -1 : 1);
  const dEl = vSize / width;
  // 천정에서 잰 각도. 창 중심(고도 90도 = 천정)을 기준으로 좌우 대칭이다.
  const th0 = (90 - (Number.isFinite(meta.elCenterDeg) ? meta.elCenterDeg : 90)) * DEG - vSize / 2;
  const sinT = new Float64Array(n);
  const cosT = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const th = th0 + (j * h.sampleStep + 0.5) * dEl;
    sinT[j] = Math.sin(th);
    cosT[j] = Math.cos(th);
  }
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, gamma);
  const T0 = opts.level !== false && meta.tilt && meta.tilt.length === 9 ? meta.tilt : null;
  // 기울기 행렬을 그대로 곱해야 바닥이 수평이 된다(복도 스캔: 보정 전 1.12도 → 0.33도, 전치하면 2.48도).
  // 아래 식이 전치를 곱하는 꼴이라, 전치를 미리 넣어 원래 행렬이 곱해지게 한다.
  const T = T0 && opts.tiltDirect !== false ? [T0[0], T0[3], T0[6], T0[1], T0[4], T0[7], T0[2], T0[5], T0[8]] : T0;

  const total = h.keptLines * n;
  const wantNormals = !!opts.normals;
  // 1) 격자 전체의 좌표(스캐너 좌표, m)와 유효 여부
  const G = new Float32Array(total * 3);
  const RR = new Float32Array(total);
  for (let li = 0; li < h.keptLines; li++) {
    const o = 28 + li * rec;
    const a = az0 + dv.getInt32(o, true) * dAz;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const ro = o + 4;
    for (let j = 0; j < n; j++) {
      const r = dv.getInt32(ro + j * 4, true) * RAY_RANGE_SCALE + RAY_RANGE_OFFSET_M;
      const g = li * n + j;
      if (!(r >= minR && r <= maxR)) {
        RR[g] = 0;
        continue;
      }
      RR[g] = r;
      G[g * 3] = r * sinT[j] * ca;
      G[g * 3 + 1] = r * sinT[j] * sa;
      G[g * 3 + 2] = r * cosT[j];
    }
  }
  // 2) 점 내보내기. 법선은 격자 이웃의 차이로 구하고 스캐너 쪽을 보게 한다.
  let pos = new Float32Array(total * 3);
  let col = new Float32Array(total * 3);
  let nor = wantNormals ? new Float32Array(total * 3) : null;
  // 이웃과의 거리 차 허용치: 표면이 약 83도까지 비스듬해도 이웃으로 인정한다.
  const dTh = Math.max(dEl * h.sampleStep, Math.abs(dAz) * h.lineStep);
  const minCos = opts.minIncidenceCos ?? 0.1;
  const cube = opts.color ?? null;
  let k = 0;
  for (let li = 0; li < h.keptLines; li++) {
    const io = 28 + li * rec + 4 + n * 4;
    for (let j = 0; j < n; j++) {
      const g = li * n + j;
      const r = RR[g];
      if (r === 0) continue;
      let x = G[g * 3];
      let y = G[g * 3 + 1];
      let z = G[g * 3 + 2];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      if (nor) {
        const thr = 0.02 + r * dTh * 8;
        const ok = (q: number) => RR[q] !== 0 && Math.abs(RR[q] - r) < thr;
        const up = j > 0 && ok(g - 1) ? g - 1 : -1;
        const dn = j < n - 1 && ok(g + 1) ? g + 1 : -1;
        const lf = li > 0 && ok(g - n) ? g - n : -1;
        const rt = li < h.keptLines - 1 && ok(g + n) ? g + n : -1;
        const e0 = dn >= 0 ? dn : g;
        const e1 = up >= 0 ? up : g;
        const a0 = rt >= 0 ? rt : g;
        const a1 = lf >= 0 ? lf : g;
        if (e0 === e1 || a0 === a1) continue; // 이웃이 없는 가장자리·튀는 점은 버린다
        const ux = G[e0 * 3] - G[e1 * 3], uy = G[e0 * 3 + 1] - G[e1 * 3 + 1], uz = G[e0 * 3 + 2] - G[e1 * 3 + 2];
        const vx = G[a0 * 3] - G[a1 * 3], vy = G[a0 * 3 + 1] - G[a1 * 3 + 1], vz = G[a0 * 3 + 2] - G[a1 * 3 + 2];
        nx = uy * vz - uz * vy;
        ny = uz * vx - ux * vz;
        nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (!(len > 1e-12)) continue;
        nx /= len;
        ny /= len;
        nz /= len;
        const d = (nx * x + ny * y + nz * z) / r;
        if (Math.abs(d) < minCos) continue; // 너무 비스듬히 스친 점
        if (d > 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
      }
      if (T) {
        const X = T[0] * x + T[3] * y + T[6] * z;
        const Y = T[1] * x + T[4] * y + T[7] * z;
        const Z = T[2] * x + T[5] * y + T[8] * z;
        x = X;
        y = Y;
        z = Z;
        if (nor) {
          const NX = T[0] * nx + T[3] * ny + T[6] * nz;
          const NY = T[1] * nx + T[4] * ny + T[7] * nz;
          const NZ = T[2] * nx + T[5] * ny + T[8] * nz;
          nx = NX;
          ny = NY;
          nz = NZ;
        }
      }
      // 스캐너 좌표(Z 위) → 화면 좌표(Y 위), m → mm
      pos[k] = x * 1000;
      pos[k + 1] = z * 1000;
      pos[k + 2] = -y * 1000;
      if (nor) {
        nor[k] = nx;
        nor[k + 1] = nz;
        nor[k + 2] = -ny;
      }
      // 색은 수평 보정 전의 스캐너 좌표 방향으로 찾는다
      if (!cube || !sampleCube(cube, G[g * 3], G[g * 3 + 1], G[g * 3 + 2], col, k)) {
        const c = lut[bytes[io + j]];
        col[k] = c;
        col[k + 1] = c;
        col[k + 2] = c;
      }
      k += 3;
    }
  }
  if (k < pos.length) {
    pos = pos.slice(0, k);
    col = col.slice(0, k);
    if (nor) nor = nor.slice(0, k);
  }
  return { data: { positions: pos, indices: null, normals: nor, colors: col, uvs: null }, total, kept: k / 3 };
}


/**
 * 바닥(스캐너보다 0.3 m 이상 아래, 8 m 안, 위를 보는 점)의 평균 법선이 +Y가 되도록 스캐너 원점 기준으로 조금 돌린다.
 * 기울기 센서로 맞춘 뒤에도 남는 0.2~0.3도의 기울기를 없앤다(30 m 거리에서 10 cm 넘는 차이). 점이 모자라면 건드리지 않는다.
 */
export function levelByFloor(m: MeshData): { tiltDeg: number; used: number } {
  const P = m.positions, N = m.normals;
  if (!N) return { tiltDeg: 0, used: 0 };
  let total = 0, used = 0;
  for (let iter = 0; iter < 3; iter++) {
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (let i = 0; i < N.length; i += 3) {
      if (N[i + 1] < 0.95 || P[i + 1] > -300 || Math.hypot(P[i], P[i + 2]) > 8000) continue;
      sx += N[i]; sy += N[i + 1]; sz += N[i + 2]; cnt++;
    }
    if (cnt < 2000) break;
    used = cnt;
    const len = Math.hypot(sx, sy, sz);
    const ax = sx / len, ay = sy / len, az = sz / len;
    // a를 (0,1,0)으로 보내는 회전: 축 v = a x (0,1,0) = (-az, 0, ax), 각 = acos(ay)
    const vx = -az, vy = 0, vz = ax;
    const s2 = vx * vx + vy * vy + vz * vz, s = Math.sqrt(s2), c = ay;
    if (s < 1e-7) break;
    total += Math.atan2(s, c);
    const k = (1 - c) / s2;
    const r = [
      1 + k * (vx * vx - s2), -vz + k * vx * vy, vy + k * vx * vz,
      vz + k * vx * vy, 1 + k * (vy * vy - s2), -vx + k * vy * vz,
      -vy + k * vx * vz, vx + k * vy * vz, 1 + k * (vz * vz - s2),
    ];
    for (const arr of [P, N]) {
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        arr[i] = r[0] * x + r[1] * y + r[2] * z;
        arr[i + 1] = r[3] * x + r[4] * y + r[5] * z;
        arr[i + 2] = r[6] * x + r[7] * y + r[8] * z;
      }
    }
  }
  return { tiltDeg: (total * 180) / Math.PI, used };
}

/** 촘촘함 단계별 건너뛰기 간격 */
export const RAY_DENSITY: { id: string; label: string; step: number }[] = [
  { id: 'fast', label: '빠름 (16칸마다 1점)', step: 16 },
  { id: 'normal', label: '보통 (8칸마다 1점)', step: 8 },
  { id: 'fine', label: '촘촘 (4칸마다 1점)', step: 4 },
];

export const rayPointEstimate = (scan: RayScanMeta, step: number) => Math.ceil(scan.lines / step) * Math.ceil(scan.samples / step);
