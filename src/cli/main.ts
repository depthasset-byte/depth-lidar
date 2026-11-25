/// <reference types="node" />
// Depth Lidar 명령줄 도구. 창을 띄우지 않고 파일을 읽어 처리한 뒤 파일로 쓴다.
// 창 프로그램과 같은 계산 코드(src/geometry, src/io)를 그대로 쓴다.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as rayNode from '../../electron/ray.cjs';
import { IDENTITY, Mat4, MeshData, bakeMatrix, bbox, mat4Multiply, mergeMeshes, triangleCount, vertexCount } from '../geometry/mesh';
import { ops } from '../geometry/ops';
import { ExportFormat, RawTexture, exportMesh } from '../io/export';
import { importFile } from '../io/import';
import type { PickedFile } from '../io/platform';
import { RayScanMeta, levelByFloor, rayBinToCloud, rayPointEstimate } from '../io/ray';
import { registerScans } from '../geometry/register';
import { ColorGrid, bakeTexture, buildAtlas } from '../geometry/texture';
import { CubeColor, decodeCubeColor, sampleCube } from '../io/rayColor';
import { RenderView, encodePng, renderViews } from './render';

const VERSION = '0.2.0';

class UsageError extends Error {}

// ───────── 인수 해석 ─────────
const FLAGS = new Set(['json', 'quiet', 'help', 'largest', 'laplacian', 'coarse', 'clean', 'no-level', 'no-refine', 'no-normals', 'no-color', 'tilt-transpose', 'no-floor-level', 'version']);

interface Args {
  pos: string[];
  opt: Record<string, string>;
  flag: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { pos: [], opt: {}, flag: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const key = eq > 0 ? t.slice(2, eq) : t.slice(2);
      if (FLAGS.has(key)) a.flag.add(key);
      else if (eq > 0) a.opt[key] = t.slice(eq + 1);
      else {
        if (i + 1 >= argv.length) throw new UsageError(`--${key} 뒤에 값이 필요합니다.`);
        a.opt[key] = argv[++i];
      }
    } else if (t === '-o') {
      if (i + 1 >= argv.length) throw new UsageError('-o 뒤에 출력 경로가 필요합니다.');
      a.opt.out = argv[++i];
    } else if (t === '-h') a.flag.add('help');
    else a.pos.push(t);
  }
  return a;
}

function num(a: Args, key: string, def: number): number {
  if (!(key in a.opt)) return def;
  const v = Number(a.opt[key]);
  if (!Number.isFinite(v)) throw new UsageError(`--${key} 값이 숫자가 아닙니다: ${a.opt[key]}`);
  return v;
}

function numList(text: string, count: number, what: string): number[] {
  const v = text.split(/[\s,]+/).filter(Boolean).map(Number);
  if (v.length !== count || v.some((x) => !Number.isFinite(x))) throw new UsageError(`${what}에는 숫자 ${count}개가 필요합니다.`);
  return v;
}

// ───────── 출력 ─────────
let jsonMode = false;
let quiet = false;
/** 사람이 읽는 진행 메시지. --json일 때는 표준 오류로 보내 표준 출력에는 JSON만 남긴다. */
function say(text: string) {
  if (quiet) return;
  if (jsonMode) process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}
const nf = (n: number) => n.toLocaleString('ko-KR');
const describe = (d: MeshData) => (d.indices ? `정점 ${nf(vertexCount(d))} · 면 ${nf(triangleCount(d))}` : `점 ${nf(vertexCount(d))}`);
const counts = (d: MeshData) => ({ vertices: vertexCount(d), triangles: triangleCount(d), pointCloud: !d.indices, colors: !!d.colors, uvs: !!d.uvs });

// ───────── 파일 읽기·쓰기 ─────────
interface Loaded {
  name: string;
  data: MeshData;
  /** OBJ에 딸린 원본 텍스처 파일. OBJ로 다시 쓸 때 그대로 함께 내보낸다. */
  raw: RawTexture | null;
}

const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const readOptional = (p: string) => fs.readFile(p).then(toArrayBuffer, () => null);

async function loadModel(file: string): Promise<Loaded> {
  const abs = path.resolve(file);
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (ext === 'ssproj') throw new Error('프로젝트 파일(.ssproj)은 명령줄에서 지원하지 않습니다. 창 프로그램에서 여세요.');
  if (ext === 'artec') throw new Error('project.artec은 ray-list / ray-import 명령으로 여세요.');
  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch (e) {
    throw new Error(`파일을 읽지 못했습니다: ${abs} (${(e as NodeJS.ErrnoException).code ?? e})`);
  }
  const picked: PickedFile = { name: path.basename(abs), data: toArrayBuffer(buf) };
  const pool: PickedFile[] = [picked];
  let raw: RawTexture | null = null;
  if (ext === 'obj') {
    // 딸린 MTL과 텍스처 파일을 찾는다. 화면이 없어 그림을 풀 수 없으므로 원본 파일째로 들고 다닌다.
    const dir = path.dirname(abs);
    const head = buf.subarray(0, 65536).toString('utf8');
    const mtlName = /^mtllib\s+(.+)$/m.exec(head)?.[1].trim() ?? path.basename(abs, path.extname(abs)) + '.mtl';
    const mtl = await readOptional(path.join(dir, mtlName));
    if (mtl) {
      const texName = /^\s*map_Kd\s+(?:.*\s)?(\S+)\s*$/im.exec(new TextDecoder().decode(mtl))?.[1];
      const tex = texName ? await readOptional(path.join(dir, texName)) : null;
      if (texName && tex) raw = { name: path.basename(texName), data: tex };
    }
  }
  const items = (await importFile(picked, pool)).filter((it) => it.data.positions.length > 0);
  if (!items.length) throw new Error(`내용이 비어 있습니다: ${abs}`);
  const data = items.length === 1 ? items[0].data : mergeMeshes(items.map((it) => ({ mesh: it.data, matrix: IDENTITY })));
  return { name: path.basename(abs, path.extname(abs)), data, raw: data.uvs ? raw : null };
}

