// 사용자 명령. 스토어를 읽고, 무거운 계산은 워커에 맡긴 뒤 결과를 반영한다.
import type { IcpOptions } from './geometry/align';
import { IDENTITY, Mat4, MeshData, mat4Multiply, mergeMeshes, transformPoints, triangleCount, vertexCount } from './geometry/mesh';
import { EXPORT_FILTERS, ExportFormat, exportMesh } from './io/export';
import { IMPORT_FILTERS, importFile } from './io/import';
import { PickedFile, bridge, openFiles, saveFiles } from './io/platform';
import { RayCloudOptions, RayOpenResult, RayScanMeta, rayBinToCloud } from './io/ray';
import { parseProject, serializeProject } from './io/project';
import { AlignPair, PALETTE, ScanObject, TextureInfo, ToolId, Vec3, findObject, newId, useApp } from './store';
import { runOp } from './worker/client';

const S = () => useApp.getState();
const log = (t: string, level: 'info' | 'warn' | 'error' = 'info') => S().log(t, level);
const nf = (n: number) => n.toLocaleString('ko-KR');
const fx = (n: number, d = 3) => n.toFixed(d);

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 30));

export async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (S().busy) {
    log('다른 작업이 진행 중입니다.', 'warn');
    return undefined;
  }
  S().set({ busy: label });
  await nextFrame();
  const t0 = performance.now();
  try {
    const r = await fn();
    const dt = (performance.now() - t0) / 1000;
    if (dt > 1.5) log(`${label} 완료 (${dt.toFixed(1)}초)`);
    return r;
  } catch (e) {
    log(`${label} 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return undefined;
  } finally {
    S().set({ busy: null });
  }
}

/** 객체 목록을 바꾸고 실행 취소 기록을 남긴다. */
export function commit(objects: ScanObject[]) {
  const s = S();
  const holes = s.holes && objects.find((o) => o.id === s.holes!.objectId)?.data === findObject(s.holes.objectId)?.data ? s.holes : null;
  const selection: Record<string, Uint8Array> = {};
  for (const o of objects) {
    const old = s.objects.find((x) => x.id === o.id);
    if (old && old.data === o.data && s.selection[o.id]) selection[o.id] = s.selection[o.id];
  }
  s.set({
    objects,
    undoStack: [...s.undoStack.slice(-29), s.objects],
    redoStack: [],
    holes,
    selection,
    selectionCount: countSelection(selection),
    gizmo: s.gizmo && objects.some((o) => o.id === s.gizmo!.id) ? s.gizmo : null,
  });
}

const countSelection = (sel: Record<string, Uint8Array>) => {
  let n = 0;
  for (const k of Object.keys(sel)) {
    const m = sel[k];
    for (let i = 0; i < m.length; i++) n += m[i];
  }
  return n;
};

function resetTransient() {
  return { selection: {}, selectionCount: 0, holes: null, alignPairs: [] as AlignPair[], sectionResult: null, infoRows: [], distancePoints: [] as Vec3[], gizmo: null };
}

export function undo() {
  const s = S();
  if (!s.undoStack.length || s.busy) return;
  const prev = s.undoStack[s.undoStack.length - 1];
  s.set({ objects: prev, undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, s.objects], ...resetTransient() });
  log('실행 취소');
}

export function redo() {
  const s = S();
  if (!s.redoStack.length || s.busy) return;
  const next = s.redoStack[s.redoStack.length - 1];
  s.set({ objects: next, redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, s.objects], ...resetTransient() });
  log('다시 실행');
}

export function describe(d: MeshData) {
  return d.indices ? `정점 ${nf(vertexCount(d))} · 면 ${nf(triangleCount(d))}` : `점 ${nf(vertexCount(d))}`;
}

function makeObject(name: string, data: MeshData, texture: TextureInfo | null, index: number, extra: Partial<ScanObject> = {}): ScanObject {
  return { id: newId(), name, data, matrix: IDENTITY.slice(), visible: true, checked: true, color: PALETTE[index % PALETTE.length], texture, ...extra };
}

export function addObjects(list: { name: string; data: MeshData; texture?: TextureInfo | null; matrix?: Mat4 }[]) {
  const s = S();
  const objs = list.map((it, i) => makeObject(it.name, it.data, it.texture ?? null, s.objects.length + i, it.matrix ? { matrix: it.matrix } : {}));
  commit([...s.objects, ...objs]);
  for (const o of objs) log(`불러옴: ${o.name} (${describe(o.data)}${o.texture ? ' · 텍스처' : o.data.colors ? ' · 정점 색' : ''})`);
  return objs;
}

// ───────── 파일 ─────────
export async function importPicked(files: PickedFile[]) {
  const artec = files.find((f) => /\.artec$/i.test(f.name));
  if (artec) {
    // Ray II 원본 프로젝트는 전용 대화창으로 넘긴다.
    if (artec.dir) void openRayDialog(artec.dir);
    else log('project.artec은 파일 메뉴의 "Artec Ray II 스캔 불러오기"로 열어 주세요.', 'warn');
  }
  const main = files.filter((f) => /\.(obj|ply|stl|glb|gltf|xyz|asc|pts|ssproj)$/i.test(f.name));
  if (!main.length) return;
  await withBusy('파일 불러오는 중', async () => {
    for (const f of main) {
      try {
        if (/\.ssproj$/i.test(f.name)) {
          const objs = await parseProject(f.data);
          const s = S();
          commit([...s.objects, ...objs.map((o) => ({ ...o, id: newId() }))]);
          S().set({ projectName: f.name.replace(/\.ssproj$/i, '') });
          log(`프로젝트 열림: ${f.name} (객체 ${objs.length}개)`);
        } else {
          const items = await importFile(f, files);
          addObjects(items.filter((it) => it.data.positions.length > 0));
        }
      } catch (e) {
        log(`${f.name} 불러오기 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
      await nextFrame();
    }
  });
}

