// 시험·시연용 절차적 샘플 데이터 (외부 파일 없이 기능을 확인할 수 있게 한다).
import { Mat4, MeshData, bakeMatrix, computeNormals, deleteElements, mat4FromRT } from './mesh';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 비대칭 굴곡이 있는 닫힌 모델 (지름 약 100 단위). */
export function makeSampleModel(nLat = 110, nLon = 220): MeshData {
  const nv = (nLat - 1) * nLon + 2;
  const positions = new Float32Array(nv * 3);
  const colors = new Float32Array(nv * 3);
  const put = (i: number, lat: number, lon: number) => {
    const sy = Math.cos(lat), sr = Math.sin(lat);
    const dx = sr * Math.cos(lon), dy = sy, dz = sr * Math.sin(lon);
    const bump = Math.exp(-((dx - 0.6) ** 2 + (dy - 0.5) ** 2 + (dz - 0.62) ** 2) / 0.08);
    const dent = Math.exp(-((dx + 0.7) ** 2 + (dy + 0.1) ** 2 + (dz - 0.7) ** 2) / 0.05);
    const r = 42 + 5 * Math.sin(3 * lon) * sr * sr + 3.5 * Math.cos(5 * lat) + 2 * Math.sin(7 * lon + 2 * lat) * sr + 12 * bump - 7 * dent;
    positions[i * 3] = dx * r;
    positions[i * 3 + 1] = dy * r * 1.25;
    positions[i * 3 + 2] = dz * r * 0.9;
    const stripe = 0.5 + 0.5 * Math.sin(lon * 6 + Math.sin(lat * 4) * 1.5);
    colors[i * 3] = 0.78 - 0.25 * stripe + 0.2 * bump;
    colors[i * 3 + 1] = 0.62 - 0.12 * stripe + 0.1 * Math.cos(lat * 3);
    colors[i * 3 + 2] = 0.5 + 0.3 * stripe - 0.2 * dent;
  };
  put(0, 0, 0);
  for (let a = 1; a < nLat; a++)
    for (let o = 0; o < nLon; o++) put(1 + (a - 1) * nLon + o, (a / nLat) * Math.PI, (o / nLon) * Math.PI * 2);
  put(nv - 1, Math.PI, 0);
  const idx: number[] = [];
  const at = (a: number, o: number) => 1 + (a - 1) * nLon + (o % nLon);
  for (let o = 0; o < nLon; o++) {
    idx.push(0, at(1, o + 1), at(1, o));
    idx.push(nv - 1, at(nLat - 1, o), at(nLat - 1, o + 1));
  }
  for (let a = 1; a < nLat - 1; a++)
    for (let o = 0; o < nLon; o++) {
      idx.push(at(a, o), at(a, o + 1), at(a + 1, o));
      idx.push(at(a, o + 1), at(a + 1, o + 1), at(a + 1, o));
    }
  const indices = Uint32Array.from(idx);
  return { positions, indices, normals: computeNormals(positions, indices), colors, uvs: null };
}

function rotation(axis: number[], deg: number): number[] {
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  const [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l];
  const th = (deg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

export interface SampleScan {
  name: string;
  mesh: MeshData;
  /** 이 스캔에 적용한 어긋남(검증용 정답) */
  offset: Mat4;
}

/** 서로 겹치는 부분 스캔 3장. 2·3번은 일부러 어긋나 있고, 1번에는 구멍과 떠 있는 조각이 있다. */
export function makeSampleScans(): SampleScan[] {
  const model = makeSampleModel();
  const P = model.positions, idx = model.indices!;
  const tc = idx.length / 3;
  const rand = rng(20261113);
  const views = [0, 120, 240].map((d) => [Math.cos((d * Math.PI) / 180), 0.15, Math.sin((d * Math.PI) / 180)]);
  const offsets: Mat4[] = [
    mat4FromRT([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]),
    mat4FromRT(rotation([0.3, 1, 0.2], 9), [7, 4, -5]),
    mat4FromRT(rotation([1, 0.2, -0.4], -11), [-6, 5, 8]),
  ];
  const holes = [[0.95, 0.3, 0.1], [0.8, -0.4, 0.45], [0.7, 0.1, -0.7]];
  return views.map((v, si) => {
    const remove = new Uint8Array(tc);
    for (let f = 0; f < tc; f++) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) {
        cx += P[idx[f * 3 + k] * 3];
        cy += P[idx[f * 3 + k] * 3 + 1];
        cz += P[idx[f * 3 + k] * 3 + 2];
      }
      const l = Math.hypot(cx, cy, cz) || 1;
      const dx = cx / l, dy = cy / l, dz = cz / l;
      const vl = Math.hypot(v[0], v[1], v[2]);
      if ((dx * v[0] + dy * v[1] + dz * v[2]) / vl < -0.22) remove[f] = 1;
      if (si === 0)
        for (const h of holes) {
          const hl = Math.hypot(h[0], h[1], h[2]);
          if (dx * h[0] / hl + dy * h[1] / hl + dz * h[2] / hl > 0.992) remove[f] = 1;
        }
    }
    let mesh = deleteElements(model, remove);
    // 측정 잡음
    const pos = mesh.positions.slice();
    for (let i = 0; i < pos.length; i++) pos[i] += (rand() - 0.5) * 0.06;
    mesh = { ...mesh, positions: pos };
    if (si === 0) {
      // 떠 있는 작은 조각 추가
      const fp: number[] = Array.from(mesh.positions), fc: number[] = Array.from(mesh.colors!), fi: number[] = Array.from(mesh.indices!);
      for (let b = 0; b < 4; b++) {
        const c = [70 + rand() * 10, -30 + rand() * 60, -20 + rand() * 40];
        const base = fp.length / 3;
        for (let k = 0; k < 4; k++) {
          fp.push(c[0] + (rand() - 0.5) * 4, c[1] + (rand() - 0.5) * 4, c[2] + (rand() - 0.5) * 4);
          fc.push(0.6, 0.6, 0.6);
        }
        fi.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 3, base + 1, base + 1, base + 3, base + 2);
      }
      mesh = { positions: Float32Array.from(fp), colors: Float32Array.from(fc), indices: Uint32Array.from(fi), normals: null, uvs: null };
    }
    mesh = bakeMatrix(mesh, offsets[si]);
    mesh = { ...mesh, normals: computeNormals(mesh.positions, mesh.indices!) };
    return { name: `샘플 스캔 ${si + 1}`, mesh, offset: offsets[si] };
  });
}
