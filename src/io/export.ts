// 내보내기: OBJ(+MTL·PNG), PLY(바이너리), STL(바이너리), GLB.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshData, computeNormals, vertexCount } from '../geometry/mesh';
import type { TextureInfo } from '../store';
import type { OutFile } from './platform';

export type ExportFormat = 'obj' | 'ply' | 'stl' | 'glb';

export const EXPORT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  obj: { name: 'Wavefront OBJ', extensions: ['obj'] },
  ply: { name: 'Stanford PLY', extensions: ['ply'] },
  stl: { name: 'STL (바이너리)', extensions: ['stl'] },
  glb: { name: 'glTF 바이너리', extensions: ['glb'] },
};

export function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('PNG 변환 실패'))), 'image/png'),
  );
}

const f = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

/** 화면 없이(명령줄) 쓸 때: 원본 텍스처 파일을 그대로 함께 내보낸다. */
export interface RawTexture {
  name: string;
  data: ArrayBuffer | Uint8Array;
}

async function exportOBJ(m: MeshData, base: string, tex: TextureInfo | null, raw: RawTexture | null = null): Promise<OutFile[]> {
  const parts: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    parts.push(buf.join('\n'));
    buf = [];
  };
  const useTex = !!((tex || raw) && m.uvs);
  buf.push('# Depth Lidar OBJ');
  if (useTex) buf.push(`mtllib ${base}.mtl`, 'usemtl material0');
  const n = vertexCount(m);
  const P = m.positions, C = useTex ? null : m.colors;
  for (let i = 0; i < n; i++) {
    buf.push(C ? `v ${f(P[i * 3])} ${f(P[i * 3 + 1])} ${f(P[i * 3 + 2])} ${f(C[i * 3])} ${f(C[i * 3 + 1])} ${f(C[i * 3 + 2])}` : `v ${f(P[i * 3])} ${f(P[i * 3 + 1])} ${f(P[i * 3 + 2])}`);
    if (buf.length > 50000) flush();
  }
  if (useTex) {
    const U = m.uvs!;
    for (let i = 0; i < n; i++) {
      buf.push(`vt ${f(U[i * 2])} ${f(U[i * 2 + 1])}`);
      if (buf.length > 50000) flush();
    }
  }
  if (m.indices) {
    const I = m.indices;
    for (let i = 0; i < I.length; i += 3) {
      const a = I[i] + 1, b = I[i + 1] + 1, c = I[i + 2] + 1;
      buf.push(useTex ? `f ${a}/${a} ${b}/${b} ${c}/${c}` : `f ${a} ${b} ${c}`);
      if (buf.length > 50000) flush();
    }
  }
  flush();
  const files: OutFile[] = [{ name: `${base}.obj`, data: new TextEncoder().encode(parts.join('\n') + '\n') }];
  if (useTex) {
    const ext = raw ? (/\.[A-Za-z0-9]+$/.exec(raw.name)?.[0] ?? '.png') : '.png';
    files.push({ name: `${base}.mtl`, data: `newmtl material0\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nmap_Kd ${base}${ext}\n` });
    files.push({ name: `${base}${ext}`, data: raw ? raw.data : await canvasToPng(tex!.canvas) });
  }
  return files;
}

function exportPLY(m: MeshData, base: string): OutFile[] {
  const n = vertexCount(m);
  const hasN = !!m.normals, hasC = !!m.colors, hasU = !!m.uvs;
  const tc = m.indices ? m.indices.length / 3 : 0;
  let header = `ply\nformat binary_little_endian 1.0\ncomment Depth Lidar\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\n`;
  if (hasN) header += 'property float nx\nproperty float ny\nproperty float nz\n';
  if (hasC) header += 'property uchar red\nproperty uchar green\nproperty uchar blue\n';
  if (hasU) header += 'property float s\nproperty float t\n';
  if (tc) header += `element face ${tc}\nproperty list uchar int vertex_indices\n`;
  header += 'end_header\n';
  const hb = new TextEncoder().encode(header);
  const vs = 12 + (hasN ? 12 : 0) + (hasC ? 3 : 0) + (hasU ? 8 : 0);
  const out = new Uint8Array(hb.length + n * vs + tc * 13);
  out.set(hb);
  const dv = new DataView(out.buffer);
  let o = hb.length;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) { dv.setFloat32(o, m.positions[i * 3 + k], true); o += 4; }
    if (hasN) for (let k = 0; k < 3; k++) { dv.setFloat32(o, m.normals![i * 3 + k], true); o += 4; }
    if (hasC) for (let k = 0; k < 3; k++) dv.setUint8(o++, Math.max(0, Math.min(255, Math.round(m.colors![i * 3 + k] * 255))));
    if (hasU) for (let k = 0; k < 2; k++) { dv.setFloat32(o, m.uvs![i * 2 + k], true); o += 4; }
  }
  for (let t = 0; t < tc; t++) {
    dv.setUint8(o++, 3);
    for (let k = 0; k < 3; k++) { dv.setInt32(o, m.indices![t * 3 + k], true); o += 4; }
  }
  return [{ name: `${base}.ply`, data: out }];
}

function exportSTL(m: MeshData, base: string): OutFile[] {
  if (!m.indices) throw new Error('STL은 메시만 내보낼 수 있습니다.');
  const tc = m.indices.length / 3;
  const out = new Uint8Array(84 + tc * 50);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode('Depth Lidar binary STL'));
  dv.setUint32(80, tc, true);
  const P = m.positions, I = m.indices;
  let o = 84;
  for (let t = 0; t < tc; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, P[v], true); dv.setFloat32(o + 4, P[v + 1], true); dv.setFloat32(o + 8, P[v + 2], true);
      o += 12;
    }
    o += 2;
  }
  return [{ name: `${base}.stl`, data: out }];
}

const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

async function exportGLB(m: MeshData, base: string, tex: TextureInfo | null): Promise<OutFile[]> {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  const useTex = !!(tex && m.uvs);
  if (m.indices) {
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals ?? computeNormals(m.positions, m.indices), 3));
  }
  if (m.colors && !useTex) {
    const c = new Float32Array(m.colors.length);
    for (let i = 0; i < c.length; i++) c[i] = srgbToLin(m.colors[i]);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  let map: THREE.Texture | null = null;
  if (useTex) {
    const uv = m.uvs!.slice();
    for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i];
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    map = new THREE.CanvasTexture(tex!.canvas);
    map.flipY = false;
    map.colorSpace = THREE.SRGBColorSpace;
  }
  const obj = m.indices
    ? new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map, vertexColors: !!g.getAttribute('color'), roughness: 0.8, metalness: 0 }))
    : new THREE.Points(g, new THREE.PointsMaterial({ vertexColors: !!g.getAttribute('color') }));
  obj.name = base;
  const scene = new THREE.Scene();
  scene.add(obj);
  const data = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
  g.dispose();
  map?.dispose();
  return [{ name: `${base}.glb`, data }];
}

export async function exportMesh(format: ExportFormat, m: MeshData, base: string, tex: TextureInfo | null, raw: RawTexture | null = null): Promise<OutFile[]> {
  switch (format) {
    case 'obj': return exportOBJ(m, base, tex, raw);
    case 'ply': return exportPLY(m, base);
    case 'stl': return exportSTL(m, base);
    case 'glb': return exportGLB(m, base, tex);
  }
}
