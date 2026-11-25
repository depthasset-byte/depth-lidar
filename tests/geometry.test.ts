import { describe, expect, it } from 'vitest';
import { KdTree, eigenSym, rigidFit } from '../src/geometry/align';
import { ops } from '../src/geometry/ops';
import { IDENTITY, bakeMatrix, mat4Invert, mat4Multiply, triangleCount, vertexCount, weld } from '../src/geometry/mesh';
import { makeSampleModel, makeSampleScans } from '../src/geometry/sample';
import { componentLabels, findBoundaryLoops } from '../src/geometry/topology';

const model = makeSampleModel();
const scans = makeSampleScans();

describe('기본 구조', () => {
  it('샘플 모델은 닫힌 메시다', () => {
    expect(findBoundaryLoops(model).length).toBe(0);
    const info = ops.meshInfo({ mesh: model, matrix: IDENTITY });
    expect(info.closed).toBe(true);
    expect(info.volume).toBeGreaterThan(200000);
    expect(info.area).toBeGreaterThan(20000);
  });
  it('역행렬과 곱이 단위 행렬이 된다', () => {
    const m = scans[1].offset;
    const p = mat4Multiply(m, mat4Invert(m));
    for (let i = 0; i < 16; i++) expect(p[i]).toBeCloseTo(IDENTITY[i], 6);
  });
  it('용접(weld)이 중복 정점을 합친다', () => {
    const idx = model.indices!;
    const soup = new Float32Array(idx.length * 3);
    for (let i = 0; i < idx.length; i++) soup.set(model.positions.subarray(idx[i] * 3, idx[i] * 3 + 3), i * 3);
    const w = weld({ positions: soup, indices: null, normals: null, colors: null, uvs: null });
    expect(vertexCount(w)).toBe(vertexCount(model));
    expect(triangleCount(w)).toBe(triangleCount(model));
    expect(findBoundaryLoops(w).length).toBe(0);
  });
  it('kd-트리 최근접이 전수 탐색과 같다', () => {
    const tree = new KdTree(model.positions);
    for (const q of [[10, 20, 30], [-50, 0, 5], [0, 60, 0], [3, -2, 44]]) {
      const i = tree.nearest(q[0], q[1], q[2]);
      let best = Infinity, bi = -1;
      for (let v = 0; v < vertexCount(model); v++) {
        const d = (model.positions[v * 3] - q[0]) ** 2 + (model.positions[v * 3 + 1] - q[1]) ** 2 + (model.positions[v * 3 + 2] - q[2]) ** 2;
        if (d < best) { best = d; bi = v; }
      }
      expect(tree.lastDist2).toBeCloseTo(best, 6);
      expect(i).toBe(bi);
      expect(tree.nearestK(q[0], q[1], q[2], 5)[0]).toBe(bi);
    }
  });
  it('고유값 분해와 강체 맞춤이 정확하다', () => {
    const e = eigenSym([[2, 1, 0], [1, 3, 0.5], [0, 0.5, 1]]);
    expect(e.values[0] + e.values[1] + e.values[2]).toBeCloseTo(6, 9);
    const P = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 3, 4, 5];
    const Q = Array.from(bakeMatrix({ positions: Float32Array.from(P), indices: null, normals: null, colors: null, uvs: null }, scans[2].offset).positions);
    const r = ops.alignPairs({ moving: P, fixed: Q, srcMatrix: IDENTITY });
    expect(r.rms).toBeLessThan(1e-4);
    for (let i = 0; i < 16; i++) expect(r.newMatrix[i]).toBeCloseTo(scans[2].offset[i], 4);
    expect(rigidFit(P, Q).t[0]).toBeCloseTo(scans[2].offset[12], 4);
  });
});

