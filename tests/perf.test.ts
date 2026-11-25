// 대용량 성능 측정. 평소 시험에서는 건너뛰고 PERF=1 일 때만 실행한다.
import { describe, expect, it } from 'vitest';
import { ops } from '../src/geometry/ops';
import { IDENTITY, bakeMatrix, triangleCount } from '../src/geometry/mesh';
import { makeSampleModel } from '../src/geometry/sample';

describe.skipIf(!process.env.PERF)('성능 (약 100만 면)', () => {
  it('주요 연산 소요 시간', async () => {
    const t = (label: string, t0: number) => console.log(`${label}: ${((performance.now() - t0) / 1000).toFixed(2)}초`);
    let t0 = performance.now();
    const big = makeSampleModel(500, 1000);
    t(`모델 생성 (면 ${triangleCount(big).toLocaleString()})`, t0);
    t0 = performance.now(); ops.removeSmall({ mesh: big, opts: { mode: 'largest', minTriangles: 0 } }); t('조각 분석', t0);
    t0 = performance.now(); ops.findHoles({ mesh: big }); t('구멍 검출', t0);
    t0 = performance.now(); ops.smooth({ mesh: big, opts: { iterations: 5, strength: 0.5, taubin: true } }); t('스무딩 5회', t0);
    t0 = performance.now(); const s = await ops.simplify({ mesh: big, targetTriangles: 200000 }); t(`단순화 → ${s.after.toLocaleString()}`, t0);
    t0 = performance.now(); ops.meshInfo({ mesh: big, matrix: IDENTITY }); t('치수·부피', t0);
    t0 = performance.now(); ops.section({ mesh: big, matrix: IDENTITY, normal: [0, 1, 0], d: 0 }); t('단면', t0);
    const moved = bakeMatrix(big, [0.995, 0.0998, 0, 0, -0.0998, 0.995, 0, 0, 0, 0, 1, 0, 3, -2, 4, 1]);
    t0 = performance.now(); const a = ops.align({ src: moved, srcMatrix: IDENTITY, dst: big, dstMatrix: IDENTITY, mode: 'icp', opts: {} }); t(`ICP (RMS ${a.initialRms.toFixed(2)} → ${a.rms.toFixed(3)})`, t0);
    t0 = performance.now(); const f = ops.fuse({ items: [{ mesh: big, matrix: IDENTITY }], opts: { voxel: 0.5 } }); t(`퓨전 해상도 0.5 → 면 ${triangleCount(f.mesh).toLocaleString()}`, t0);
    expect(triangleCount(f.mesh)).toBeGreaterThan(100000);
  });
});
