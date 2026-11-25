// 메시·포인트 클라우드 공용 데이터 구조와 기본 연산.
// three.js에 의존하지 않는 순수 TypeScript로 작성해 워커와 단위 시험에서 그대로 쓴다.

export interface MeshData {
  positions: Float32Array; // xyz 반복
  indices: Uint32Array | null; // null이면 포인트 클라우드
  normals: Float32Array | null; // 정점별 법선
  colors: Float32Array | null; // 정점별 RGB (0..1)
  uvs: Float32Array | null; // 정점별 UV
}

/** 열 우선(column-major) 4x4 행렬. THREE.Matrix4.elements와 같은 배치. */
export type Mat4 = number[];

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export const vertexCount = (m: MeshData) => m.positions.length / 3;
export const triangleCount = (m: MeshData) => (m.indices ? m.indices.length / 3 : 0);

export function isIdentity(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - IDENTITY[i]) > 1e-12) return false;
  return true;
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

/** 일반 4x4 역행렬 (가우스-조던). 특이 행렬이면 단위 행렬을 돌려준다. */
export function mat4Invert(m: Mat4): Mat4 {
  const a = new Float64Array(32);
  // 행 우선 확장 행렬 [M | I]
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) a[r * 8 + c] = m[c * 4 + r];
    a[r * 8 + 4 + r] = 1;
  }
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r * 8 + col]) > Math.abs(a[piv * 8 + col])) piv = r;
    if (Math.abs(a[piv * 8 + col]) < 1e-14) return IDENTITY.slice();
    if (piv !== col) for (let k = 0; k < 8; k++) [a[col * 8 + k], a[piv * 8 + k]] = [a[piv * 8 + k], a[col * 8 + k]];
    const d = a[col * 8 + col];
    for (let k = 0; k < 8; k++) a[col * 8 + k] /= d;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = a[r * 8 + col];
      if (f !== 0) for (let k = 0; k < 8; k++) a[r * 8 + k] -= f * a[col * 8 + k];
    }
  }
  const o = new Array<number>(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = a[r * 8 + 4 + c];
  return o;
}

/** 행 우선 3x3 회전 R과 이동 t로 4x4 행렬 생성. */
export function mat4FromRT(R: ArrayLike<number>, t: ArrayLike<number>): Mat4 {
  return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}

