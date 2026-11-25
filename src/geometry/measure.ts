// 측정: 표면적, 부피, 경계 상자, 평면 단면.
import { Mat4, MeshData, bakeMatrix, bbox, positionRemap } from './mesh';
import { countBoundaryEdges } from './topology';

export interface MeshInfo {
  vertices: number;
  triangles: number;
  area: number;
  volume: number;
  closed: boolean;
  boundaryEdges: number;
  size: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
}

export function meshInfo(mesh: MeshData, matrix: Mat4): MeshInfo {
  const m = bakeMatrix(mesh, matrix);
  const P = m.positions;
  const b = bbox(P);
  let area = 0, vol = 0;
  if (m.indices) {
    const idx = m.indices;
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f] * 3, bb = idx[f + 1] * 3, c = idx[f + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2];
      const bx = P[bb], by = P[bb + 1], bz = P[bb + 2];
      const cx = P[c], cy = P[c + 1], cz = P[c + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
  }
  const boundaryEdges = m.indices ? countBoundaryEdges(m) : 0;
  return {
    vertices: P.length / 3,
    triangles: m.indices ? m.indices.length / 3 : 0,
    area,
    volume: Math.abs(vol),
    closed: !!m.indices && boundaryEdges === 0,
    boundaryEdges,
    size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
    min: b.min,
    max: b.max,
  };
}

export interface SectionResult {
  /** 선분 끝점 (x1,y1,z1,x2,y2,z2 반복, 월드 좌표) */
  segments: Float32Array;
  length: number;
  closedLoops: number;
  openChains: number;
  /** 닫힌 윤곽들의 면적 합 */
  area: number;
}

/** 평면 n·x = d 로 자른 단면 윤곽. */
export function section(mesh: MeshData, matrix: Mat4, normal: [number, number, number], d: number): SectionResult {
  const m = bakeMatrix(mesh, matrix);
  const empty: SectionResult = { segments: new Float32Array(0), length: 0, closedLoops: 0, openChains: 0, area: 0 };
  if (!m.indices) return empty;
  const P = m.positions, idx = m.indices;
  const { ids, count } = positionRemap(P);
  const nv = P.length / 3;
  const dist = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    let s = P[i * 3] * normal[0] + P[i * 3 + 1] * normal[1] + P[i * 3 + 2] * normal[2] - d;
    if (s === 0) s = 1e-12; // 정점이 평면 위에 정확히 놓이는 경우를 피한다.
    dist[i] = s;
  }
  const K = 67108864;
  const nodeOf = new Map<number, number>();
  const nodes: number[] = [];
  const getNode = (a: number, b: number) => {
    const ca = ids[a], cb = ids[b];
    const key = ca < cb ? ca * K + cb : cb * K + ca;
    let n = nodeOf.get(key);
    if (n === undefined) {
      const t = dist[a] / (dist[a] - dist[b]);
      n = nodes.length / 3;
      nodes.push(P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t);
      nodeOf.set(key, n);
    }
    return n;
  };
  void count;
  const segA: number[] = [], segB: number[] = [];
  for (let f = 0; f < idx.length; f += 3) {
    const v = [idx[f], idx[f + 1], idx[f + 2]];
    const s = [dist[v[0]] > 0, dist[v[1]] > 0, dist[v[2]] > 0];
    if (s[0] === s[1] && s[1] === s[2]) continue;
    const pts: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (s[k] !== s[(k + 1) % 3]) pts.push(getNode(a, b));
    }
    if (pts.length === 2 && pts[0] !== pts[1]) {
      segA.push(pts[0]);
      segB.push(pts[1]);
    }
  }
  const ns = segA.length;
  const segments = new Float32Array(ns * 6);
  let length = 0;
  for (let i = 0; i < ns; i++) {
    const a = segA[i] * 3, b = segB[i] * 3;
    segments.set([nodes[a], nodes[a + 1], nodes[a + 2], nodes[b], nodes[b + 1], nodes[b + 2]], i * 6);
    length += Math.hypot(nodes[a] - nodes[b], nodes[a + 1] - nodes[b + 1], nodes[a + 2] - nodes[b + 2]);
  }
  // 선분을 이어 윤곽 구성
  const adj = new Map<number, number[]>();
  for (let i = 0; i < ns; i++) {
    for (const n of [segA[i], segB[i]]) {
      const l = adj.get(n);
      if (l) l.push(i);
      else adj.set(n, [i]);
    }
  }
  // 평면 좌표축
  const nl = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const nn = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
  const ref = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [ref[1] * nn[2] - ref[2] * nn[1], ref[2] * nn[0] - ref[0] * nn[2], ref[0] * nn[1] - ref[1] * nn[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const w = [nn[1] * u[2] - nn[2] * u[1], nn[2] * u[0] - nn[0] * u[2], nn[0] * u[1] - nn[1] * u[0]];
  const used = new Uint8Array(ns);
  let closedLoops = 0, openChains = 0, area = 0;
  for (let s0 = 0; s0 < ns; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const chain = [segA[s0], segB[s0]];
    let closed = false;
    for (;;) {
      const tail = chain[chain.length - 1];
      const cand = adj.get(tail)!;
      let next = -1;
      for (const c of cand) if (!used[c]) { next = c; break; }
      if (next < 0) break;
      used[next] = 1;
      const other = segA[next] === tail ? segB[next] : segA[next];
      if (other === chain[0]) { closed = true; break; }
      chain.push(other);
    }
    if (closed) {
      closedLoops++;
      let a2 = 0;
      for (let i = 0; i < chain.length; i++) {
        const p = chain[i] * 3, q = chain[(i + 1) % chain.length] * 3;
        const x1 = nodes[p] * u[0] + nodes[p + 1] * u[1] + nodes[p + 2] * u[2];
        const y1 = nodes[p] * w[0] + nodes[p + 1] * w[1] + nodes[p + 2] * w[2];
        const x2 = nodes[q] * u[0] + nodes[q + 1] * u[1] + nodes[q + 2] * u[2];
        const y2 = nodes[q] * w[0] + nodes[q + 1] * w[1] + nodes[q + 2] * w[2];
        a2 += x1 * y2 - x2 * y1;
      }
      area += Math.abs(a2) / 2;
    } else openChains++;
  }
  return { segments, length, closedLoops, openChains, area };
}