export async function importDialog() {
  const files = await openFiles(IMPORT_FILTERS);
  if (files.length) await importPicked(files);
}

/** Ray II 프로젝트를 고르게 한 뒤 스캔 선택 대화창을 띄운다. dirHint는 일반 가져오기 창에서 이미 고른 폴더다. */
export async function openRayDialog(dirHint?: string) {
  const r = await openRayProject(dirHint);
  if (r) S().set({ rayDialog: r });
}

/** Artec Ray II 프로젝트(project.artec)를 고르게 하고 스캔 목록을 돌려준다. */
export async function openRayProject(dirHint?: string): Promise<RayOpenResult | null> {
  if (!bridge) {
    log('Artec Ray II 프로젝트는 창 프로그램(Depth Lidar.exe)에서만 열 수 있습니다.', 'warn');
    return null;
  }
  try {
    const r = await bridge.rayOpen(dirHint);
    if (r && !r.projects.some((p) => p.scans.length)) {
      log('이 폴더에서 Ray II 스캔을 찾지 못했습니다. project.artec이 있는 폴더를 골라 주세요.', 'warn');
      return null;
    }
    return r;
  } catch (e) {
    log(`Ray II 프로젝트 열기 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return null;
  }
}

/** 고른 Ray II 스캔들을 포인트 클라우드로 불러온다. 스캔마다 객체 하나가 된다. */
export async function importRayScans(items: { project: string; scan: RayScanMeta }[], step: number, opts: RayCloudOptions = {}) {
  if (!bridge || !items.length) return 0;
  const b = bridge;
  let done = 0;
  await withBusy('Ray II 스캔 불러오는 중', async () => {
    try {
      for (let i = 0; i < items.length; i++) {
        const { project, scan } = items[i];
        const head = `Ray II 스캔 불러오는 중 (${i + 1}/${items.length}) ${scan.name}`;
        S().set({ busy: head });
        b.onRayProgress((p) => S().set({ busy: `${head} · 조각 ${p.done}/${p.total}` }));
        try {
          const res = await b.rayDecode(scan.dir, step, step);
          const cloud = rayBinToCloud(res.data, res.meta, opts);
          if (!cloud.kept) {
            log(`${scan.name}: 쓸 수 있는 점이 없습니다.`, 'warn');
            continue;
          }
          addObjects([{ name: `${project} · ${scan.name}`, data: cloud.data }]);
          done++;
        } catch (e) {
          log(`${scan.name} 불러오기 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
        await nextFrame();
      }
    } finally {
      b.onRayProgress(null);
    }
  });
  if (done) log(`Ray II 스캔 ${done}개를 불러왔습니다. 단위 mm, 원점은 각 스캐너 위치입니다. 스캔끼리는 아직 정렬되지 않았습니다.`);
  return done;
}

