// 워커에서 실행하는 연산 목록. 메인 스레드와 워커가 같은 이름·인자 형식을 공유한다.
import { MeshoptSimplifier } from 'meshoptimizer';
import { IcpOptions, alignByPairs, coarseAlign, estimateNormals, icp, makeIcpTarget } from './align';
import { FusionOptions, fuse } from './fusion';
import { meshInfo, section } from './measure';
import { Mat4, MeshData, bakeMatrix, compact, computeNormals, deleteElements, mat4Multiply, transformNormals, transformPoints, triangleCount, weld } from './mesh';
import { makeSampleModel, makeSampleScans } from './sample';
import { FillHolesOptions, RemoveSmallOptions, SmoothOptions, fillHoles, findBoundaryLoops, flipNormals, removeSmallComponents, smoothMesh } from './topology';

export async function simplifyMesh(m: MeshData, targetTriangles: number) {
  if (!m.indices) return { mesh: m, before: 0, after: 0, error: 0 };
  await MeshoptSimplifier.ready;
  const before = triangleCount(m);
  const target = Math.max(4, Math.min(before, Math.round(targetTriangles))) * 3;
  const [indices, error] = MeshoptSimplifier.simplify(m.indices, m.positions, 3, target, 1.0);
  const out = compact({ ...m, indices: new Uint32Array(indices) });
  return { mesh: { ...out, normals: computeNormals(out.positions, out.indices!) }, before, after: indices.length / 3, error };
}

export const ops = {
  removeSmall: (a: { mesh: MeshData; opts: RemoveSmallOptions }) => removeSmallComponents(a.mesh, a.opts),
  findHoles: (a: { mesh: MeshData }) => findBoundaryLoops(a.mesh),
  fillHoles: (a: { mesh: MeshData; opts: FillHolesOptions }) => fillHoles(a.mesh, a.opts),
  smooth: (a: { mesh: MeshData; opts: SmoothOptions }) => ({ mesh: smoothMesh(a.mesh, a.opts) }),
  simplify: (a: { mesh: MeshData; targetTriangles: number }) => simplifyMesh(a.mesh, a.targetTriangles),
  flip: (a: { mesh: MeshData }) => ({ mesh: flipNormals(a.mesh) }),
  deleteElements: (a: { mesh: MeshData; mask: Uint8Array }) => ({ mesh: deleteElements(a.mesh, a.mask) }),
  weld: (a: { mesh: MeshData }) => ({ mesh: weld(a.mesh) }),
  estimateNormals: (a: { mesh: MeshData }) => ({ mesh: { ...a.mesh, normals: estimateNormals(a.mesh.positions) } as MeshData }),
  bake: (a: { mesh: MeshData; matrix: Mat4 }) => ({ mesh: bakeMatrix(a.mesh, a.matrix) }),
  /** 움직이는 객체(src)를 기준 객체(dst)에 정렬. 새 월드 행렬을 돌려준다. */
  align: (a: { src: MeshData; srcMatrix: Mat4; dst: MeshData; dstMatrix: Mat4; mode: 'icp' | 'coarse'; opts: IcpOptions }) => {
    const sw = transformPoints(a.src.positions, a.srcMatrix);
    const dw = transformPoints(a.dst.positions, a.dstMatrix);
    const dn = a.dst.indices ? computeNormals(dw, a.dst.indices) : a.dst.normals ? transformNormals(a.dst.normals, a.dstMatrix) : null;
    const target = makeIcpTarget(dw, dn);
    const r = a.mode === 'coarse' ? coarseAlign(sw, target, a.opts) : icp(sw, target, a.opts);
    return { ...r, newMatrix: mat4Multiply(r.matrix, a.srcMatrix) };
  },
  alignPairs: (a: { moving: number[]; fixed: number[]; srcMatrix: Mat4 }) => {
    const delta = alignByPairs(a.moving, a.fixed);
    let sum = 0;
    const n = a.moving.length / 3;
    const mv = transformPoints(Float32Array.from(a.moving), delta);
    for (let i = 0; i < n; i++) sum += (mv[i * 3] - a.fixed[i * 3]) ** 2 + (mv[i * 3 + 1] - a.fixed[i * 3 + 1]) ** 2 + (mv[i * 3 + 2] - a.fixed[i * 3 + 2]) ** 2;
    return { newMatrix: mat4Multiply(delta, a.srcMatrix), rms: Math.sqrt(sum / n) };
  },
  fuse: (a: { items: { mesh: MeshData; matrix: Mat4 }[]; opts: FusionOptions }) => fuse(a.items, a.opts),
  meshInfo: (a: { mesh: MeshData; matrix: Mat4 }) => meshInfo(a.mesh, a.matrix),
  section: (a: { mesh: MeshData; matrix: Mat4; normal: [number, number, number]; d: number }) => section(a.mesh, a.matrix, a.normal, a.d),
  sampleModel: (_a: object) => ({ mesh: makeSampleModel() }),
  sampleScans: (_a: object) => makeSampleScans(),
};

export type OpName = keyof typeof ops;
export type OpArgs<K extends OpName> = Parameters<(typeof ops)[K]>[0];
export type OpResult<K extends OpName> = Awaited<ReturnType<(typeof ops)[K]>>;
