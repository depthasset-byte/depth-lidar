// 파일 불러오기: OBJ(+MTL·텍스처), PLY, STL, GLB/GLTF, 텍스트 점군(XYZ/ASC/PTS).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { MeshData, bakeMatrix, computeNormals, weld } from '../geometry/mesh';
import type { TextureInfo } from '../store';
import { PickedFile, readSibling } from './platform';

export interface Imported {
  name: string;
  data: MeshData;
  texture: TextureInfo | null;
}

export const IMPORT_FILTERS = [
  { name: '3D 파일', extensions: ['obj', 'ply', 'stl', 'glb', 'gltf', 'xyz', 'asc', 'pts', 'ssproj'] },
  { name: 'Artec Ray II 프로젝트 (project.artec)', extensions: ['artec'] },
];

const linToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export async function canvasFromBytes(bytes: ArrayBuffer, name: string): Promise<TextureInfo> {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(bmp, 0, 0);
  bmp.close();
  return { canvas, name };
}

function parseOBJ(text: string) {
  const v: number[] = [], vc: number[] = [], vt: number[] = [];
  const outP: number[] = [], outC: number[] = [], outU: number[] = [], idx: number[] = [];
  const map = new Map<number, number>();
  let mtllib: string | null = null;
  let hasColor = false, hasUV = false;
  const K = 67108864;
  const corner = (tok: string): number => {
    const s1 = tok.indexOf('/');
    let vi = parseInt(s1 < 0 ? tok : tok.slice(0, s1), 10);
    let ti = 0;
    if (s1 >= 0) {
      const s2 = tok.indexOf('/', s1 + 1);
      const t = tok.slice(s1 + 1, s2 < 0 ? undefined : s2);
      if (t) ti = parseInt(t, 10);
    }
    if (vi < 0) vi = v.length / 3 + vi + 1;
    if (ti < 0) ti = vt.length / 2 + ti + 1;
    const key = vi * K + ti;
    let o = map.get(key);
    if (o === undefined) {
      o = outP.length / 3;
      const p = (vi - 1) * 3;
      outP.push(v[p], v[p + 1], v[p + 2]);
      if (hasColor) outC.push(vc[p] ?? 0.7, vc[p + 1] ?? 0.7, vc[p + 2] ?? 0.7);
      if (ti > 0) {
        hasUV = true;
        outU.push(vt[(ti - 1) * 2], vt[(ti - 1) * 2 + 1]);
      } else outU.push(0, 0);
      map.set(key, o);
    }
    return o;
  };
  let pos = 0;
  const len = text.length;
  while (pos < len) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = len;
    const c0 = text.charCodeAt(pos);
    if (c0 === 118 /* v */) {
      const c1 = text.charCodeAt(pos + 1);
      if (c1 === 32 || c1 === 9) {
        const t = text.slice(pos + 2, end).trim().split(/\s+/);
        v.push(+t[0], +t[1], +t[2]);
        if (t.length >= 6) {
          hasColor = true;
          vc.push(+t[3], +t[4], +t[5]);
        } else vc.push(0.7, 0.7, 0.7);
      } else if (c1 === 116 /* t */) {
        const t = text.slice(pos + 3, end).trim().split(/\s+/);
        vt.push(+t[0], +t[1]);
      }
    } else if (c0 === 102 /* f */) {
      const t = text.slice(pos + 2, end).trim().split(/\s+/);
      if (t.length >= 3) {
        const a = corner(t[0]);
        let b = corner(t[1]);
        for (let k = 2; k < t.length; k++) {
          const c = corner(t[k]);
          idx.push(a, b, c);
          b = c;
        }
      }
    } else if (c0 === 109 /* m */ && text.startsWith('mtllib', pos)) {
      mtllib = text.slice(pos + 6, end).trim();
    }
    pos = end + 1;
  }
  const isCloud = idx.length === 0;
  const positions = Float32Array.from(isCloud ? v : outP);
  const colors = hasColor ? Float32Array.from(isCloud ? vc : outC) : null;
  const indices = isCloud ? null : Uint32Array.from(idx);
  const data: MeshData = {
    positions,
    indices,
    normals: indices ? computeNormals(positions, indices) : null,
    colors,
    uvs: hasUV && !isCloud ? Float32Array.from(outU) : null,
  };
  return { data, mtllib };
}

function parseMTLTexture(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (/^map_Kd\s/i.test(t)) {
      const rest = t.slice(6).trim();
      // 옵션(-o, -s 등)을 건너뛰고 마지막 인자를 파일 이름으로 본다.
      const parts = rest.split(/\s+/);
      return rest.includes(' -') || rest.startsWith('-') ? parts[parts.length - 1] : rest;
    }
  }
  return null;
}