async function saveModel(out: string, data: MeshData, raw: RawTexture | null = null): Promise<string[]> {
  const abs = path.resolve(out);
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (ext === 'glb' || ext === 'gltf') throw new Error('GLB 내보내기는 명령줄에서 지원하지 않습니다. OBJ·PLY·STL을 쓰세요.');
  if (ext !== 'obj' && ext !== 'ply' && ext !== 'stl') throw new Error(`출력 형식을 알 수 없습니다: ${out} (obj·ply·stl 가운데 하나)`);
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const files = await exportMesh(ext as ExportFormat, data, path.basename(abs, path.extname(abs)), null, ext === 'obj' ? raw : null);
  const written: string[] = [];
  for (const f of files) {
    const p = path.join(dir, f.name);
    await fs.writeFile(p, typeof f.data === 'string' ? f.data : f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data);
    written.push(p);
  }
  return written;
}

function need(a: Args, n: number, usage: string) {
  if (a.pos.length < n) throw new UsageError(`인수가 모자랍니다.\n사용법: depth-lidar ${usage}`);
}

/** <입력> <출력> 형태의 명령 공통 처리 */
async function inOut(a: Args, usage: string, fn: (m: Loaded) => Promise<{ mesh: MeshData; detail: Record<string, unknown>; text: string }>) {
  need(a, 2, usage);
  const src = await loadModel(a.pos[0]);
  say(`읽음: ${a.pos[0]} (${describe(src.data)})`);
  const r = await fn(src);
  const files = await saveModel(a.pos[1], r.mesh, src.raw);
  say(`${r.text}\n씀: ${files.join(', ')} (${describe(r.mesh)})`);
  return { input: counts(src.data), output: counts(r.mesh), ...r.detail, files };
}

// ───────── Ray II ─────────
const rayRootOf = async (p: string) => {
  const abs = path.resolve(p);
  const st = await fs.stat(abs).catch(() => null);
  if (!st) throw new Error(`경로를 찾지 못했습니다: ${abs}`);
  return st.isDirectory() ? abs : path.dirname(abs);
};

/** "1,3-5" 같은 번호 목록을 0부터 세는 번호 집합으로 바꾼다. */
function parseIndexList(text: string, max: number, what: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new UsageError(`${what} 번호를 읽지 못했습니다: ${part}`);
    const lo = Number(m[1]);
    const hi = Number(m[2] ?? m[1]);
    if (lo < 1 || hi > max || lo > hi) throw new UsageError(`${what} 번호는 1~${max} 사이여야 합니다: ${part}`);
    for (let i = lo; i <= hi; i++) out.add(i - 1);
  }
  return out;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '');

async function cmdRayList(a: Args) {
  need(a, 1, 'ray-list <project.artec 또는 폴더>');
  const res = await rayNode.scanRoot(await rayRootOf(a.pos[0]));
  if (!res.projects.some((p) => p.scans.length)) throw new Error('이 폴더에서 Ray II 스캔을 찾지 못했습니다.');
  say(res.root);
  res.projects.forEach((p, pi) => {
    say(`프로젝트 ${pi + 1}: ${p.name} (${p.folder || '.'}) · 스캔 ${p.scans.length}개`);
    p.scans.forEach((s, si) => say(`  ${String(si + 1).padStart(2)}. ${s.name}  ${nf(s.lines)} × ${nf(s.samples)}  ${s.resolution}  조각 ${s.sliceCount}개`));
  });
  return res;
}

