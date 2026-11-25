// Artec Ray II 스캔의 컬러 파노라마(큐브맵, 면마다 2048x2048 HDR)를 읽어 방향별 색을 돌려준다.
// 형식은 사용자 스캔 파일을 분석해 알아낸 것이다:
//  - 파일은 면 6개의 나열. 면 머리말은 16 05 00 00 00 00 + 이름 4글자("PosX".."NegZ").
//  - 면 데이터는 "길이를 2진수로 풀어, 켜진 자리마다 [지수 1바이트][2^지수 바이트]"를 큰 자리부터 이어 쓴 것.
//  - 조각을 이으면 OpenEXR(반정밀 B·G·R, DWAB 압축) 한 장이 나온다.
//  - 면의 가로·세로 방향 규약은 같은 스캔의 레이저 밝기 영상과 상관을 구해 정했다(상관 0.94~0.98).
import * as THREE from 'three';
import { EXRLoader } from '../vendor/EXRLoader.js';

export type CubeFaceName = 'PosX' | 'NegX' | 'PosY' | 'NegY' | 'PosZ' | 'NegZ';

export interface CubeFace {
  width: number;
  height: number;
  /** 선형 RGB(A), 행 우선 */
  data: Float32Array;
  channels: number;
}

export interface CubeColor {
  faces: Partial<Record<CubeFaceName, CubeFace>>;
  /** 색 보정 행렬(행 우선 3x3). 없으면 단위 행렬 */
  matrix: number[];
  /** sRGB로 바꾸기 전에 곱하는 노출 배율 */
  exposure: number;
  /** EXR 디코더가 아래 줄부터 채우는지 여부 */
  flipV: boolean;
}

/** 조각으로 나뉜 데이터를 잇는다. 지수 바이트가 앞의 것보다 작지 않으면 끝이다. */
export function readPieces(buf: Uint8Array, start: number): { data: Uint8Array; end: number } {
  const parts: Uint8Array[] = [];
  let pos = start;
  let prev = 32;
  let total = 0;
  while (pos < buf.length) {
    const k = buf[pos];
    if (k >= prev) break;
    const len = 2 ** k;
    if (pos + 1 + len > buf.length) break;
    parts.push(buf.subarray(pos + 1, pos + 1 + len));
    total += len;
    pos += 1 + len;
    prev = k;
  }
  const data = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    data.set(p, o);
    o += p.length;
  }
  return { data, end: pos };
}

const FACE_NAMES: CubeFaceName[] = ['PosX', 'NegX', 'PosY', 'NegY', 'PosZ', 'NegZ'];

/** 큐브맵 파일에서 면 이름과 이어 붙인 데이터를 꺼낸다. */
export function readCubeFaces(buf: Uint8Array): { name: CubeFaceName; data: Uint8Array }[] {
  const out: { name: CubeFaceName; data: Uint8Array }[] = [];
  let pos = 0;
  while (pos + 11 < buf.length && out.length < 6) {
    if (buf[pos] === 0x15) pos++; // 앞 면의 끝 표시
    if (!(buf[pos] === 0x16 && buf[pos + 1] === 0x05)) break;
    const name = String.fromCharCode(buf[pos + 6], buf[pos + 7], buf[pos + 8], buf[pos + 9]) as CubeFaceName;
    if (!FACE_NAMES.includes(name)) break;
    const r = readPieces(buf, pos + 10);
    out.push({ name, data: r.data });
    pos = r.end;
  }
  return out;
}

/** 컬러 큐브맵 파일(EXR 면 6개)을 푼다. */
export function decodeCubeColor(file: ArrayBuffer, matrix: number[] | null): CubeColor {
  const faces: CubeColor['faces'] = {};
  const loader = new EXRLoader().setDataType(THREE.FloatType);
  for (const f of readCubeFaces(new Uint8Array(file))) {
    if (f.data.length < 64 || f.data[0] !== 0x76 || f.data[1] !== 0x2f) continue;
    const ab = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer;
    const r = loader.parse(ab) as { width: number; height: number; data: Float32Array };
    faces[f.name] = { width: r.width, height: r.height, data: r.data, channels: r.data.length / (r.width * r.height) };
  }
  if (!Object.keys(faces).length) throw new Error('컬러 파노라마를 읽지 못했습니다.');
  const c: CubeColor = { faces, matrix: matrix && matrix.length === 9 ? matrix : [1, 0, 0, 0, 1, 0, 0, 0, 1], exposure: 1, flipV: true };
  c.exposure = autoExposure(c);
  return c;
}

/** 밝은 쪽 2%가 흰색 근처에 오도록 노출 배율을 정한다. */
export function autoExposure(c: CubeColor): number {
  const lum: number[] = [];
  for (const f of Object.values(c.faces)) {
    if (!f) continue;
    const n = f.width * f.height;
    for (let i = 0; i < n; i += 211) {
      const o = i * f.channels;
      const l = 0.2126 * f.data[o] + 0.7152 * f.data[o + 1] + 0.0722 * f.data[o + 2];
      if (l > 0 && Number.isFinite(l)) lum.push(l);
    }
  }
  if (lum.length < 100) return 1;
  lum.sort((a, b) => a - b);
  const p98 = lum[Math.floor(lum.length * 0.98)];
  return p98 > 0 ? 0.85 / p98 : 1;
}

const toSrgb = (v: number) => {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
};

/**
 * 스캐너 좌표(Z가 위)의 방향 (x, y, z)에서 본 색을 sRGB 0..1로 out[o..o+2]에 쓴다.
 * 그 방향에 색이 없으면 false.
 */
export function sampleCube(c: CubeColor, x: number, y: number, z: number, out: Float32Array, o: number): boolean {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let name: CubeFaceName, u: number, v: number;
  if (ax >= ay && ax >= az) {
    if (x > 0) { name = 'PosX'; u = -y / ax; v = -z / ax; } else { name = 'NegX'; u = y / ax; v = -z / ax; }
  } else if (ay >= az) {
    if (y > 0) { name = 'PosY'; u = x / ay; v = -z / ay; } else { name = 'NegY'; u = -x / ay; v = -z / ay; }
  } else if (z > 0) { name = 'PosZ'; u = x / az; v = y / az; } else { name = 'NegZ'; u = x / az; v = -y / az; }
  const f = c.faces[name];
  if (!f) return false;
  let px = Math.floor(((u + 1) / 2) * f.width);
  let py = Math.floor(((v + 1) / 2) * f.height);
  if (px < 0) px = 0; else if (px >= f.width) px = f.width - 1;
  if (py < 0) py = 0; else if (py >= f.height) py = f.height - 1;
  if (c.flipV) py = f.height - 1 - py;
  const k = (py * f.width + px) * f.channels;
  const r = f.data[k], g = f.data[k + 1], b = f.data[k + 2];
  if (!(r > 0 || g > 0 || b > 0)) return false;
  const m = c.matrix, e = c.exposure;
  out[o] = toSrgb((m[0] * r + m[1] * g + m[2] * b) * e);
  out[o + 1] = toSrgb((m[3] * r + m[4] * g + m[5] * b) * e);
  out[o + 2] = toSrgb((m[6] * r + m[7] * g + m[8] * b) * e);
  return true;
}