describe('메시 편집·후처리', () => {
  const s1 = scans[0].mesh;
  it('작은 조각 제거', () => {
    expect(componentLabels(s1).sizes.length).toBe(5);
    const r = ops.removeSmall({ mesh: s1, opts: { mode: 'largest', minTriangles: 0 } });
    expect(r.removedComponents).toBe(4);
    expect(componentLabels(r.mesh).sizes.length).toBe(1);
    const r2 = ops.removeSmall({ mesh: s1, opts: { mode: 'threshold', minTriangles: 50 } });
    expect(r2.removedTriangles).toBe(16);
  });
  it('구멍 검출과 메우기', () => {
    const clean = ops.removeSmall({ mesh: s1, opts: { mode: 'largest', minTriangles: 0 } }).mesh;
    const loops = findBoundaryLoops(clean);
    expect(loops.length).toBe(4); // 바깥 테두리 1 + 구멍 3
    const r = ops.fillHoles({ mesh: clean, opts: { loopIndices: [1, 2, 3], refine: true } });
    expect(r.filled).toBe(3);
    expect(r.addedTriangles).toBeGreaterThan(30);
    expect(findBoundaryLoops(r.mesh).length).toBe(1);
    // 채운 면의 방향이 주변과 같아야 한다 (법선이 바깥쪽).
    const P = r.mesh.positions, N = r.mesh.normals!;
    let out = 0;
    const nv = vertexCount(r.mesh);
    for (let v = vertexCount(clean); v < nv; v++) if (P[v * 3] * N[v * 3] + P[v * 3 + 1] * N[v * 3 + 1] + P[v * 3 + 2] * N[v * 3 + 2] > 0) out++;
    expect(nv).toBeGreaterThan(vertexCount(clean));
    expect(out / (nv - vertexCount(clean))).toBeGreaterThan(0.95);
    // 닫힌 모델 전체를 메우면 닫힌 메시가 된다.
    const all = ops.fillHoles({ mesh: clean, opts: { maxEdges: 100000 } });
    expect(findBoundaryLoops(all.mesh).length).toBe(0);
  });
  it('스무딩은 부피를 거의 유지한다 (타우빈)', () => {
    const before = ops.meshInfo({ mesh: model, matrix: IDENTITY }).volume;
    const sm = ops.smooth({ mesh: model, opts: { iterations: 10, strength: 0.5, taubin: true } }).mesh;
    const after = ops.meshInfo({ mesh: sm, matrix: IDENTITY }).volume;
    expect(Math.abs(after - before) / before).toBeLessThan(0.01);
    const lap = ops.smooth({ mesh: model, opts: { iterations: 10, strength: 0.5, taubin: false } }).mesh;
    expect(ops.meshInfo({ mesh: lap, matrix: IDENTITY }).volume).toBeLessThan(before);
  });
  it('메시 단순화', async () => {
    const r = await ops.simplify({ mesh: model, targetTriangles: 5000 });
    expect(r.after).toBeLessThanOrEqual(5500);
    expect(r.after).toBeGreaterThan(3000);
    expect(findBoundaryLoops(r.mesh).length).toBe(0);
    const v = ops.meshInfo({ mesh: r.mesh, matrix: IDENTITY }).volume;
    expect(Math.abs(v - ops.meshInfo({ mesh: model, matrix: IDENTITY }).volume) / v).toBeLessThan(0.02);
  });
  it('면 삭제와 법선 뒤집기', () => {
    const mask = new Uint8Array(triangleCount(model));
    mask.fill(1, 0, 1000);
    const d = ops.deleteElements({ mesh: model, mask }).mesh;
    expect(triangleCount(d)).toBe(triangleCount(model) - 1000);
    const f = ops.flip({ mesh: model }).mesh;
    expect(f.normals![0]).toBeCloseTo(-model.normals![0], 5);
  });
});

describe('정렬·퓨전·측정', () => {
  it('ICP가 어긋난 스캔을 제자리로 돌린다', () => {
    for (const si of [1, 2]) {
      const r = ops.align({ src: scans[si].mesh, srcMatrix: IDENTITY, dst: scans[0].mesh, dstMatrix: IDENTITY, mode: 'icp', opts: {} });
      expect(r.initialRms).toBeGreaterThan(1);
      expect(r.rms).toBeLessThan(0.15);
      // 정답: 어긋남의 역변환
      const residual = mat4Multiply(r.newMatrix, scans[si].offset);
      for (let i = 0; i < 16; i++) expect(Math.abs(residual[i] - IDENTITY[i])).toBeLessThan(i >= 12 ? 0.3 : 0.01);
    }
  });
  it('거친 정렬(PCA)이 크게 어긋난 전체 모델을 맞춘다', () => {
    const far = bakeMatrix(model, mat4Multiply(scans[2].offset, mat4Multiply(scans[1].offset, [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 80, -40, 30, 1])));
    const r = ops.align({ src: far, srcMatrix: IDENTITY, dst: model, dstMatrix: IDENTITY, mode: 'coarse', opts: {} });
    expect(r.rms).toBeLessThan(0.2);
  });
  it('퓨전이 세 스캔을 하나의 메시로 합친다', () => {
    const items = scans.map((s) => ({ mesh: s.mesh, matrix: mat4Invert(s.offset) }));
    const r = ops.fuse({ items, opts: { voxel: 1.2 } });
    expect(triangleCount(r.mesh)).toBeGreaterThan(20000);
    const tree = new KdTree(model.positions);
    const P = r.mesh.positions, N = r.mesh.normals!;
    let sum = 0, out = 0, far = 0;
    const nv = vertexCount(r.mesh);
    for (let v = 0; v < nv; v++) {
      tree.nearest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      const d = Math.sqrt(tree.lastDist2);
      sum += d;
      if (d > 5) far++;
      if (P[v * 3] * N[v * 3] + P[v * 3 + 1] * N[v * 3 + 1] + P[v * 3 + 2] * N[v * 3 + 2] > 0) out++;
    }
    expect(far / nv).toBeLessThan(0.01); // 떠 있던 조각 정도만 멀다
    expect(sum / nv).toBeLessThan(1.0);
    expect(out / nv).toBeGreaterThan(0.97);
    expect(r.mesh.colors).not.toBeNull();
    const main = ops.removeSmall({ mesh: r.mesh, opts: { mode: 'largest', minTriangles: 0 } }).mesh;
    const loops = findBoundaryLoops(main);
    // 세 방향 스캔이 전체를 덮으므로 큰 테두리가 없어야 한다.
    expect(loops.length).toBeLessThanOrEqual(2);
  });
  it('단면과 정보 측정', () => {
    const s = ops.section({ mesh: model, matrix: IDENTITY, normal: [0, 1, 0], d: 0 });
    expect(s.closedLoops).toBe(1);
    expect(s.openChains).toBe(0);
    expect(s.length).toBeGreaterThan(200);
    expect(s.area).toBeGreaterThan(3500);
    expect(s.area).toBeLessThan(8000);
    const info = ops.meshInfo({ mesh: scans[0].mesh, matrix: IDENTITY });
    expect(info.closed).toBe(false);
    expect(info.boundaryEdges).toBeGreaterThan(10);
  });
});