function fromGeometry(g: THREE.BufferGeometry, colorsAreLinear: boolean): MeshData {
  const pa = g.getAttribute('position');
  const n = pa.count;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = pa.getX(i);
    positions[i * 3 + 1] = pa.getY(i);
    positions[i * 3 + 2] = pa.getZ(i);
  }
  const ca = g.getAttribute('color');
  let colors: Float32Array | null = null;
  if (ca) {
    colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = ca.getX(i), gg = ca.getY(i), b = ca.getZ(i);
      colors[i * 3] = colorsAreLinear ? linToSrgb(r) : r;
      colors[i * 3 + 1] = colorsAreLinear ? linToSrgb(gg) : gg;
      colors[i * 3 + 2] = colorsAreLinear ? linToSrgb(b) : b;
    }
  }
  const ua = g.getAttribute('uv');
  let uvs: Float32Array | null = null;
  if (ua) {
    uvs = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      uvs[i * 2] = ua.getX(i);
      uvs[i * 2 + 1] = ua.getY(i);
    }
  }
  const na = g.getAttribute('normal');
  let normals: Float32Array | null = null;
  const index = g.getIndex();
  const indices = index ? Uint32Array.from(index.array as ArrayLike<number>) : null;
  if (indices) normals = computeNormals(positions, indices);
  else if (na) {
    normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      normals[i * 3] = na.getX(i);
      normals[i * 3 + 1] = na.getY(i);
      normals[i * 3 + 2] = na.getZ(i);
    }
  }
  return { positions, indices, normals, colors, uvs };
}

function parseTextCloud(text: string): MeshData {
  const p: number[] = [], c: number[] = [];
  let hasColor = true;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/[\s,;]+/);
    if (t.length < 3) continue;
    const x = +t[0], y = +t[1], z = +t[2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    p.push(x, y, z);
    // x y z [강도] r g b 형식이면 마지막 세 값을 색으로 본다.
    if (t.length >= 6) {
      const r = +t[t.length - 3], g = +t[t.length - 2], b = +t[t.length - 1];
      const s = r > 1 || g > 1 || b > 1 ? 255 : 1;
      c.push(r / s, g / s, b / s);
    } else {
      hasColor = false;
      c.push(0.7, 0.7, 0.7);
    }
  }
  return { positions: Float32Array.from(p), indices: null, normals: null, colors: hasColor && p.length ? Float32Array.from(c) : null, uvs: null };
}

async function imageToCanvas(img: CanvasImageSource & { width: number; height: number }, name: string): Promise<TextureInfo> {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0);
  return { canvas, name };
}

export async function importFile(file: PickedFile, pool: PickedFile[]): Promise<Imported[]> {
  const ext = file.name.split('.').pop()!.toLowerCase();
  const base = file.name.replace(/\.[^.]+$/, '');
  if (ext === 'obj') {
    const { data, mtllib } = parseOBJ(new TextDecoder().decode(file.data));
    let texture: TextureInfo | null = null;
    if (data.uvs) {
      const mtlBytes = (mtllib && (await readSibling(file, mtllib, pool))) || (await readSibling(file, base + '.mtl', pool));
      const texName = mtlBytes ? parseMTLTexture(new TextDecoder().decode(mtlBytes)) : null;
      const candidates = texName ? [texName] : [base + '.png', base + '.jpg', base + '_0.png', base + '_0.jpg'];
      for (const cnd of candidates) {
        const bytes = await readSibling(file, cnd, pool);
        if (bytes) {
          try {
            texture = await canvasFromBytes(bytes, cnd.replace(/\\/g, '/').split('/').pop()!);
            break;
          } catch {
            /* 지원하지 않는 이미지 형식 */
          }
        }
      }
    }
    return [{ name: base, data, texture }];
  }
  if (ext === 'ply') {
    const g = new PLYLoader().parse(file.data);
    return [{ name: base, data: fromGeometry(g, true), texture: null }];
  }
  if (ext === 'stl') {
    const g = new STLLoader().parse(file.data);
    const raw = fromGeometry(g, false);
    return [{ name: base, data: weld({ ...raw, colors: null, uvs: null, normals: null }), texture: null }];
  }
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(file.data, '');
    gltf.scene.updateMatrixWorld(true);
    const out: Imported[] = [];
    const jobs: Promise<void>[] = [];
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const pts = o as THREE.Points;
      if (!mesh.isMesh && !pts.isPoints) return;
      let data = fromGeometry(mesh.geometry, true);
      if (pts.isPoints) data = { ...data, indices: null };
      else if (!data.indices) data = weld(data);
      data = bakeMatrix(data, mesh.matrixWorld.elements.slice());
      const item: Imported = { name: o.name || base, data, texture: null };
      out.push(item);
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      const img = mat?.map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
      if (img && data.uvs) {
        // glTF의 UV 원점은 왼쪽 위이므로 OBJ 규칙(왼쪽 아래)에 맞게 뒤집는다.
        const uv = data.uvs;
        for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i];
        jobs.push(imageToCanvas(img, (o.name || base) + '.png').then((t) => void (item.texture = t)));
      }
    });
    await Promise.all(jobs);
    return out;
  }
  if (ext === 'xyz' || ext === 'asc' || ext === 'pts' || ext === 'txt') {
    return [{ name: base, data: parseTextCloud(new TextDecoder().decode(file.data)), texture: null }];
  }
  throw new Error(`지원하지 않는 형식입니다: .${ext}`);
}
