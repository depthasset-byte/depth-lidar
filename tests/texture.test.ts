import { describe, expect, it } from 'vitest';
import type { MeshData } from '../src/geometry/mesh';
import { ColorGrid, bakeTexture, buildAtlas } from '../src/geometry/texture';

/** 한 변 L의 속이 빈 상자(안쪽을 보는 면), 면마다 n x n 칸 */
function box(L: number, n: number, yaw = 0): MeshData {
  const pos: number[] = [], idx: number[] = [];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const add = (x: number, y: number, z: number) => {
    pos.push(c * x + s * z, y, -s * x + c * z);
    return pos.length / 3 - 1;
  };
  const face = (o: number[], u: number[], v: number[]) => {
    const g: number[][] = [];
    for (let j = 0; j <= n; j++) {
      const row: number[] = [];
      for (let i = 0; i <= n; i++) row.push(add(o[0] + (u[0] * i + v[0] * j) / n, o[1] + (u[1] * i + v[1] * j) / n, o[2] + (u[2] * i + v[2] * j) / n));
      g.push(row);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      idx.push(g[j][i], g[j][i + 1], g[j + 1][i], g[j][i + 1], g[j + 1][i + 1], g[j + 1][i]);
    }
  };
  // 바닥, 천장, 네 벽 (법선 방향은 중요하지 않다)
  face([0, 0, 0], [L, 0, 0], [0, 0, L]);
  face([0, L, 0], [L, 0, 0], [0, 0, L]);
  face([0, 0, 0], [L, 0, 0], [0, L, 0]);
  face([0, 0, L], [L, 0, 0], [0, L, 0]);
  face([0, 0, 0], [0, 0, L], [0, L, 0]);
  face([L, 0, 0], [0, 0, L], [0, L, 0]);
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), normals: null, colors: null, uvs: null };
}

describe('텍스처 굽기', () => {
  it('상자를 회전해 놓아도 6개 면이 조각이 되고 UV가 겹치지 않는다', () => {
    const m = box(3000, 6, 0.4);
    const a = buildAtlas(m, { texelMm: 10, maxSize: 4096 });
    expect(a.charts).toBe(6);
    // 회전 규약상 벽 법선의 각도는 -yaw로 나온다 (90도 주기)
    const diff = ((a.roomAngleDeg + (0.4 * 180) / Math.PI) % 90 + 90) % 90;
    expect(Math.min(diff, 90 - diff)).toBeLessThan(0.5);
    expect(a.mesh.uvs!.every((v) => v >= -1e-6 && v <= 1 + 1e-6)).toBe(true);
    expect(a.mesh.indices!.length).toBe(m.indices!.length);
    // 모든 삼각형의 UV 넓이 합 = 조각 넓이 / 텍셀^2 (겹침이 없으면 픽셀 점유가 겹치지 않는다)
    const W = a.width, H = a.height, occ = new Uint8Array(W * H);
    let overlap = 0;
    const UV = a.mesh.uvs!, I = a.mesh.indices!;
    for (let f = 0; f < I.length; f += 3) {
      const cx = ((UV[I[f] * 2] + UV[I[f + 1] * 2] + UV[I[f + 2] * 2]) / 3) * W;
      const cy = (1 - (UV[I[f] * 2 + 1] + UV[I[f + 1] * 2 + 1] + UV[I[f + 2] * 2 + 1]) / 3) * H;
      const k = Math.floor(cy) * W + Math.floor(cx);
      if (occ[k]) overlap++;
      occ[k] = 1;
    }
    expect(overlap).toBeLessThan(I.length * 0.01);
  });

  it('점군 색이 텍스처에 그대로 구워진다', () => {
    const L = 2000;
    const m = box(L, 4);
    const grid = new ColorGrid(20, 18);
    // 상자 표면 위 점에 위치에 따른 색을 준다 (x 방향으로 빨강이 늘어난다)
    const P: number[] = [], C: number[] = [];
    for (let i = 0; i < 6000; i++) {
      const u = Math.random() * L, v = Math.random() * L, f = i % 3;
      const p = f === 0 ? [u, 0, v] : f === 1 ? [u, v, 0] : [0, u, v];
      P.push(...p);
      C.push(p[0] / L, 0.2, 0.8);
    }
    expect(grid.add(Float32Array.from(P), Float32Array.from(C))).toBe(true);
    const a = buildAtlas(m, { texelMm: 10, maxSize: 2048 });
    const r = bakeTexture(a, grid);
    expect(r.fromPoints).toBeGreaterThan(10000);
    // 바닥(y=0) 조각의 한가운데 텍셀 색을 확인: 위치 (L/2, 0, L/2) → 빨강 0.5
    let hit = 0, bad = 0;
    const UV = a.mesh.uvs!, I = a.mesh.indices!, PP = a.mesh.positions;
    for (let f = 0; f < I.length; f += 3) {
      const ia = I[f], ib = I[f + 1], ic = I[f + 2];
      if (PP[ia * 3 + 1] !== 0 || PP[ib * 3 + 1] !== 0 || PP[ic * 3 + 1] !== 0) continue;
      const x = (PP[ia * 3] + PP[ib * 3] + PP[ic * 3]) / 3;
      const pu = ((UV[ia * 2] + UV[ib * 2] + UV[ic * 2]) / 3) * a.width, pv = (1 - (UV[ia * 2 + 1] + UV[ib * 2 + 1] + UV[ic * 2 + 1]) / 3) * a.height;
      const k = (Math.floor(pv) * a.width + Math.floor(pu)) * 3;
      const red = r.rgb[k] / 255;
      hit++;
      if (Math.abs(red - x / L) > 0.12) bad++;
    }
    expect(hit).toBeGreaterThan(10);
    expect(bad).toBeLessThan(hit * 0.1);
  });

  it('텍셀 크기가 너무 작으면 키워서 아틀라스에 맞춘다', () => {
    const m = box(60000, 3);
    const a = buildAtlas(m, { texelMm: 5, maxSize: 2048 });
    expect(a.texelMm).toBeGreaterThan(5);
    expect(a.width).toBeLessThanOrEqual(2048);
    expect(a.height).toBeLessThanOrEqual(a.width);
  });
});
