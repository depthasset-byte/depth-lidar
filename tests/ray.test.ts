import { describe, expect, it } from 'vitest';
import { RAY_RANGE_OFFSET_M, RAY_RANGE_SCALE, RayScanMeta, rayBinToCloud, readRayBinHeader } from '../src/io/ray';

const DEG = Math.PI / 180;
const LINES = 400;
const SAMPLES = 600;

const meta: RayScanMeta = {
  dir: 'x',
  folder: 'x',
  name: 'Scan 001',
  device: 'test',
  created: '',
  resolution: '',
  lines: LINES,
  samples: SAMPLES,
  azCenterDeg: 0,
  elCenterDeg: 90,
  hSizeDeg: 183,
  vSizeDeg: 300,
  clockwise: false,
  tilt: null,
  sliceCount: 1,
};

/** 바닥(스캐너 아래 1.5 m)과 천장(위 2.5 m)만 있는 방을 도우미 출력 형식으로 만든다. */
function makeBin(lineStep = 1) {
  const kept = Math.ceil(LINES / lineStep);
  const rec = 4 + SAMPLES * 5;
  const buf = new ArrayBuffer(28 + kept * rec);
  const dv = new DataView(buf);
  [0x31594152, 1, lineStep, SAMPLES, kept, SAMPLES, LINES].forEach((v, i) => dv.setInt32(i * 4, v, true));
  for (let k = 0; k < kept; k++) {
    const o = 28 + k * rec;
    dv.setInt32(o, k * lineStep, true);
    for (let j = 0; j < SAMPLES; j++) {
      const th = -150 * DEG + ((j + 0.5) * 300 * DEG) / SAMPLES;
      const c = Math.cos(th);
      let r = c > 0 ? 2.5 / c : 1.5 / -c;
      if (k === 3 && j === 10) r = 0; // 반사가 없던 표본
      dv.setInt32(o + 4 + j * 4, Math.round((r - RAY_RANGE_OFFSET_M) / RAY_RANGE_SCALE), true);
      dv.setUint8(o + 4 + SAMPLES * 4 + j, 128);
    }
  }
  return buf;
}

describe('Artec Ray II 원본 변환', () => {
  it('머리말을 읽고 잘린 파일을 거부한다', () => {
    const buf = makeBin();
    expect(readRayBinHeader(buf)).toMatchObject({ samplesPerLine: SAMPLES, keptLines: LINES, fullWidth: SAMPLES, totalLines: LINES });
    expect(() => readRayBinHeader(buf.slice(0, 1000))).toThrow();
    expect(() => readRayBinHeader(new ArrayBuffer(64))).toThrow();
  });

  it('바닥과 천장이 평면으로 복원된다 (mm, Y가 위)', () => {
    const { data, kept, total } = rayBinToCloud(makeBin(), meta, { maxRange: 30 });
    expect(total).toBe(LINES * SAMPLES);
    expect(kept).toBeLessThan(total); // 수평선 근처의 먼 점과 빈 표본은 빠진다
    expect(kept).toBeGreaterThan(total * 0.8);
    const p = data.positions;
    let floor = 0;
    let ceil = 0;
    const quad = [0, 0, 0, 0];
    for (let i = 0; i < p.length; i += 3) {
      const y = p[i + 1];
      if (Math.abs(y + 1500) < 1) floor++;
      else if (Math.abs(y - 2500) < 1) ceil++;
      quad[(p[i] > 0 ? 1 : 0) + (p[i + 2] > 0 ? 2 : 0)]++;
    }
    expect(floor + ceil).toBe(kept);
    expect(floor).toBeGreaterThan(1000);
    expect(ceil).toBeGreaterThan(1000);
    // 183도 회전으로 앞·뒤 양쪽을 훑어 사방이 채워진다
    for (const q of quad) expect(q).toBeGreaterThan(kept * 0.15);
    expect(data.indices).toBeNull();
    expect(data.colors!.length).toBe(p.length);
    expect(data.colors![0]).toBeCloseTo(Math.pow(128 / 255, 0.55), 5);
  });

  it('첫 줄 첫 표본의 방향이 각도 모델과 같다', () => {
    const { data } = rayBinToCloud(makeBin(), meta, { maxRange: 1000 });
    // 첫 표본: 천정에서 -150도 + 반 칸, 방위 -(0 + 91.5 + 90) = -181.5도. 바닥(아래 1.5 m)에 닿는다.
    const th = -150 * DEG + (0.5 * 300 * DEG) / SAMPLES;
    const az = -181.5 * DEG;
    const r = 1.5 / -Math.cos(th);
    const x = r * Math.sin(th) * Math.cos(az);
    const y = r * Math.sin(th) * Math.sin(az);
    expect(data.positions[0]).toBeCloseTo(x * 1000, 0);
    expect(data.positions[1]).toBeCloseTo(-1500, 0);
    expect(data.positions[2]).toBeCloseTo(-y * 1000, 0);
  });

  it('기울기 행렬로 수평을 맞춘다', () => {
    // 스캐너가 X축으로 2도 기운 것으로 가정: 기울기 행렬의 전치를 곱하면 바닥이 다시 수평이 된다.
    const a = 2 * DEG;
    const tilt = [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)];
    const flat = rayBinToCloud(makeBin(4), meta, { maxRange: 30 }).data.positions;
    const tilted = rayBinToCloud(makeBin(4), { ...meta, tilt }, { maxRange: 30 }).data.positions;
    const off = rayBinToCloud(makeBin(4), { ...meta, tilt }, { maxRange: 30, level: false }).data.positions;
    expect(off[1]).toBeCloseTo(flat[1], 3);
    let spread = 0;
    for (let i = 0; i < tilted.length; i += 3) if (flat[i + 1] < 0) spread = Math.max(spread, Math.abs(tilted[i + 1] + 1500));
    expect(spread).toBeGreaterThan(100); // 기운 만큼 바닥 높이가 달라진다
    // 길이는 보존된다
    expect(Math.hypot(tilted[0], tilted[1], tilted[2])).toBeCloseTo(Math.hypot(flat[0], flat[1], flat[2]), 1);
  });
});