export async function loadSample(kind: 'scans' | 'model') {
  await withBusy('샘플 생성 중', async () => {
    if (kind === 'model') {
      const r = await runOp('sampleModel', {});
      addObjects([{ name: '샘플 모델', data: r.mesh }]);
    } else {
      const r = await runOp('sampleScans', {});
      addObjects(r.map((x) => ({ name: x.name, data: x.mesh })));
    }
  });
}

export function newProject() {
  const s = S();
  if (!s.objects.length) return;
  commit([]);
  S().set({ projectName: null, ...resetTransient() });
  log('새 프로젝트');
}

export async function saveProject() {
  const s = S();
  if (!s.objects.length) return log('저장할 객체가 없습니다.', 'warn');
  await withBusy('프로젝트 저장 중', async () => {
    const base = s.projectName ?? 'project';
    const p = await saveFiles(base, { name: 'Depth Lidar 프로젝트', extensions: ['ssproj'] }, async (b) => [{ name: `${b}.ssproj`, data: await serializeProject(S().objects) }]);
    if (p) log(`프로젝트 저장: ${p}`);
  });
}

export async function exportChecked(format: ExportFormat) {
  const objs = S().objects.filter((o) => o.checked);
  if (!objs.length) return log('내보낼 객체를 작업공간에서 체크하세요.', 'warn');
  await withBusy(`${format.toUpperCase()} 내보내는 중`, async () => {
    const single = objs.length === 1;
    const merged = single ? (await runOp('bake', { mesh: objs[0].data, matrix: objs[0].matrix })).mesh : mergeMeshes(objs.map((o) => ({ mesh: o.data, matrix: o.matrix })));
    if (!single) log(`체크한 객체 ${objs.length}개를 하나로 합쳐 내보냅니다${objs.some((o) => o.texture) ? ' (텍스처는 제외, 정점 색만 유지)' : ''}.`, 'warn');
    const tex = single ? objs[0].texture : null;
    const defBase = (single ? objs[0].name : S().projectName ?? 'merged').replace(/[\\/:*?"<>|]/g, '_');
    const p = await saveFiles(defBase, EXPORT_FILTERS[format], (b) => exportMesh(format, merged, b, tex));
    if (p) log(`내보냄: ${p} (${describe(merged)})`);
  });
}

// ───────── 작업공간 ─────────
export function updateObject(id: string, patch: Partial<ScanObject>, undoable = false) {
  const s = S();
  const objects = s.objects.map((o) => (o.id === id ? { ...o, ...patch } : o));
  if (undoable) commit(objects);
  else s.set({ objects });
}

export function setAllChecked(checked: boolean) {
  S().set({ objects: S().objects.map((o) => ({ ...o, checked })) });
}

export function deleteChecked() {
  const s = S();
  const n = s.objects.filter((o) => o.checked).length;
  if (!n) return;
  commit(s.objects.filter((o) => !o.checked));
  log(`객체 ${n}개 삭제`);
}

export function duplicateChecked() {
  const s = S();
  const copies = s.objects.filter((o) => o.checked).map((o, i) => ({ ...o, id: newId(), name: `${o.name} 사본`, checked: false, color: PALETTE[(s.objects.length + i) % PALETTE.length] }));
  if (copies.length) commit([...s.objects, ...copies]);
}

export function setTool(tool: ToolId | null) {
  const s = S();
  const patch: Partial<ReturnType<typeof S>> = { tool, alignPicking: false };
  if (tool === 'align') {
    const ch = s.objects.filter((o) => o.checked);
    patch.alignFixedId = findObject(s.alignFixedId) ? s.alignFixedId : ch[0]?.id ?? null;
    patch.alignMovingId = findObject(s.alignMovingId) && s.alignMovingId !== patch.alignFixedId ? s.alignMovingId : ch.find((o) => o.id !== patch.alignFixedId)?.id ?? null;
  }
  if (tool !== 'tools' && tool !== 'align') patch.gizmo = null;
  s.set(patch);
}

// ───────── 공통: 체크한 메시에 연산 적용 ─────────
async function mapChecked(label: string, fn: (o: ScanObject) => Promise<{ data: MeshData; msg: string; texture?: TextureInfo | null } | null>, meshOnly = true) {
  const targets = S().objects.filter((o) => o.checked && (!meshOnly || o.data.indices));
  if (!targets.length) return log(meshOnly ? '작업공간에서 메시 객체를 체크하세요.' : '작업공간에서 객체를 체크하세요.', 'warn');
  await withBusy(label, async () => {
    const results = new Map<string, { data: MeshData; texture?: TextureInfo | null }>();
    for (const o of targets) {
      const r = await fn(o);
      if (r) {
        results.set(o.id, r);
        log(`${o.name}: ${r.msg}`);
      }
    }
    if (results.size)
      commit(S().objects.map((o) => {
        const r = results.get(o.id);
        return r ? { ...o, data: r.data, texture: r.texture !== undefined ? r.texture : o.texture } : o;
      }));
  });
}

// ───────── 편집기 ─────────
export function applySelection(masks: Record<string, Uint8Array>, subtract: boolean) {
  const s = S();
  const sel = { ...s.selection };
  for (const id of Object.keys(masks)) {
    const m = masks[id];
    const cur = sel[id];
    if (subtract) {
      if (!cur) continue;
      const n = cur.slice();
      for (let i = 0; i < n.length; i++) if (m[i]) n[i] = 0;
      sel[id] = n;
    } else if (cur && cur.length === m.length) {
      const n = cur.slice();
      for (let i = 0; i < n.length; i++) if (m[i]) n[i] = 1;
      sel[id] = n;
    } else sel[id] = m;
  }
  s.set({ selection: sel, selectionCount: countSelection(sel) });
}

export function clearSelection() {
  S().set({ selection: {}, selectionCount: 0 });
}

export function invertSelection() {
  const s = S();
  const sel: Record<string, Uint8Array> = {};
  for (const o of s.objects) {
    if (!o.checked) continue;
    const n = o.data.indices ? o.data.indices.length / 3 : vertexCount(o.data);
    const cur = s.selection[o.id];
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = cur && cur[i] ? 0 : 1;
    sel[o.id] = m;
  }
  s.set({ selection: sel, selectionCount: countSelection(sel) });
}

export async function deleteSelected() {
  const s = S();
  if (!s.selectionCount) return;
  await withBusy('선택 영역 삭제 중', async () => {
    const out = new Map<string, MeshData>();
    for (const o of s.objects) {
      const mask = s.selection[o.id];
      if (!mask) continue;
      out.set(o.id, (await runOp('deleteElements', { mesh: o.data, mask })).mesh);
    }
    commit(S().objects.map((o) => (out.has(o.id) ? { ...o, data: out.get(o.id)! } : o)));
    log(`선택한 ${nf(s.selectionCount)}개 요소 삭제`);
  });
}

// ───────── 도구 ─────────
export const runRemoveSmall = (mode: 'largest' | 'threshold', minTriangles: number) =>
  mapChecked('작은 조각 제거 중', async (o) => {
    const r = await runOp('removeSmall', { mesh: o.data, opts: { mode, minTriangles } });
    if (!r.removedComponents) {
      log(`${o.name}: 제거할 조각이 없습니다 (조각 ${r.components}개).`);
      return null;
    }
    return { data: r.mesh, msg: `조각 ${r.removedComponents}개(면 ${nf(r.removedTriangles)}) 제거` };
  });

export const runSmooth = (iterations: number, strength: number, taubin: boolean) =>
  mapChecked('스무딩 중', async (o) => ({ data: (await runOp('smooth', { mesh: o.data, opts: { iterations, strength, taubin } })).mesh, msg: `스무딩 ${iterations}회` }));

export const runSimplify = (percent: number) =>
  mapChecked('메시 단순화 중', async (o) => {
    const r = await runOp('simplify', { mesh: o.data, targetTriangles: (triangleCount(o.data) * percent) / 100 });
    return { data: r.mesh, msg: `면 ${nf(r.before)} → ${nf(r.after)}` };
  });

export const runFlip = () => mapChecked('법선 뒤집는 중', async (o) => ({ data: (await runOp('flip', { mesh: o.data })).mesh, msg: '법선 뒤집음' }));

export const runFillSmallHoles = (maxEdges: number) =>
  mapChecked('구멍 메우는 중', async (o) => {
    const r = await runOp('fillHoles', { mesh: o.data, opts: { maxEdges, refine: true } });
    if (!r.filled) {
      log(`${o.name}: 간선 ${maxEdges}개 이하인 구멍이 없습니다.`);
      return null;
    }
    return { data: r.mesh, msg: `구멍 ${r.filled}개 메움 (면 ${nf(r.addedTriangles)} 추가)` };
  });

export function bakeTextureColors(o: ScanObject): MeshData {
  if (!o.texture || !o.data.uvs) return o.data;
  const { canvas } = o.texture;
  const img = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
  const n = vertexCount(o.data);
  const colors = new Float32Array(n * 3);
  const U = o.data.uvs;
  for (let i = 0; i < n; i++) {
    const u = U[i * 2] - Math.floor(U[i * 2]), v = U[i * 2 + 1] - Math.floor(U[i * 2 + 1]);
    const x = Math.min(canvas.width - 1, Math.floor(u * canvas.width));
    const y = Math.min(canvas.height - 1, Math.floor((1 - v) * canvas.height));
    const p = (y * canvas.width + x) * 4;
    colors[i * 3] = img[p] / 255;
    colors[i * 3 + 1] = img[p + 1] / 255;
    colors[i * 3 + 2] = img[p + 2] / 255;
  }
  return { ...o.data, colors };
}

export async function runFuse(voxel: number, clean: boolean) {
  const objs = S().objects.filter((o) => o.checked);
  if (!objs.length) return log('퓨전할 스캔을 작업공간에서 체크하세요.', 'warn');
  await withBusy('퓨전 중', async () => {
    const items = objs.map((o) => ({ mesh: o.texture && o.data.uvs && !o.data.colors ? bakeTextureColors(o) : o.data, matrix: o.matrix }));
    const r = await runOp('fuse', { items, opts: { voxel } });
    let mesh = r.mesh;
    if (!triangleCount(mesh)) throw new Error('결과 메시가 비었습니다. 해상도를 키워 보세요.');
    if (clean) mesh = (await runOp('removeSmall', { mesh, opts: { mode: 'threshold', minTriangles: 200 } })).mesh;
    const s = S();
    const fused = makeObject(`퓨전 ${s.objects.filter((o) => o.name.startsWith('퓨전')).length + 1}`, mesh, null, s.objects.length);
    commit([...s.objects.map((o) => (o.checked ? { ...o, checked: false, visible: false } : o)), fused]);
    log(`퓨전 완료: 스캔 ${objs.length}개 → ${describe(mesh)} (해상도 ${fx(r.voxel)}, 표본 ${nf(r.samples)}개)`);
  });
}

// ───────── 구멍 메우기 패널 ─────────
export async function detectHoles(id?: string) {
  const o = (id ? findObject(id) : null) ?? S().objects.find((x) => x.checked && x.data.indices);
  if (!o) return log('구멍을 찾을 메시 객체를 체크하세요.', 'warn');
  await withBusy('구멍 찾는 중', async () => {
    const loops = await runOp('findHoles', { mesh: o.data });
    // 가장 큰 루프는 대개 스캔 바깥 테두리이므로 기본 선택에서 뺀다.
    S().set({ holes: { objectId: o.id, items: loops.map((l, i) => ({ ...l, checked: !(i === 0 && loops.length > 1 && l.perimeter > loops[1].perimeter * 3) })) } });
    log(`${o.name}: 경계 루프 ${loops.length}개 발견`);
  });
}

export async function fillCheckedHoles() {
  const s = S();
  const h = s.holes;
  const o = h ? findObject(h.objectId) : null;
  if (!h || !o) return;
  const loopIndices = h.items.map((it, i) => (it.checked ? i : -1)).filter((i) => i >= 0);
  if (!loopIndices.length) return log('메울 구멍을 목록에서 체크하세요.', 'warn');
  await withBusy('구멍 메우는 중', async () => {
    const r = await runOp('fillHoles', { mesh: o.data, opts: { loopIndices, refine: true } });
    commit(S().objects.map((x) => (x.id === o.id ? { ...x, data: r.mesh } : x)));
    log(`${o.name}: 구멍 ${r.filled}개 메움 (면 ${nf(r.addedTriangles)} 추가)`);
  });
  await detectHoles(o.id);
}

// ───────── 정렬 ─────────
export function handlePick(point: Vec3, id: string) {
  const s = S();
  if (s.tool === 'measure' && s.measureMode === 'distance') {
    s.set({ distancePoints: [...s.distancePoints, point] });
    return;
  }
  if (s.tool === 'align' && s.alignPicking) {
    const side = id === s.alignFixedId ? 'fixed' : id === s.alignMovingId ? 'moving' : null;
    if (!side) return log('기준 또는 이동 객체 위를 찍으세요.', 'warn');
    const pairs = s.alignPairs.map((p) => ({ ...p }));
    let slot = pairs.find((p) => !p[side]);
    if (!slot) pairs.push((slot = { fixed: null, moving: null }));
    slot[side] = point;
    s.set({ alignPairs: pairs });
  }
}

export async function alignByPairs(refine: boolean) {
  const s = S();
  const mv = findObject(s.alignMovingId), fxd = findObject(s.alignFixedId);
  const pairs = s.alignPairs.filter((p) => p.fixed && p.moving);
  if (!mv || !fxd) return log('기준 객체와 이동 객체를 고르세요.', 'warn');
  if (pairs.length < 3) return log('대응점이 3쌍 이상 필요합니다.', 'warn');
  await withBusy('점 정렬 중', async () => {
    const r = await runOp('alignPairs', { moving: pairs.flatMap((p) => p.moving!), fixed: pairs.flatMap((p) => p.fixed!), srcMatrix: mv.matrix });
    let matrix = r.newMatrix;
    log(`${mv.name}: 대응점 ${pairs.length}쌍으로 정렬 (점 오차 RMS ${fx(r.rms)})`);
    if (refine) {
      const i = await runOp('align', { src: mv.data, srcMatrix: matrix, dst: fxd.data, dstMatrix: fxd.matrix, mode: 'icp', opts: {} });
      matrix = i.newMatrix;
      log(`${mv.name}: 정밀 정렬 RMS ${fx(i.initialRms)} → ${fx(i.rms)} (${i.iterations}회 반복)`);
    }
    commit(S().objects.map((o) => (o.id === mv.id ? { ...o, matrix } : o)));
    S().set({ alignPairs: [], alignPicking: false });
  });
}

export async function alignAuto(mode: 'icp' | 'coarse', opts: IcpOptions = {}) {
  const s = S();
  const mv = findObject(s.alignMovingId), fxd = findObject(s.alignFixedId);
  if (!mv || !fxd || mv.id === fxd.id) return log('서로 다른 기준 객체와 이동 객체를 고르세요.', 'warn');
  await withBusy(mode === 'icp' ? '정밀 정렬 중' : '자동 정렬 중', async () => {
    const r = await runOp('align', { src: mv.data, srcMatrix: mv.matrix, dst: fxd.data, dstMatrix: fxd.matrix, mode, opts });
    commit(S().objects.map((o) => (o.id === mv.id ? { ...o, matrix: r.newMatrix } : o)));
    log(`${mv.name} → ${fxd.name}: 오차 RMS ${fx(r.initialRms)} → ${fx(r.rms)} (${r.iterations}회 반복, 대응 ${nf(r.pairs)}/${nf(r.samples)})`);
  });
}

// ───────── 변환 ─────────
export function setGizmo(mode: 'translate' | 'rotate' | 'scale' | null, id?: string) {
  const s = S();
  if (!mode) return s.set({ gizmo: null });
  const target = id ?? s.gizmo?.id ?? s.objects.find((o) => o.checked)?.id;
  if (!target) return log('변환할 객체를 체크하세요.', 'warn');
  s.set({ gizmo: { id: target, mode } });
}

export function commitGizmo(id: string, matrix: Mat4) {
  const s = S();
  commit(s.objects.map((o) => (o.id === id ? { ...o, matrix } : o)));
  // 조작기 기준점을 새 위치로 다시 잡는다.
  if (s.gizmo) S().set({ gizmo: { ...s.gizmo } });
}

export function resetTransform() {
  const s = S();
  commit(s.objects.map((o) => (o.checked ? { ...o, matrix: IDENTITY.slice() } : o)));
  log('체크한 객체의 변환을 초기화했습니다.');
}

export function centerToOrigin() {
  const s = S();
  commit(
    s.objects.map((o) => {
      if (!o.checked || !o.data.positions.length) return o;
      const w = transformPoints(o.data.positions, o.matrix);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < w.length; i += 3) for (let k = 0; k < 3; k++) {
        if (w[i + k] < mn[k]) mn[k] = w[i + k];
        if (w[i + k] > mx[k]) mx[k] = w[i + k];
      }
      const t: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -(mn[0] + mx[0]) / 2, -mn[1], -(mn[2] + mx[2]) / 2, 1];
      return { ...o, matrix: mat4Multiply(t, o.matrix) };
    }),
  );
  log('체크한 객체를 원점 바닥 위로 옮겼습니다.');
}