/** 스캔의 컬러 파노라마를 읽는다. 없거나 읽지 못하면 null (밝기로 대신한다). */
async function loadCube(scanDir: string, exposure: number | null): Promise<CubeColor | null> {
  try {
    const c = await rayNode.readColor(scanDir);
    if (!c) return null;
    const cube = decodeCubeColor(c.data, c.matrix);
    if (exposure !== null && exposure > 0) cube.exposure = exposure;
    return cube;
  } catch (e) {
    say(`컬러 파노라마를 읽지 못해 밝기로 대신합니다: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 검토 그림: 스캔 하나의 컬러 파노라마를 펼친 그림(가로 360도, 세로 180도)으로 저장한다. */
async function cmdRayPano(a: Args) {
  need(a, 1, 'ray-pano <project.artec 또는 폴더> --out <그림.png> [--project 1] [--scan 1] [--width 2000] [--exposure e]');
  if (!a.opt.out) throw new UsageError('--out <그림.png>가 필요합니다.');
  const res = await rayNode.scanRoot(await rayRootOf(a.pos[0]));
  const proj = res.projects[Math.round(num(a, 'project', 1)) - 1];
  const scan = proj?.scans[Math.round(num(a, 'scan', 1)) - 1];
  if (!scan) throw new Error('그 번호의 프로젝트·스캔이 없습니다.');
  const cube = await loadCube(scan.dir, a.opt.exposure ? num(a, 'exposure', 1) : null);
  if (!cube) throw new Error('이 스캔에는 컬러 파노라마가 없습니다.');
  const width = Math.round(num(a, 'width', 2000));
  const height = Math.round(width / 2);
  const rgb = new Uint8Array(width * height * 3);
  const px = new Float32Array(3);
  for (let y = 0; y < height; y++) {
    const pol = ((y + 0.5) / height) * Math.PI;
    for (let x = 0; x < width; x++) {
      // 왼쪽에서 오른쪽으로 갈수록 시계 방향(위에서 볼 때)으로 돌아야 안에서 본 모습이 된다
      const az = Math.PI - ((x + 0.5) / width) * 2 * Math.PI;
      if (!sampleCube(cube, Math.sin(pol) * Math.cos(az), Math.sin(pol) * Math.sin(az), Math.cos(pol), px, 0)) continue;
      const k = (y * width + x) * 3;
      rgb[k] = Math.round(px[0] * 255);
      rgb[k + 1] = Math.round(px[1] * 255);
      rgb[k + 2] = Math.round(px[2] * 255);
    }
  }
  const out = path.resolve(a.opt.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, encodePng(width, height, rgb));
  say(`파노라마: ${out} (${width}×${height}, 노출 ${cube.exposure.toFixed(2)}, 면 ${Object.keys(cube.faces).join(' ')})`);
  return { file: out, width, height, exposure: cube.exposure, faces: Object.keys(cube.faces) };
}

async function cmdRayImport(a: Args) {
  need(a, 1, 'ray-import <project.artec 또는 폴더> --out <폴더> [--project N] [--scans 1,3-5] [--step 8] [--max-range 60] [--no-level] [--format ply|obj]');
  if (!a.opt.out) throw new UsageError('--out <폴더>가 필요합니다.');
  const format = (a.opt.format ?? 'ply').toLowerCase();
  if (format !== 'ply' && format !== 'obj') throw new UsageError('--format은 ply 또는 obj입니다.');
  const step = Math.round(num(a, 'step', 8));
  if (step < 1 || step > 64) throw new UsageError('--step은 1~64 사이입니다.');
  const maxRange = num(a, 'max-range', 0);
  let exposure = a.opt.exposure ? num(a, 'exposure', 1) : null;
  const res = await rayNode.scanRoot(await rayRootOf(a.pos[0]));
  let projects = res.projects.map((p, index) => ({ p, index }));
  if (a.opt.project) {
    const want = parseIndexList(a.opt.project, res.projects.length, '프로젝트');
    projects = projects.filter((x) => want.has(x.index));
  }
  const jobs: { project: string; pi: number; si: number; scan: RayScanMeta }[] = [];
  for (const { p, index } of projects) {
    const want = a.opt.scans ? parseIndexList(a.opt.scans, p.scans.length, `${p.name}의 스캔`) : null;
    p.scans.forEach((scan, si) => {
      if (!want || want.has(si)) jobs.push({ project: p.name, pi: index, si, scan });
    });
  }
  if (!jobs.length) throw new Error('불러올 스캔이 없습니다.');
  const outDir = path.resolve(a.opt.out);
  const helperDir = path.dirname(path.resolve(process.argv[1]));
  say(`스캔 ${jobs.length}개 · ${step}칸마다 1점 · 약 ${nf(jobs.reduce((s, j) => s + rayPointEstimate(j.scan, step), 0))}점 → ${outDir}`);
  if (exposure === null && !a.flag.has('no-color')) {
    // 스캔마다 자동 노출을 따로 쓰면 스캔 사이에 색 밝기가 어긋난다. 프로젝트 전체의 중앙값 하나로 통일한다.
    const exps: number[] = [];
    for (const j of jobs) {
      const c = await loadCube(j.scan.dir, null);
      if (c) exps.push(c.exposure);
    }
    exps.sort((x, y) => x - y);
    if (exps.length) {
      exposure = exps[Math.floor(exps.length / 2)];
      say(`공통 노출 ${exposure.toFixed(1)} (스캔별 자동 노출 ${exps[0].toFixed(0)}~${exps[exps.length - 1].toFixed(0)}의 중앙값)`);
    }
  }
  const results: Record<string, unknown>[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const t0 = Date.now();
    const dec = await rayNode.decodeScan(j.scan.dir, step, step, null, helperDir);
    const cube = a.flag.has('no-color') ? null : await loadCube(j.scan.dir, exposure);
    // 법선은 정합·퓨전에 쓰인다. 법선을 구할 수 없는 가장자리·튀는 점은 함께 걸러진다.
    const cloud = rayBinToCloud(dec.data, dec.meta, { level: !a.flag.has('no-level'), maxRange: maxRange > 0 ? maxRange : undefined, normals: !a.flag.has('no-normals'), color: cube, tiltDirect: !a.flag.has('tilt-transpose') });
    // 기울기 센서 보정 뒤에 남는 바닥 기울기를 바닥 평면으로 다시 바로잡는다 (스캔끼리 정합할 때 계통 오차를 줄임)
    const lv = a.flag.has('no-floor-level') || !cloud.kept ? { tiltDeg: 0, used: 0 } : levelByFloor(cloud.data);
    if (!cloud.kept) {
      say(`[${i + 1}/${jobs.length}] ${j.project} · ${j.scan.name}: 쓸 수 있는 점이 없어 건너뜁니다.`);
      continue;
    }
    const file = path.join(outDir, `${safeName(j.project)}_${safeName(j.scan.name)}.${format}`);
    const files = await saveModel(file, cloud.data);
    const b = bbox(cloud.data.positions);
    say(`[${i + 1}/${jobs.length}] ${j.project} · ${j.scan.name}: 점 ${nf(cloud.kept)}${cube ? ` · 컬러(노출 ${cube.exposure.toFixed(2)})` : ' · 밝기만'}${lv.used ? ` · 바닥 보정 ${lv.tiltDeg.toFixed(2)}도` : ''} → ${files[0]} (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    results.push({ color: !!cube, exposure: cube?.exposure ?? null, project: j.project, projectIndex: j.pi + 1, scan: j.scan.name, scanIndex: j.si + 1, points: cloud.kept, file: files[0], min: b.min, max: b.max });
  }
  return { root: res.root, step, unit: 'mm', scans: results };
}

// ───────── 일반 명령 ─────────
async function cmdInfo(a: Args) {
  need(a, 1, 'info <파일>');
  const m = await loadModel(a.pos[0]);
  const b = bbox(m.data.positions);
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const out: Record<string, unknown> = { file: path.resolve(a.pos[0]), ...counts(m.data), texture: m.raw?.name ?? null, min: b.min, max: b.max, size };
  say(`${a.pos[0]}: ${describe(m.data)}${m.data.colors ? ' · 정점 색' : ''}${m.raw ? ` · 텍스처 ${m.raw.name}` : ''}`);
  say(`크기 ${size.map((v) => v.toFixed(2)).join(' × ')}  (최소 ${b.min.map((v) => v.toFixed(2)).join(', ')} / 최대 ${b.max.map((v) => v.toFixed(2)).join(', ')})`);
  if (!m.data.indices && m.data.normals) {
    // 수평 점검: 위를 보는 면(바닥)의 평균 법선이 수직에서 얼마나 기울었는지
    const nr = m.data.normals;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (let i = 0; i < nr.length; i += 3) {
      if (nr[i + 1] > 0.97) { sx += nr[i]; sy += nr[i + 1]; sz += nr[i + 2]; cnt++; }
    }
    if (cnt > 1000) {
      const tilt = (Math.atan2(Math.hypot(sx, sz), sy) * 180) / Math.PI;
      Object.assign(out, { floorTiltDeg: tilt, floorTiltDir: [sx / cnt, sz / cnt] });
      say(`바닥 기울기 ${tilt.toFixed(3)}도 (위를 보는 점 ${nf(cnt)}개의 평균 법선)`);
    }
  }
  if (m.data.indices) {
    const info = ops.meshInfo({ mesh: m.data, matrix: IDENTITY });
    const loops = ops.findHoles({ mesh: m.data });
    Object.assign(out, { area: info.area, volume: info.volume, closed: info.closed, boundaryEdges: info.boundaryEdges, holes: loops.length });
    say(`표면적 ${info.area.toFixed(2)} · 부피 ${info.volume.toFixed(2)} · ${info.closed ? '닫힌 메시' : `열린 메시 (경계 ${loops.length}개, 경계 간선 ${nf(info.boundaryEdges)}개)`}`);
  }
  return out;
}

function buildMatrix(a: Args): Mat4 {
  let m: Mat4 = IDENTITY.slice();
  if (a.opt.scale) {
    const s = num(a, 'scale', 1);
    m = mat4Multiply([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1], m);
  }
  if (a.opt.rotate) {
    // "축,각도" 예: y,90
    const mm = /^([xyz])\s*,\s*(-?[\d.]+)$/i.exec(a.opt.rotate.trim());
    if (!mm) throw new UsageError('--rotate는 "축,각도" 형식입니다. 예: --rotate y,90');
    const t = (Number(mm[2]) * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const axis = mm[1].toLowerCase();
    const r: Mat4 = axis === 'x' ? [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1] : axis === 'y' ? [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1] : [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    m = mat4Multiply(r, m);
  }
  if (a.opt.translate) {
    const t = numList(a.opt.translate, 3, '--translate');
    m = mat4Multiply([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1], m);
  }
  if (a.opt.matrix) m = mat4Multiply(numList(a.opt.matrix, 16, '--matrix'), m);
  return m;
}

async function readMatrixFile(file: string): Promise<Mat4> {
  const j = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
  const m = Array.isArray(j) ? j : j.matrix;
  if (!Array.isArray(m) || m.length !== 16 || m.some((v) => typeof v !== 'number')) throw new Error(`행렬 파일에 숫자 16개(열 우선)가 필요합니다: ${file}`);
  return m;
}

async function cmdAlign(a: Args) {
  need(a, 3, 'align <움직일 파일> <기준 파일> <출력> [--coarse] [--max-distance d] [--iterations n] [--samples n] [--initial 행렬.json] [--matrix-out 행렬.json]');
  const moving = await loadModel(a.pos[0]);
  const fixed = await loadModel(a.pos[1]);
  say(`움직일 것: ${a.pos[0]} (${describe(moving.data)})\n기준: ${a.pos[1]} (${describe(fixed.data)})`);
  let srcMatrix: Mat4 = IDENTITY.slice();
  if (a.opt.initial) srcMatrix = await readMatrixFile(a.opt.initial);
  const opts = { maxIterations: a.opt.iterations ? num(a, 'iterations', 60) : undefined, samples: a.opt.samples ? num(a, 'samples', 15000) : undefined, maxDistance: a.opt['max-distance'] ? num(a, 'max-distance', 0) : undefined };
  let matrix = srcMatrix;
  const steps: Record<string, unknown>[] = [];
  if (a.flag.has('coarse')) {
    const r = ops.align({ src: moving.data, srcMatrix: matrix, dst: fixed.data, dstMatrix: IDENTITY, mode: 'coarse', opts });
    matrix = r.newMatrix;
    steps.push({ mode: 'coarse', rms: r.rms, initialRms: r.initialRms });
    say(`거친 정렬: 오차 RMS ${r.initialRms.toFixed(3)} → ${r.rms.toFixed(3)}`);
  }
  const r = ops.align({ src: moving.data, srcMatrix: matrix, dst: fixed.data, dstMatrix: IDENTITY, mode: 'icp', opts });
  matrix = r.newMatrix;
  steps.push({ mode: 'icp', rms: r.rms, initialRms: r.initialRms, iterations: r.iterations, pairs: r.pairs, samples: r.samples });
  say(`정밀 정렬: 오차 RMS ${r.initialRms.toFixed(3)} → ${r.rms.toFixed(3)} (${r.iterations}회 반복, 대응 ${nf(r.pairs)}/${nf(r.samples)})`);
  const files = await saveModel(a.pos[2], bakeMatrix(moving.data, matrix), moving.raw);
  if (a.opt['matrix-out']) {
    const p = path.resolve(a.opt['matrix-out']);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ matrix, order: 'column-major', rms: r.rms }, null, 2));
    files.push(p);
  }
  say(`씀: ${files.join(', ')}`);
  return { rms: r.rms, initialRms: steps[0].initialRms, matrix, steps, files };
}

/** 라이다 스캔 여러 장을 자동으로 정합한다. 첫 파일이 기준 좌표가 된다. */
async function cmdRegister(a: Args) {
  need(a, 2, 'register <스캔1> <스캔2> […] --out <폴더> [--cell 200] [--candidates 12]');
  if (!a.opt.out) throw new UsageError('--out <폴더>가 필요합니다.');
  const outDir = path.resolve(a.opt.out);
  const loaded: Loaded[] = [];
  for (const f of a.pos) {
    const m = await loadModel(f);
    if (!m.data.normals) throw new Error(`법선이 없는 파일입니다: ${f}. ray-import로 만든 PLY(법선 포함)를 쓰세요.`);
    say(`읽음: ${f} (${describe(m.data)})`);
    loaded.push(m);
  }
  const t0 = Date.now();
  const r = registerScans(loaded.map((m) => ({ positions: m.data.positions, normals: m.data.normals! })), { cell: num(a, 'cell', 200), candidates: Math.round(num(a, 'candidates', 12)), log: say });
  const scans: Record<string, unknown>[] = [];
  const files: string[] = [];
  for (let i = 0; i < loaded.length; i++) {
    const m = r.matrices[i];
    const link = r.links.find((l) => l.child === i);
    if (!m) {
      say(`${i + 1}. ${loaded[i].name}: 이어 붙이지 못했습니다 (겹치는 스캔을 찾지 못함).`);
      scans.push({ index: i + 1, name: loaded[i].name, registered: false });
      continue;
    }
    const out = await saveModel(path.join(outDir, `${loaded[i].name}_reg.ply`), bakeMatrix(loaded[i].data, m));
    files.push(out[0]);
    scans.push({ index: i + 1, name: loaded[i].name, registered: true, file: out[0], matrix: m, parent: link ? link.parent + 1 : null, linkScore: link?.score ?? null, rms: r.finalRms[i] });
    say(`${i + 1}. ${loaded[i].name}: ${i === 0 ? '기준' : `스캔 ${link!.parent + 1}에 연결 (점수 ${link!.score.toFixed(3)}), 오차 ${r.finalRms[i]?.toFixed(1) ?? '-'}mm`} → ${out[0]}`);
  }
  const report = { unit: 'mm', order: 'column-major', seconds: (Date.now() - t0) / 1000, scans, pairs: r.pairs.map((p) => ({ a: p.a + 1, b: p.b + 1, score: p.score, agree: p.agree, violate: p.violate, rms: p.rms, matrix: p.matrix })) };
  const reportFile = path.join(outDir, 'register.json');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  const placed = r.matrices.filter(Boolean).length;
  say(`정합: ${loaded.length}개 중 ${placed}개 연결 (${report.seconds.toFixed(0)}초). 보고서 ${reportFile}`);
  return { registered: placed, total: loaded.length, report: reportFile, files, scans };
}

/** 검토 그림: 입력들을 한 장에 겹쳐 그린다. */
async function cmdRender(a: Args) {
  need(a, 1, 'render <입력…> --out <그림.png> [--view top|front|side] [--size 1400] [--clip-above y] [--clip-below y] [--color scan|own]');
  if (!a.opt.out) throw new UsageError('--out <그림.png>가 필요합니다.');
  const view = (a.opt.view ?? 'top') as RenderView;
  if (!['top', 'front', 'side'].includes(view)) throw new UsageError('--view는 top·front·side 가운데 하나입니다.');
  const items: MeshData[] = [];
  for (const f of a.pos) items.push((await loadModel(f)).data);
  const r = renderViews(items, { view, size: Math.round(num(a, 'size', 1400)), clipAbove: a.opt['clip-above'] ? num(a, 'clip-above', 0) : undefined, clipBelow: a.opt['clip-below'] ? num(a, 'clip-below', 0) : undefined, color: a.opt.color === 'own' ? 'own' : 'scan' });
  const out = path.resolve(a.opt.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, encodePng(r.width, r.height, r.rgb));
  say(`그림: ${out} (${r.width}×${r.height}, 1화소 = ${(1 / r.scale).toFixed(1)})`);
  return { file: out, width: r.width, height: r.height, unitsPerPixel: 1 / r.scale };
}

async function cmdFuse(a: Args) {
  need(a, 1, 'fuse <입력…> --out <출력> [--voxel v] [--clean]');
  if (!a.opt.out) throw new UsageError('--out <출력 파일>이 필요합니다.');
  const items = [];
  for (const f of a.pos) {
    const m = await loadModel(f);
    say(`읽음: ${f} (${describe(m.data)})`);
    items.push({ mesh: m.data, matrix: IDENTITY });
  }
  const r = ops.fuse({ items, opts: { voxel: num(a, 'voxel', 0) } });
  let mesh = r.mesh;
  if (!triangleCount(mesh)) throw new Error('결과 메시가 비었습니다. --voxel 값을 키워 보세요.');
  let removed = 0;
  if (a.flag.has('clean')) {
    const c = ops.removeSmall({ mesh, opts: { mode: 'threshold', minTriangles: Math.round(num(a, 'min-triangles', 200)) } });
    mesh = c.mesh;
    removed = c.removedComponents;
  }
  const files = await saveModel(a.opt.out, mesh);
  say(`퓨전: 입력 ${items.length}개 → ${describe(mesh)} (해상도 ${r.voxel.toFixed(3)}, 표본 ${nf(r.samples)}개${removed ? `, 작은 조각 ${nf(removed)}개 제거` : ''})\n씀: ${files.join(', ')}`);
  return { inputs: items.length, voxel: r.voxel, samples: r.samples, removedComponents: removed, output: counts(mesh), files };
}

async function cmdMerge(a: Args) {
  need(a, 1, 'merge <입력…> --out <출력>');
  if (!a.opt.out) throw new UsageError('--out <출력 파일>이 필요합니다.');
  const items = [];
  for (const f of a.pos) items.push({ mesh: (await loadModel(f)).data, matrix: IDENTITY });
  const mesh = mergeMeshes(items);
  const files = await saveModel(a.opt.out, mesh);
  say(`합침: 입력 ${items.length}개 → ${describe(mesh)}\n씀: ${files.join(', ')}`);
  return { inputs: items.length, output: counts(mesh), files };
}

// ───────── 텍스처 굽기 ─────────
/** 메시에 UV 아틀라스를 짜고, 점군의 색을 텍스처(정사각형 PNG)로 구워 OBJ+MTL+PNG로 쓴다. */
async function cmdBake(a: Args) {
  need(a, 1, 'bake <메시> --points-dir <점군 폴더> --out <출력.obj> [--size 8192] [--texel mm] [--cell mm]');
  if (!a.opt.out) throw new UsageError('--out <출력.obj>가 필요합니다.');
  if (!a.opt['points-dir']) throw new UsageError('--points-dir <색을 가져올 점군(.ply)이 든 폴더>가 필요합니다.');
  if (path.extname(a.opt.out).toLowerCase() !== '.obj') throw new UsageError('텍스처는 OBJ로만 내보냅니다. --out은 .obj여야 합니다.');
  const size = Math.round(num(a, 'size', 8192));
  if (![2048, 4096, 8192, 16384].includes(size)) throw new UsageError('--size는 2048·4096·8192·16384 가운데 하나입니다.');
  const mesh = await loadModel(a.pos[0]);
  if (!mesh.data.indices) throw new Error('bake는 메시에만 쓸 수 있습니다. 먼저 fuse로 메시를 만드세요.');
  say(`읽음: ${a.pos[0]} (${describe(mesh.data)})`);

  const dir = path.resolve(a.opt['points-dir']);
  const names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.ply')).sort();
  if (!names.length) throw new Error(`점군 파일(.ply)이 없습니다: ${dir}`);
  const clouds: MeshData[] = [];
  let total = 0;
  for (const n of names) {
    const m = await loadModel(path.join(dir, n));
    if (m.data.indices || !m.data.colors) {
      say(`건너뜀(색이 있는 점군이 아님): ${n}`);
      continue;
    }
    clouds.push(m.data);
    total += vertexCount(m.data);
    say(`점군: ${n} (점 ${nf(vertexCount(m.data))})`);
  }
  if (!clouds.length) throw new Error('색이 있는 점군이 없습니다. ray-import를 --no-color 없이 실행했는지 확인하세요.');

  const area = ops.meshInfo({ mesh: mesh.data, matrix: IDENTITY }).area;
  const texel = a.opt.texel ? num(a, 'texel', 10) : Math.max(2, Math.sqrt(area / (size * size * 0.55)));
  const cell = num(a, 'cell', 40);
  const pow = Math.max(18, Math.min(25, Math.ceil(Math.log2(Math.max(1, total) * 0.8))));
  const t0 = Date.now();
  const grid = new ColorGrid(cell, pow);
  for (const c of clouds) {
    if (!grid.add(c.positions, c.colors!)) say('경고: 색 격자가 가득 차 일부 점을 버렸습니다. --cell 값을 키워 보세요.');
  }
  say(`색 격자: 칸 ${cell}mm · 사용한 칸 ${nf(grid.occupied)}개`);

  const atlas = buildAtlas(mesh.data, { texelMm: texel, maxSize: size, minSize: size });
  // 납품 규약은 정사각형 텍스처다. 아래가 남으면 v 좌표를 줄여 정사각형에 맞춘다.
  if (atlas.height < atlas.width) {
    const k = atlas.height / atlas.width;
    const uv = atlas.mesh.uvs!;
    for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - (1 - uv[i]) * k;
    atlas.height = atlas.width;
  }
  say(`아틀라스: ${atlas.width}×${atlas.height}, 조각 ${nf(atlas.charts)}개, 텍셀 ${atlas.texelMm.toFixed(2)}mm, 채움 ${(atlas.fill * 100).toFixed(0)}%, 방 방향 ${atlas.roomAngleDeg.toFixed(1)}도`);
  const r = bakeTexture(atlas, grid);
  const png = encodePng(atlas.width, atlas.height, r.rgb);
  const out = path.resolve(a.opt.out);
  const base = path.basename(out, '.obj');
  const files = await saveModel(out, atlas.mesh, { name: `${base}.png`, data: png });
  say(`굽기: 점군에서 ${nf(r.fromPoints)}개 · 정점 색으로 ${nf(r.fromVertex)}개 · 이웃으로 메움 ${nf(r.filled)}개 (${((Date.now() - t0) / 1000).toFixed(0)}초)\n씀: ${files.join(', ')}`);
  return { width: atlas.width, height: atlas.height, charts: atlas.charts, texelMm: atlas.texelMm, fill: atlas.fill, fromPoints: r.fromPoints, fromVertex: r.fromVertex, filled: r.filled, files };
}

// ───────── 마야 규격 맞춤과 한 번에 묶기 ─────────
const LIDAR_TOOLS_DEFAULT = 'C:\\Users\\depth_09\\Documents\\Ai\\Lidar';

/** 기존 파이썬 도구(lidar_finalize.py, lidar_check.py)를 실행한다. */
function runPython(script: string, args: string[]): Promise<{ code: number; out: string }> {
  const root = process.env.DEPTH_LIDAR_TOOLS ?? LIDAR_TOOLS_DEFAULT;
  const py = process.env.DEPTH_LIDAR_PYTHON ?? path.join(root, '.venv', 'Scripts', 'python.exe');
  return new Promise((resolve, reject) => {
    const p = spawn(py, [path.join(root, 'tools', script), ...args], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.on('error', (e) => reject(new Error(`파이썬을 실행하지 못했습니다: ${py} (${e.message}). 환경 변수 DEPTH_LIDAR_PYTHON으로 경로를 지정하세요.`)));
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith(suffix)).sort().map((n) => path.join(dir, n));
}

/** 결과 메시를 마야 규격(바닥 Y=0, 정면·중심, 크기, 이름)으로 맞춰 업체 폴더에 쓰고 검사한다. */
async function cmdFinalize(a: Args) {
  need(a, 1, 'finalize <텍스처 OBJ> --out <폴더> --name <라이다명> [--vendor digitalidea] [--front 0] [--up y]');
  if (!a.opt.out || !a.opt.name) throw new UsageError('--out <폴더>와 --name <라이다명>이 필요합니다.');
  const vendor = a.opt.vendor ?? 'digitalidea';
  const out = path.resolve(a.opt.out);
  const report = path.join(path.dirname(out), `${a.opt.name}_finalize.json`);
  const fin = await runPython('lidar_finalize.py', ['run', path.resolve(a.pos[0]), '--out', out, '--name', a.opt.name, '--vendor', vendor, '--up', a.opt.up ?? 'y', '--floor', a.opt.floor ?? 'hist', '--front', String(num(a, 'front', 0)), '--report', report]);
  if (fin.code !== 0) throw new Error(`규격 맞춤에 실패했습니다.\n${fin.out}`);
  say(`규격 맞춤 완료 → ${out}`);
  const chk = await runPython('lidar_check.py', [out, '--name', a.opt.name, '--vendor', vendor, '--report', path.join(path.dirname(out), `${a.opt.name}_check.json`)]);
  say(chk.out.trim());
  const pass = /RESULT:\s*PASS/.test(chk.out);
  return { out, vendor, pass, finalizeReport: report, check: chk.out.trim().split('\n') };
}

/** ray-import → register → fuse → clean → simplify → bake → finalize → check 를 한 번에 돌린다. */
async function cmdPipeline(a: Args) {
  need(a, 1, 'pipeline <project.artec|폴더> --project N --name <라이다명> --out <작업폴더> [--step 16] [--voxel 60] [--triangles 300000] [--size 8192] [--cell mm] [--vendor digitalidea] [--front 0]');
  if (!a.opt.out || !a.opt.name || !a.opt.project) throw new UsageError('--project N, --name <라이다명>, --out <작업폴더>가 필요합니다.');
  const work = path.resolve(a.opt.out);
  const name = a.opt.name;
  const step = Math.round(num(a, 'step', 16));
  const d = { scans: path.join(work, '01_scans'), reg: path.join(work, '02_registered'), mesh: path.join(work, '03_mesh'), tex: path.join(work, '04_textured'), final: path.join(work, `05_final`, name) };
  const t0 = Date.now();
  const stage = (n: number, t: string) => say(`\n=== ${n}/7 ${t} ===`);
  const common = a.flag.has('json') ? ['--json'] : [];

  stage(1, '스캔 불러오기 (점군 변환)');
  const imp = (await cmdRayImport(parseArgs([a.pos[0], '--out', d.scans, '--project', a.opt.project, '--step', String(step), ...(a.opt.scans ? ['--scans', a.opt.scans] : [])])));
  const scanFiles = imp.scans.map((s) => String(s.file));
  if (!scanFiles.length) throw new Error('불러온 스캔이 없습니다.');

  stage(2, '자동 정합');
  let regFiles = scanFiles;
  let regDir = d.scans;
  if (scanFiles.length > 1) {
    await cmdRegister(parseArgs([...scanFiles, '--out', d.reg]));
    regFiles = await listFiles(d.reg, '_reg.ply');
    regDir = d.reg;
  } else say('스캔이 1개라 정합을 건너뜁니다.');

  stage(3, '퓨전과 작은 조각 제거');
  const fused = path.join(d.mesh, `${name}_fused.ply`);
  await cmdFuse(parseArgs([...regFiles, '--out', fused, '--voxel', String(num(a, 'voxel', 0)), '--clean']));

  stage(4, '단순화');
  const simple = path.join(d.mesh, `${name}_simplified.ply`);
  const fm = await loadModel(fused);
  const target = Math.round(num(a, 'triangles', 300000));
  const sr = triangleCount(fm.data) > target ? await ops.simplify({ mesh: fm.data, targetTriangles: target }) : null;
  await saveModel(simple, sr ? sr.mesh : fm.data);
  say(sr ? `단순화: 면 ${nf(sr.before)} → ${nf(sr.after)}` : `면이 ${nf(triangleCount(fm.data))}개라 단순화를 건너뜁니다.`);

  stage(5, '텍스처 굽기');
  const raw = path.join(d.tex, `${name}.obj`);
  const bake = await cmdBake(parseArgs([simple, '--points-dir', regDir, '--out', raw, '--size', String(num(a, 'size', 8192)), '--cell', String(num(a, 'cell', Math.max(20, step * 3.5)))]));

  stage(6, '마야 규격 맞춤과 검사');
  const fin = await cmdFinalize(parseArgs([raw, '--out', d.final, '--name', name, ...(a.opt.vendor ? ['--vendor', a.opt.vendor] : []), ...(a.opt.front ? ['--front', a.opt.front] : [])]));

  stage(7, '요약');
  const seconds = (Date.now() - t0) / 1000;
  const summary = { name, work, seconds, scans: scanFiles.length, step, texture: bake, final: fin };
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, `${name}_pipeline.json`), JSON.stringify(summary, null, 2));
  say(`끝: ${seconds.toFixed(0)}초 · 납품 폴더 ${d.final} · 검사 ${fin.pass ? '통과' : '실패(위 항목 확인)'}`);
  void common;
  return summary;
}

async function cmdGui() {
  // Electron 실행 파일을 Node 모드로 돌리고 있을 때는 같은 실행 파일을 창 모드로 다시 띄운다.
  let exe = process.versions.electron ? process.execPath : null;
  if (!exe) {
    const guess = path.resolve(path.dirname(path.resolve(process.argv[1])), '..', 'release', 'Depth Lidar-win32-x64', 'Depth Lidar.exe');
    if (await fs.stat(guess).then(() => true, () => false)) exe = guess;
  }
  if (!exe) throw new Error('창 프로그램 실행 파일을 찾지 못했습니다. scripts\\build.ps1로 먼저 빌드하세요.');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, [], { detached: true, stdio: 'ignore', env }).unref();
  say(`창 프로그램을 열었습니다: ${exe}`);
  return { started: exe };
}

