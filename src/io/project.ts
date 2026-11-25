// 프로젝트 파일(.ssproj): "SSPROJ1\0" + JSON 길이(uint32) + JSON + 이어 붙인 바이너리 블록.
import type { MeshData } from '../geometry/mesh';
import type { ScanObject } from '../store';
import { canvasToPng } from './export';
import { canvasFromBytes } from './import';

const MAGIC = 'SSPROJ1\0';

interface BlobRef {
  o: number;
  n: number;
}

interface ObjectEntry {
  name: string;
  matrix: number[];
  visible: boolean;
  checked: boolean;
  color: string;
  positions: BlobRef;
  indices: BlobRef | null;
  normals: BlobRef | null;
  colors: BlobRef | null;
  uvs: BlobRef | null;
  texture: (BlobRef & { name: string }) | null;
}

export async function serializeProject(objects: ScanObject[]): Promise<Uint8Array> {
  const blobs: Uint8Array[] = [];
  let offset = 0;
  const put = (a: ArrayBufferView | ArrayBuffer | null): BlobRef | null => {
    if (!a) return null;
    const u8 = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ref = { o: offset, n: u8.byteLength };
    blobs.push(u8);
    // 4바이트 정렬
    const pad = (4 - (u8.byteLength % 4)) % 4;
    if (pad) blobs.push(new Uint8Array(pad));
    offset += u8.byteLength + pad;
    return ref;
  };
  const entries: ObjectEntry[] = [];
  for (const o of objects) {
    const tex = o.texture ? put(await canvasToPng(o.texture.canvas)) : null;
    entries.push({
      name: o.name,
      matrix: o.matrix,
      visible: o.visible,
      checked: o.checked,
      color: o.color,
      positions: put(o.data.positions)!,
      indices: put(o.data.indices),
      normals: put(o.data.normals),
      colors: put(o.data.colors),
      uvs: put(o.data.uvs),
      texture: tex ? { ...tex, name: o.texture!.name } : null,
    });
  }
  let json = new TextEncoder().encode(JSON.stringify({ version: 1, app: 'Depth Lidar', objects: entries }));
  const jpad = (4 - (json.length % 4)) % 4;
  if (jpad) {
    const j2 = new Uint8Array(json.length + jpad).fill(32);
    j2.set(json);
    json = j2;
  }
  const out = new Uint8Array(12 + json.length + offset);
  out.set(new TextEncoder().encode(MAGIC));
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, 12);
  let p = 12 + json.length;
  for (const b of blobs) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

export async function parseProject(buf: ArrayBuffer): Promise<Omit<ScanObject, 'id'>[]> {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
  if (head !== MAGIC) throw new Error('Depth Lidar 프로젝트 파일이 아닙니다.');
  const jl = new DataView(buf).getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jl))) as { objects: ObjectEntry[] };
  const base = 12 + jl;
  const f32 = (r: BlobRef | null) => (r ? new Float32Array(buf.slice(base + r.o, base + r.o + r.n)) : null);
  const out: Omit<ScanObject, 'id'>[] = [];
  for (const e of meta.objects) {
    const data: MeshData = {
      positions: f32(e.positions)!,
      indices: e.indices ? new Uint32Array(buf.slice(base + e.indices.o, base + e.indices.o + e.indices.n)) : null,
      normals: f32(e.normals),
      colors: f32(e.colors),
      uvs: f32(e.uvs),
    };
    const texture = e.texture ? await canvasFromBytes(buf.slice(base + e.texture.o, base + e.texture.o + e.texture.n), e.texture.name) : null;
    out.push({ name: e.name, matrix: e.matrix, visible: e.visible, checked: e.checked, color: e.color, data, texture });
  }
  return out;
}