// ───────── 텍스처·색 ─────────
export interface ColorAdjust {
  brightness: number; // -1..1
  contrast: number; // 0..2
  saturation: number; // 0..2
  gamma: number; // 0.3..3
}

function adjustRGB(r: number, g: number, b: number, a: ColorAdjust): [number, number, number] {
  const ig = 1 / a.gamma;
  let c = [Math.pow(r, ig), Math.pow(g, ig), Math.pow(b, ig)].map((v) => (v - 0.5) * a.contrast + 0.5 + a.brightness);
  const gray = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  c = c.map((v) => Math.max(0, Math.min(1, gray + (v - gray) * a.saturation)));
  return [c[0], c[1], c[2]];
}

export const adjustColors = (a: ColorAdjust) =>
  mapChecked('색 보정 중', async (o) => {
    if (!o.data.colors && !o.texture) {
      log(`${o.name}: 색 정보가 없습니다.`, 'warn');
      return null;
    }
    let data = o.data;
    let texture = o.texture;
    if (data.colors) {
      const c = data.colors.slice();
      for (let i = 0; i < c.length; i += 3) {
        const [r, g, b] = adjustRGB(c[i], c[i + 1], c[i + 2], a);
        c[i] = r; c[i + 1] = g; c[i + 2] = b;
      }
      data = { ...data, colors: c };
    }
    if (texture) {
      const canvas = document.createElement('canvas');
      canvas.width = texture.canvas.width;
      canvas.height = texture.canvas.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(texture.canvas, 0, 0);
      const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const lut = (ch: number) => ch; // 채널 간 채도 계산 때문에 픽셀 단위로 처리
      void lut;
      const d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b] = adjustRGB(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, a);
        d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
      }
      ctx.putImageData(im, 0, 0);
      texture = { canvas, name: texture.name };
    }
    return { data, texture, msg: '색 보정 적용' };
  }, false);