const HELP = `Depth Lidar 명령줄 도구 ${VERSION}

사용법: depth-lidar <명령> [인수] [옵션]

Artec Ray II 원본
  ray-list   <project.artec|폴더>                 프로젝트·스캔 목록
  ray-import <project.artec|폴더> --out <폴더>    스캔을 점군 파일로 변환 (스캔마다 파일 하나, 단위 mm)
             [--project 1] [--scans 1,3-5] [--step 8] [--max-range 60] [--no-level] [--format ply|obj]
             [--no-color] [--exposure e] [--no-normals]
  ray-pano   <project.artec|폴더> --out <그림.png> [--project 1] [--scan 1] [--width 2000]   컬러 파노라마 검토 그림

살펴보기·변환
  info       <파일>                                점·면 개수, 크기, 표면적·부피, 구멍 수
  convert    <입력> <출력>                         형식 변환 (obj·ply·stl)
  transform  <입력> <출력> [--scale s] [--rotate y,90] [--translate x,y,z] [--matrix "숫자 16개(열 우선)"]
  merge      <입력…> --out <출력>                  여러 파일을 그대로 하나로 합침
  render     <입력…> --out <그림.png>              검토 그림 (입력마다 다른 색으로 겹쳐 그림)
             [--view top|front|side] [--size 1400] [--clip-above y] [--clip-below y] [--color scan|own]

메시 편집
  clean      <입력> <출력> [--largest | --min-triangles 200]   떨어진 작은 조각 제거
  fill-holes <입력> <출력> [--max-edges 100] [--no-refine]     구멍 메우기
  smooth     <입력> <출력> [--iterations 3] [--strength 0.5] [--laplacian]
  simplify   <입력> <출력> (--percent 50 | --triangles 200000)

정렬·합치기
  register   <스캔1> <스캔2> […] --out <폴더>      라이다 스캔 자동 정합 (첫 파일이 기준, ray-import 결과를 넣음)
             [--cell 200] [--candidates 12]
  align     <움직일 파일> <기준 파일> <출력> [--coarse] [--max-distance d] [--iterations n]
             [--samples n] [--initial 행렬.json] [--matrix-out 행렬.json]
  fuse       <입력…> --out <출력> [--voxel v] [--clean] [--min-triangles 200]

텍스처·납품 (자체 방식: 방 방향 상자 투영 UV + 점군 색 굽기. 아르텍과 같은 알고리즘이 아님)
  bake       <메시> --points-dir <점군 폴더> --out <출력.obj>   UV를 짜고 점군 색을 정사각형 텍스처로 굽기
             [--size 8192] [--texel mm] [--cell mm]
  finalize   <텍스처 OBJ> --out <폴더> --name <라이다명>        마야 규격 맞춤(바닥 Y=0·중심·크기·이름) + 검사
             [--vendor digitalidea] [--front 0] [--up y] [--floor hist|ransac]   (Ai\\Lidar\\tools의 파이썬 도구 사용)
  pipeline   <project.artec|폴더> --project N --name <라이다명> --out <작업폴더>
             [--scans 1,3-5] [--step 16] [--voxel 60] [--triangles 300000] [--size 8192] [--cell mm] [--vendor ...] [--front 0]
             불러오기 → 정합 → 퓨전 → 단순화 → 텍스처 → 규격 맞춤 → 검사를 한 번에 실행

기타
  gui                                              창 프로그램 열기
  help, version

공통 옵션
  --json     결과를 JSON 한 줄로 표준 출력에 씀 (진행 메시지는 표준 오류로)
  --quiet    진행 메시지 숨김

읽기: obj · ply · stl · xyz/asc/pts (glb는 텍스처가 없을 때만)   쓰기: obj · ply · stl
끝난 코드: 0 성공, 1 실행 오류, 2 사용법 오류`;