export function transformPoints(p: Float32Array, m: Mat4): Float32Array {
  const o = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    o[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    o[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    o[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return o;
}

/** 법선 변환(역전치 행렬 사용 후 정규화). */
export function transformNormals(n: Float32Array, m: Mat4): Float32Array {
  const inv = mat4Invert(m);
  // 역전치의 3x3: (inv)^T → 원소 (r,c) = inv(c,r)
  const o = new Float32Array(n.length);
  for (let i = 0; i < n.length; i += 3) {
    const x = n[i], y = n[i + 1], z = n[i + 2];
    const a = inv[0] * x + inv[1] * y + inv[2] * z;
    const b = inv[4] * x + inv[5] * y + inv[6] * z;
    const c = inv[8] * x + inv[9] * y + inv[10] * z;
    const l = Math.hypot(a, b, c) || 1;
    o[i] = a / l;
    o[i + 1] = b / l;
    o[i + 2] = c / l;
  }
  return o;
}

/** 면적 가중 정점 법선. */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

export function withNormals(m: MeshData): MeshData {
  if (!m.indices) return m;
  return { ...m, normals: computeNormals(m.positions, m.indices) };
}

/** 행렬을 정점에 구워 넣은 사본. */
export function bakeMatrix(m: MeshData, mat: Mat4): MeshData {
  if (isIdentity(mat)) return m;
  const positions = transformPoints(m.positions, mat);
  let normals = m.normals ? transformNormals(m.normals, mat) : null;
  let indices = m.indices;
  // 거울 변환(행렬식 음수)이면 면 방향을 뒤집는다.
  const det =
    mat[0] * (mat[5] * mat[10] - mat[9] * mat[6]) -
    mat[4] * (mat[1] * mat[10] - mat[9] * mat[2]) +
    mat[8] * (mat[1] * mat[6] - mat[5] * mat[2]);
  if (det < 0 && indices) {
    indices = indices.slice();
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
    if (normals) normals = computeNormals(positions, indices);
  }
  return { ...m, positions, normals, indices };
}

export interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

export function bbox(p: Float32Array): BBox {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  if (p.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

export const bboxDiagonal = (b: BBox) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);

/**
 * 고정 폭(stride) 32비트 행들의 중복 제거. remap[i] = 고유 행 번호(0..count-1).
 * first[u] = 고유 행 u가 처음 나타난 원래 행 번호.
 */
export function dedupeRows(rows: Uint32Array, stride: number): { remap: Uint32Array; count: number; first: Uint32Array } {
  const n = rows.length / stride;
  let size = 16;
  while (size < n * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const remap = new Uint32Array(n);
  const first = new Uint32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    let h = 0x811c9dc5;
    for (let k = 0; k < stride; k++) h = Math.imul(h ^ rows[o + k], 0x01000193);
    h = (h ^ (h >>> 15)) & mask;
    for (;;) {
      const u = table[h];
      if (u < 0) {
        table[h] = count;
        first[count] = i;
        remap[i] = count++;
        break;
      }
      const fo = first[u] * stride;
      let same = true;
      for (let k = 0; k < stride; k++)
        if (rows[fo + k] !== rows[o + k]) {
          same = false;
          break;
        }
      if (same) {
        remap[i] = u;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return { remap, count, first: first.subarray(0, count) };
}

function floatBits(src: Float32Array): Uint32Array {
  // -0과 +0을 같은 값으로 취급하도록 0을 더한 사본의 비트 패턴을 쓴다.
  const f = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) f[i] = src[i] + 0;
  return new Uint32Array(f.buffer);
}

/** 위치가 완전히 같은 정점을 하나의 위상 정점으로 묶는다 (UV 경계·STL 중복 대응). */
export function positionRemap(positions: Float32Array): { ids: Uint32Array; count: number; first: Uint32Array } {
  const r = dedupeRows(floatBits(positions), 3);
  return { ids: r.remap, count: r.count, first: r.first };
}

/** 위치(+UV)가 같은 정점을 합쳐 인덱스 메시로 만든다. 법선은 다시 계산한다. */
export function weld(m: MeshData): MeshData {
  const n = vertexCount(m);
  const stride = m.uvs ? 5 : 3;
  const rows = new Uint32Array(n * stride);
  const pb = floatBits(m.positions);
  const ub = m.uvs ? floatBits(m.uvs) : null;
  for (let i = 0; i < n; i++) {
    rows[i * stride] = pb[i * 3];
    rows[i * stride + 1] = pb[i * 3 + 1];
    rows[i * stride + 2] = pb[i * 3 + 2];
    if (ub) {
      rows[i * stride + 3] = ub[i * 2];
      rows[i * stride + 4] = ub[i * 2 + 1];
    }
  }
  const { remap, count, first } = dedupeRows(rows, stride);
  const positions = new Float32Array(count * 3);
  const colors = m.colors ? new Float32Array(count * 3) : null;
  const uvs = m.uvs ? new Float32Array(count * 2) : null;
  for (let u = 0; u < count; u++) {
    const s = first[u];
    positions.set(m.positions.subarray(s * 3, s * 3 + 3), u * 3);
    if (colors) colors.set(m.colors!.subarray(s * 3, s * 3 + 3), u * 3);
    if (uvs) uvs.set(m.uvs!.subarray(s * 2, s * 2 + 2), u * 2);
  }
  let indices: Uint32Array | null = null;
  if (m.indices) {
    indices = new Uint32Array(m.indices.length);
    for (let i = 0; i < indices.length; i++) indices[i] = remap[m.indices[i]];
  } else {
    indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = remap[i];
  }
  indices = dropDegenerate(indices);
  return { positions, indices, normals: computeNormals(positions, indices), colors, uvs };
}

export function dropDegenerate(indices: Uint32Array): Uint32Array {
  let w = 0;
  const o = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (a === b || b === c || a === c) continue;
    o[w++] = a; o[w++] = b; o[w++] = c;
  }
  return w === o.length ? o : o.slice(0, w);
}

/** 정점 유지 마스크로 속성 배열을 줄인다. */
function gatherVertices(m: MeshData, keep: Uint8Array): { out: MeshData; map: Int32Array } {
  const n = vertexCount(m);
  const map = new Int32Array(n).fill(-1);
  let c = 0;
  for (let i = 0; i < n; i++) if (keep[i]) map[i] = c++;
  const positions = new Float32Array(c * 3);
  const normals = m.normals ? new Float32Array(c * 3) : null;
  const colors = m.colors ? new Float32Array(c * 3) : null;
  const uvs = m.uvs ? new Float32Array(c * 2) : null;
  for (let i = 0; i < n; i++) {
    const j = map[i];
    if (j < 0) continue;
    positions[j * 3] = m.positions[i * 3];
    positions[j * 3 + 1] = m.positions[i * 3 + 1];
    positions[j * 3 + 2] = m.positions[i * 3 + 2];
    if (normals) {
      normals[j * 3] = m.normals![i * 3];
      normals[j * 3 + 1] = m.normals![i * 3 + 1];
      normals[j * 3 + 2] = m.normals![i * 3 + 2];
    }
    if (colors) {
      colors[j * 3] = m.colors![i * 3];
      colors[j * 3 + 1] = m.colors![i * 3 + 1];
      colors[j * 3 + 2] = m.colors![i * 3 + 2];
    }
    if (uvs) {
      uvs[j * 2] = m.uvs![i * 2];
      uvs[j * 2 + 1] = m.uvs![i * 2 + 1];
    }
  }
  return { out: { positions, normals, colors, uvs, indices: null }, map };
}

/** removeMask[f]=1인 면(포인트 클라우드는 점)을 지우고 쓰이지 않는 정점을 정리한다. */
export function deleteElements(m: MeshData, removeMask: Uint8Array): MeshData {
  const n = vertexCount(m);
  if (!m.indices) {
    const keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) keep[i] = removeMask[i] ? 0 : 1;
    return gatherVertices(m, keep).out;
  }
  const keep = new Uint8Array(n);
  const tc = m.indices.length / 3;
  let kept = 0;
  for (let f = 0; f < tc; f++) {
    if (removeMask[f]) continue;
    kept++;
    keep[m.indices[f * 3]] = 1;
    keep[m.indices[f * 3 + 1]] = 1;
    keep[m.indices[f * 3 + 2]] = 1;
  }
  const { out, map } = gatherVertices(m, keep);
  const indices = new Uint32Array(kept * 3);
  let w = 0;
  for (let f = 0; f < tc; f++) {
    if (removeMask[f]) continue;
    indices[w++] = map[m.indices[f * 3]];
    indices[w++] = map[m.indices[f * 3 + 1]];
    indices[w++] = map[m.indices[f * 3 + 2]];
  }
  return { ...out, indices };
}

/** 쓰이지 않는 정점 제거. */
export function compact(m: MeshData): MeshData {
  if (!m.indices) return m;
  return deleteElements(m, new Uint8Array(m.indices.length / 3));
}

/** 여러 객체를 월드 좌표로 구워 하나로 합친다. 속성은 모두가 가진 것만 유지한다. */
export function mergeMeshes(items: { mesh: MeshData; matrix: Mat4 }[]): MeshData {
  const baked = items.map((it) => bakeMatrix(it.mesh, it.matrix));
  const allMesh = baked.every((b) => b.indices);
  const hasN = baked.every((b) => b.normals);
  const hasC = baked.every((b) => b.colors);
  const hasU = baked.length === 1 && !!baked[0].uvs;
  let nv = 0, ni = 0;
  for (const b of baked) {
    nv += vertexCount(b);
    ni += b.indices ? b.indices.length : 0;
  }
  const positions = new Float32Array(nv * 3);
  const normals = hasN ? new Float32Array(nv * 3) : null;
  const colors = hasC ? new Float32Array(nv * 3) : null;
  const uvs = hasU ? baked[0].uvs!.slice() : null;
  const indices = allMesh ? new Uint32Array(ni) : null;
  let vo = 0, io = 0;
  for (const b of baked) {
    positions.set(b.positions, vo * 3);
    if (normals) normals.set(b.normals!, vo * 3);
    if (colors) colors.set(b.colors!, vo * 3);
    if (indices && b.indices) {
      for (let i = 0; i < b.indices.length; i++) indices[io + i] = b.indices[i] + vo;
      io += b.indices.length;
    }
    vo += vertexCount(b);
  }
  return { positions, normals, colors, uvs, indices };
}

/** 결과 객체에서 전송 가능한 버퍼를 모은다 (워커 → 메인 전송용). */
export function collectBuffers(v: unknown, out: Set<ArrayBufferLike> = new Set()): Set<ArrayBufferLike> {
  if (!v || typeof v !== 'object') return out;
  if (ArrayBuffer.isView(v)) out.add(v.buffer);
  else if (Array.isArray(v)) for (const x of v) collectBuffers(x, out);
  else for (const k of Object.keys(v as object)) collectBuffers((v as Record<string, unknown>)[k], out);
  return out;
}