export const textureToVertexColors = () =>
  mapChecked('텍스처를 정점 색으로 굽는 중', async (o) => {
    if (!o.texture || !o.data.uvs) {
      log(`${o.name}: 텍스처가 없습니다.`, 'warn');
      return null;
    }
    return { data: bakeTextureColors(o), msg: '텍스처 → 정점 색' };
  });

export const removeColors = (what: 'texture' | 'colors') =>
  mapChecked('색 정보 제거 중', async (o) => {
    if (what === 'texture') return o.texture ? { data: { ...o.data, uvs: null }, texture: null, msg: '텍스처 제거' } : null;
    return o.data.colors ? { data: { ...o.data, colors: null }, msg: '정점 색 제거' } : null;
  }, false);

// ───────── 측정 ─────────
export async function computeSection() {
  const s = S();
  const objs = s.objects.filter((o) => o.checked && o.data.indices);
  if (!objs.length) return log('단면을 구할 메시 객체를 체크하세요.', 'warn');
  await withBusy('단면 계산 중', async () => {
    const normal: Vec3 = [0, 0, 0];
    normal[s.sectionAxis] = 1;
    const parts: Float32Array[] = [];
    let length = 0, area = 0, closedLoops = 0, openChains = 0;
    for (const o of objs) {
      const r = await runOp('section', { mesh: o.data, matrix: o.matrix, normal, d: s.sectionOffset });
      parts.push(r.segments);
      length += r.length; area += r.area; closedLoops += r.closedLoops; openChains += r.openChains;
    }
    const segments = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o2 = 0;
    for (const p of parts) { segments.set(p, o2); o2 += p.length; }
    S().set({ sectionResult: { segments, length, area, closedLoops, openChains } });
    log(`단면 (${'XYZ'[s.sectionAxis]} = ${fx(s.sectionOffset, 2)}): 윤곽 길이 ${fx(length)}, 닫힌 윤곽 ${closedLoops}개 면적 ${fx(area)}`);
  });
}

export async function computeInfo() {
  const objs = S().objects.filter((o) => o.checked);
  if (!objs.length) return log('측정할 객체를 체크하세요.', 'warn');
  await withBusy('치수 계산 중', async () => {
    const rows = [];
    for (const o of objs) rows.push({ name: o.name, info: await runOp('meshInfo', { mesh: o.data, matrix: o.matrix }) });
    S().set({ infoRows: rows });
  });
}