async function run(argv: string[]): Promise<unknown> {
  const cmd = argv[0];
  const a = parseArgs(argv.slice(1));
  jsonMode = a.flag.has('json');
  quiet = a.flag.has('quiet');
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || a.flag.has('help')) {
    process.stdout.write(HELP + '\n');
    return undefined;
  }
  switch (cmd) {
    case 'version':
    case '--version':
      process.stdout.write(VERSION + '\n');
      return undefined;
    case 'ray-list':
      return cmdRayList(a);
    case 'ray-import':
      return cmdRayImport(a);
    case 'ray-pano':
      return cmdRayPano(a);
    case 'info':
      return cmdInfo(a);
    case 'convert':
      return inOut(a, 'convert <입력> <출력>', async (m) => ({ mesh: m.data, detail: {}, text: '변환' }));
    case 'transform': {
      const matrix = buildMatrix(a);
      return inOut(a, 'transform <입력> <출력> [--scale s] [--rotate y,90] [--translate x,y,z] [--matrix …]', async (m) => ({ mesh: bakeMatrix(m.data, matrix), detail: { matrix }, text: '변환 적용 (순서: 크기 → 회전 → 이동 → 행렬)' }));
    }
    case 'clean':
      return inOut(a, 'clean <입력> <출력> [--largest | --min-triangles 200]', async (m) => {
        if (!m.data.indices) throw new Error('clean은 메시에만 쓸 수 있습니다 (점군에는 면이 없음).');
        const r = ops.removeSmall({ mesh: m.data, opts: { mode: a.flag.has('largest') ? 'largest' : 'threshold', minTriangles: Math.round(num(a, 'min-triangles', 200)) } });
        return { mesh: r.mesh, detail: { components: r.components, removedComponents: r.removedComponents, removedTriangles: r.removedTriangles }, text: `조각 ${nf(r.components)}개 중 ${nf(r.removedComponents)}개 제거 (면 ${nf(r.removedTriangles)}개)` };
      });
    case 'fill-holes':
      return inOut(a, 'fill-holes <입력> <출력> [--max-edges 100] [--no-refine]', async (m) => {
        if (!m.data.indices) throw new Error('fill-holes는 메시에만 쓸 수 있습니다.');
        const before = ops.findHoles({ mesh: m.data }).length;
        const r = ops.fillHoles({ mesh: m.data, opts: { maxEdges: Math.round(num(a, 'max-edges', 100)), refine: !a.flag.has('no-refine') } });
        return { mesh: r.mesh, detail: { holesBefore: before, filled: r.filled, addedTriangles: r.addedTriangles }, text: `구멍 ${before}개 중 ${r.filled}개 메움 (면 ${nf(r.addedTriangles)}개 추가)` };
      });
    case 'smooth':
      return inOut(a, 'smooth <입력> <출력> [--iterations 3] [--strength 0.5] [--laplacian]', async (m) => {
        if (!m.data.indices) throw new Error('smooth는 메시에만 쓸 수 있습니다.');
        const o = { iterations: Math.round(num(a, 'iterations', 3)), strength: num(a, 'strength', 0.5), taubin: !a.flag.has('laplacian') };
        return { mesh: ops.smooth({ mesh: m.data, opts: o }).mesh, detail: o, text: `스무딩 ${o.iterations}회 (세기 ${o.strength}, ${o.taubin ? '타우빈' : '라플라시안'})` };
      });
    case 'simplify':
      return inOut(a, 'simplify <입력> <출력> (--percent 50 | --triangles 200000)', async (m) => {
        if (!m.data.indices) throw new Error('simplify는 메시에만 쓸 수 있습니다.');
        if (!a.opt.percent && !a.opt.triangles) throw new UsageError('--percent 또는 --triangles가 필요합니다.');
        const target = a.opt.triangles ? num(a, 'triangles', 0) : (triangleCount(m.data) * num(a, 'percent', 50)) / 100;
        const r = await ops.simplify({ mesh: m.data, targetTriangles: target });
        return { mesh: r.mesh, detail: { before: r.before, after: r.after, error: r.error }, text: `단순화: 면 ${nf(r.before)} → ${nf(r.after)}` };
      });
    case 'align':
      return cmdAlign(a);
    case 'register':
      return cmdRegister(a);
    case 'render':
      return cmdRender(a);
    case 'fuse':
      return cmdFuse(a);
    case 'merge':
      return cmdMerge(a);
    case 'bake':
      return cmdBake(a);
    case 'finalize':
      return cmdFinalize(a);
    case 'pipeline':
      return cmdPipeline(a);
    case 'gui':
      return cmdGui();
    default:
      throw new UsageError(`알 수 없는 명령입니다: ${cmd}\n"depth-lidar help"로 명령 목록을 보세요.`);
  }
}

// Electron 실행 파일을 Node 모드로 돌리면 argv[1]이 이 스크립트다.
run(process.argv.slice(2)).then(
  (result) => {
    if (jsonMode && result !== undefined) process.stdout.write(JSON.stringify({ ok: true, ...(result as object) }) + '\n');
    process.exitCode = 0;
  },
  (e) => {
    const usage = e instanceof UsageError;
    const msg = e instanceof Error ? e.message : String(e);
    if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    process.stderr.write(`오류: ${msg}\n`);
    process.exitCode = usage ? 2 : 1;
  },
);
