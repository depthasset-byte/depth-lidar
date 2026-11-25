// 자동 검증 시나리오: 창 앱을 `--selftest <폴더>`로 실행하면 주요 기능을 차례로 돌리고 결과와 화면 캡처를 남긴다.
import * as actions from './actions';
import { getViewer } from './components/Viewport';
import { IDENTITY, triangleCount, vertexCount } from './geometry/mesh';
import { exportMesh } from './io/export';
import { importFile } from './io/import';
import { bridge } from './io/platform';
import { parseProject, serializeProject } from './io/project';
import { useApp } from './store';
import { runOp } from './worker/client';
import type { OutFile } from './io/platform';

const S = () => useApp.getState();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toBuf = (d: OutFile['data']): ArrayBuffer =>
  (typeof d === 'string' ? new TextEncoder().encode(d).buffer : d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) as ArrayBuffer;

export async function runSelfTest() {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail = '') => checks.push({ name, pass, detail });
  const shot = async (name: string) => {
    getViewer()?.renderNow();
    await wait(250);
    await (bridge as unknown as { selfTestShot(n: string): Promise<void> }).selfTestShot(name);
  };
  const only = (pred: (name: string) => boolean) => S().set({ objects: S().objects.map((o) => ({ ...o, checked: pred(o.name) })) });
  let error: string | null = null;
  try {
    await wait(600);
    await shot('01-빈화면');
    await actions.loadSample('scans');
    check('샘플 스캔 3장 불러오기', S().objects.length === 3, `객체 ${S().objects.length}개`);
    getViewer()?.fitView();
    await shot('02-샘플스캔-어긋난상태');

    // 편집기: 화면 가운데 사각형 선택 후 삭제, 그리고 되돌리기
    actions.setTool('editor');
    S().set({ selectShape: 'rect' });
    await wait(200); // 패널이 열려 뷰포트 크기가 바뀔 때까지 기다린다.
    const host = document.querySelector('.canvas-host') as HTMLElement;
    let w = host.clientWidth, h = host.clientHeight;
    const rect = [{ x: w * 0.45, y: h * 0.42 }, { x: w * 0.55, y: h * 0.42 }, { x: w * 0.55, y: h * 0.58 }, { x: w * 0.45, y: h * 0.58 }];
    const visMasks = getViewer()!.computeSelection(rect, true);
    const allMasks = getViewer()!.computeSelection(rect, false);
    const count = (m: Record<string, Uint8Array>) => Object.values(m).reduce((n, a) => n + a.reduce((x, y) => x + y, 0), 0);
    check('영역 선택 (보이는 면만 < 관통)', count(visMasks) > 0 && count(visMasks) < count(allMasks), `보이는 면 ${count(visMasks)}, 관통 ${count(allMasks)}`);
    actions.applySelection(visMasks, false);
    await shot('03-편집기-선택');
    const trisBefore = S().objects.reduce((n, o) => n + triangleCount(o.data), 0);
    const selCount = S().selectionCount;
    await actions.deleteSelected();
    const trisAfter = S().objects.reduce((n, o) => n + triangleCount(o.data), 0);
    check('선택 삭제', trisBefore - trisAfter === selCount && selCount > 0, `면 ${trisBefore} → ${trisAfter}`);
    actions.undo();
    check('실행 취소', S().objects.reduce((n, o) => n + triangleCount(o.data), 0) === trisBefore);

    // 실제 마우스 입력으로 같은 동작을 확인한다.
    const mouse = (type: string, fx: number, fy: number, modifiers: string[] = []) => {
      const br = host.getBoundingClientRect();
      return { type, x: Math.round(br.left + host.clientWidth * fx), y: Math.round(br.top + host.clientHeight * fy), button: 'left', clickCount: 1, modifiers };
    };
    actions.clearSelection();
    S().set({ selectShape: 'lasso' });
    await bridge!.selfTestInput([
      mouse('mouseMove', 0.42, 0.4, ['control']),
      mouse('mouseDown', 0.42, 0.4, ['control']),
      mouse('mouseMove', 0.58, 0.42, ['control', 'leftButtonDown']),
      mouse('mouseMove', 0.6, 0.6, ['control', 'leftButtonDown']),
      mouse('mouseMove', 0.4, 0.58, ['control', 'leftButtonDown']),
      mouse('mouseUp', 0.4, 0.58, ['control']),
    ]);
    check('실제 입력: Ctrl+드래그 올가미 선택', S().selectionCount > 0, `선택 ${S().selectionCount}개`);
    await shot('03b-실제입력-올가미선택');
    const camBefore = getViewer()!.cameraPosition();
    const selBefore = S().selectionCount;
    await bridge!.selfTestInput([
      mouse('mouseMove', 0.5, 0.5),
      mouse('mouseDown', 0.5, 0.5),
      mouse('mouseMove', 0.56, 0.5, ['leftButtonDown']),
      mouse('mouseMove', 0.62, 0.52, ['leftButtonDown']),
      mouse('mouseUp', 0.62, 0.52),
    ]);
    const camAfter = getViewer()!.cameraPosition();
    check('실제 입력: 드래그 회전', Math.hypot(camAfter[0] - camBefore[0], camAfter[1] - camBefore[1], camAfter[2] - camBefore[2]) > 1 && S().selectionCount === selBefore, `카메라 이동 ${Math.hypot(camAfter[0] - camBefore[0], camAfter[1] - camBefore[1], camAfter[2] - camBefore[2]).toFixed(1)}`);
    actions.clearSelection();

    // 도구: 작은 조각 제거
    actions.setTool('tools');
    only(() => true);
    await actions.runRemoveSmall('threshold', 50);
    check('작은 조각 제거', triangleCount(S().objects[0].data) > 0 && S().logs.some((l) => l.text.includes('조각 4개')), S().logs[S().logs.length - 1]?.text ?? '');

    // 정렬
    actions.setTool('align');
    const [a, b, c] = S().objects;
    // 수동 점 정렬: 같은 위치 3곳을 기준·이동 객체에 번갈아 찍은 것으로 가정한다.
    const truth = await runOp('sampleScans', {});
    S().set({ alignFixedId: a.id, alignMovingId: b.id, alignPicking: true });
    const off = truth[1].offset;
    for (const q of [[40, 10, 5], [20, 45, 20], [30, -30, 25]]) {
      actions.handlePick([q[0], q[1], q[2]], a.id);
      actions.handlePick([off[0] * q[0] + off[4] * q[1] + off[8] * q[2] + off[12], off[1] * q[0] + off[5] * q[1] + off[9] * q[2] + off[13], off[2] * q[0] + off[6] * q[1] + off[10] * q[2] + off[14]], b.id);
    }
    check('점 정렬: 대응점 3쌍 입력', S().alignPairs.filter((x) => x.fixed && x.moving).length === 3);
    await shot('04a-점정렬-대응점');
    await actions.alignByPairs(true);
    check('점 정렬 적용', S().alignPairs.length === 0 && S().logs.some((l) => l.text.includes('대응점 3쌍으로 정렬')));
    S().set({ alignFixedId: a.id, alignMovingId: c.id });
    await actions.alignAuto('icp');
    const rmsLogs = S().logs.filter((l) => l.text.includes('회 반복'));
    const finalRms = rmsLogs.map((l) => Number(/→ ([\d.]+)/.exec(l.text)?.[1] ?? 'NaN'));
    check('정밀 정렬 2회 (점 정렬 뒤 1회 + 자동 1회)', finalRms.length === 2 && finalRms.every((r) => r < 0.2), rmsLogs.map((l) => l.text).join(' | '));
    getViewer()?.fitView();
    await shot('04-정렬후');

    // 구멍 메우기
    actions.setTool('holes');
    only((n) => n === a.name);
    await actions.detectHoles();
    const holesBefore = S().holes?.items.length ?? 0;
    await shot('05-구멍찾기');
    await actions.fillCheckedHoles();
    const holesAfter = S().holes?.items.length ?? -1;
    check('구멍 찾기·메우기', holesBefore === 4 && holesAfter === 1, `경계 ${holesBefore}개 → ${holesAfter}개`);

    // 퓨전
    actions.setTool('tools');
    only(() => true);
    await actions.runFuse(0, true);
    const fused = S().objects[S().objects.length - 1];
    check('퓨전', fused.name.startsWith('퓨전') && triangleCount(fused.data) > 10000 && !!fused.data.colors, actions.describe(fused.data));
    getViewer()?.fitView();
    await shot('06-퓨전결과');

    // 후처리: 단순화 + 스무딩
    const t0 = triangleCount(fused.data);
    await actions.runSimplify(40);
    await actions.runSmooth(3, 0.5, true);
    const fused2 = S().objects[S().objects.length - 1];
    check('단순화·스무딩', Math.abs(triangleCount(fused2.data) / t0 - 0.4) < 0.05, `면 ${t0} → ${triangleCount(fused2.data)}`);
    S().set({ view: { ...S().view, mode: 'wire' } });
    await shot('07-단순화-와이어');
    S().set({ view: { ...S().view, mode: 'solid' } });

    // 측정
    actions.setTool('measure');
    S().set({ measureMode: 'info' });
    await actions.computeInfo();
    const info = S().infoRows[0]?.info;
    check('치수·부피 계산', !!info && info.area > 10000 && info.volume > 100000, info ? `크기 ${info.size.map((x) => x.toFixed(1)).join('×')}, 표면적 ${info.area.toFixed(0)}, 부피 ${info.volume.toFixed(0)}` : '');
    S().set({ measureMode: 'section', sectionAxis: 1, sectionOffset: 0 });
    await actions.computeSection();
    const sec = S().sectionResult;
    check('단면 계산', !!sec && sec.length > 100 && sec.closedLoops >= 1, sec ? `길이 ${sec.length.toFixed(1)}, 닫힌 윤곽 ${sec.closedLoops}, 면적 ${sec.area.toFixed(0)}` : '');
    await shot('08-단면');
    // 거리: 화면 가운데를 실제로 찍어 본다
    S().set({ measureMode: 'distance' });
    await wait(200);
    getViewer()?.renderNow();
    w = host.clientWidth;
    h = host.clientHeight;
    const p1 = getViewer()!.pick(w * 0.45, h * 0.5), p2 = getViewer()!.pick(w * 0.55, h * 0.5);
    if (p1 && p2) {
      actions.handlePick(p1.point, p1.id);
      actions.handlePick(p2.point, p2.id);
    }
    check('표면 찍기·거리 측정', !!p1 && !!p2 && S().distancePoints.length === 2, p1 && p2 ? `거리 ${Math.hypot(p1.point[0] - p2.point[0], p1.point[1] - p2.point[1], p1.point[2] - p2.point[2]).toFixed(2)}` : '찍기 실패');
    await bridge!.selfTestInput([mouse('mouseMove', 0.5, 0.45), mouse('mouseDown', 0.5, 0.45), mouse('mouseUp', 0.5, 0.45)]);
    check('실제 입력: 클릭으로 측정 점 추가', S().distancePoints.length === 3, `점 ${S().distancePoints.length}개`);
    await shot('09-거리');

    // 텍스처·색 보정
    actions.setTool('texture');
    const c0 = fused2.data.colors![0];
    await actions.adjustColors({ brightness: 0.1, contrast: 1.2, saturation: 1.3, gamma: 1 });
    check('색 보정', S().objects[S().objects.length - 1].data.colors![0] !== c0);

    // 내보내기·다시 불러오기 왕복
    const mesh = S().objects[S().objects.length - 1].data;
    for (const fmt of ['obj', 'ply', 'stl', 'glb'] as const) {
      const files = await exportMesh(fmt, mesh, 'roundtrip', null);
      const d = files[0].data;
      const buf = typeof d === 'string' ? new TextEncoder().encode(d).buffer : d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
      const back = await importFile({ name: files[0].name, data: buf as ArrayBuffer }, []);
      const okV = fmt === 'stl' ? vertexCount(back[0].data) <= vertexCount(mesh) : vertexCount(back[0].data) === vertexCount(mesh);
      check(`내보내기·불러오기 왕복 (${fmt.toUpperCase()})`, okV && triangleCount(back[0].data) === triangleCount(mesh), `${(buf.byteLength / 1024).toFixed(0)} KB, ${actions.describe(back[0].data)}`);
    }
    const proj = await serializeProject(S().objects);
    const parsed = await parseProject(proj.buffer.slice(proj.byteOffset, proj.byteOffset + proj.byteLength) as ArrayBuffer);
    check('프로젝트 저장·열기 왕복', parsed.length === S().objects.length && parsed.every((o, i) => o.data.positions.length === S().objects[i].data.positions.length), `${(proj.byteLength / 1024 / 1024).toFixed(1)} MB`);

    // 변환 조작기 표시
    actions.setTool('tools');
    actions.setGizmo('rotate');
    actions.setGizmo('translate');
    await wait(250);
    getViewer()?.renderNow();
    const gid = S().gizmo!.id;
    const m0 = S().objects.find((o) => o.id === gid)!.matrix.slice();
    const hs = getViewer()!.gizmoHandleScreen(0);
    const undo0 = S().undoStack.length;
    if (hs) {
      const fr = (pt: { x: number; y: number }) => [pt.x / host.clientWidth, pt.y / host.clientHeight] as const;
      const [ax, ay] = fr(hs.from), [bx, by] = fr(hs.to);
      await bridge!.selfTestInput([
        mouse('mouseMove', ax, ay),
        mouse('mouseDown', ax, ay),
        mouse('mouseMove', ax + (bx - ax) * 0.5, ay + (by - ay) * 0.5, ['leftButtonDown']),
        mouse('mouseMove', bx, by, ['leftButtonDown']),
        mouse('mouseUp', bx, by),
      ]);
    }
    const m1 = S().objects.find((o) => o.id === gid)!.matrix;
    check('실제 입력: 조작기로 X축 이동', !!hs && Math.abs(m1[12] - m0[12]) > 1 && Math.abs(m1[13] - m0[13]) < 1e-3 && Math.abs(m1[14] - m0[14]) < 1e-3 && S().undoStack.length === undo0 + 1, `이동 Δx=${(m1[12] - m0[12]).toFixed(2)}, Δy=${(m1[13] - m0[13]).toFixed(4)}, Δz=${(m1[14] - m0[14]).toFixed(4)}`);
    await shot('10-변환조작기');
    actions.undo();
    actions.setGizmo(null);

    // 텍스처: UV·텍스처가 있는 OBJ(+MTL+PNG)와 GLB 왕복
    const base = (await runOp('sampleModel', {})).mesh;
    const nv = vertexCount(base);
    const uvs = new Float32Array(nv * 2);
    for (let i = 0; i < nv; i++) {
      const x = base.positions[i * 3], y = base.positions[i * 3 + 1], z = base.positions[i * 3 + 2];
      uvs[i * 2] = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
      uvs[i * 2 + 1] = 1 - Math.acos(y / Math.hypot(x, y, z)) / Math.PI;
    }
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 256;
    const g2 = cv.getContext('2d', { willReadFrequently: true })!;
    const grad = g2.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#f2c14e');
    grad.addColorStop(1, '#2d6cdf');
    g2.fillStyle = grad;
    g2.fillRect(0, 0, 512, 256);
    g2.fillStyle = 'rgba(20,20,20,0.75)';
    for (let i = 0; i < 16; i++) g2.fillRect(i * 32, 0, 6, 256);
    for (let j = 0; j < 8; j++) g2.fillRect(0, j * 32, 512, 4);
    const texMesh = { ...base, uvs, colors: null };
    const objFiles = await exportMesh('obj', texMesh, 'textured', { canvas: cv, name: 'textured.png' });
    const pool = objFiles.map((f) => ({ name: f.name, data: toBuf(f.data) }));
    const texBack = (await importFile(pool[0], pool))[0];
    check('텍스처 OBJ(+MTL+PNG) 왕복', objFiles.length === 3 && !!texBack.texture && texBack.texture.canvas.width === 512 && !!texBack.data.uvs && triangleCount(texBack.data) === triangleCount(base), `파일 ${objFiles.map((f) => f.name).join(', ')}`);
    const glbFiles = await exportMesh('glb', texMesh, 'textured', { canvas: cv, name: 'textured.png' });
    const glbBack = (await importFile({ name: 'textured.glb', data: toBuf(glbFiles[0].data) }, []))[0];
    check('텍스처 GLB 왕복', !!glbBack.texture && !!glbBack.data.uvs && triangleCount(glbBack.data) === triangleCount(base));
    S().set({ objects: S().objects.map((o) => ({ ...o, visible: false, checked: false })) });
    const texObj = actions.addObjects([{ name: '텍스처 모델', data: texBack.data, texture: texBack.texture }])[0];
    actions.setTool('texture');
    getViewer()?.fitView();
    await shot('11-텍스처모델');
    await actions.textureToVertexColors();
    const baked = S().objects.find((o) => o.id === texObj.id)!;
    // 점군(포인트 클라우드) 경로
    const scan = truth[0].mesh;
    const cloudObj = actions.addObjects([{ name: '점군 시험', data: { positions: scan.positions, indices: null, normals: null, colors: scan.colors, uvs: null } }])[0];
    only((n) => n === '점군 시험');
    S().set({ objects: S().objects.map((o) => ({ ...o, visible: o.id === cloudObj.id })) });
    getViewer()?.fitView();
    await wait(200);
    getViewer()?.renderNow();
    const cw = host.clientWidth, chh = host.clientHeight;
    const cmask = getViewer()!.computeSelection([{ x: cw * 0.4, y: chh * 0.4 }, { x: cw * 0.6, y: chh * 0.4 }, { x: cw * 0.6, y: chh * 0.6 }, { x: cw * 0.4, y: chh * 0.6 }], true);
    actions.applySelection(cmask, false);
    const pBefore = vertexCount(cloudObj.data), pSel = S().selectionCount;
    await shot('12-점군-선택');
    await actions.deleteSelected();
    const cloud2 = S().objects.find((o) => o.id === cloudObj.id)!;
    check('점군 표시·선택·삭제', pSel > 0 && vertexCount(cloud2.data) === pBefore - pSel, `점 ${pBefore} → ${vertexCount(cloud2.data)}`);
    actions.undo();
    await actions.runFuse(0, true);
    const cloudFused = S().objects[S().objects.length - 1];
    check('점군 → 메시 퓨전 (법선 자동 추정)', triangleCount(cloudFused.data) > 5000, actions.describe(cloudFused.data));
    await shot('13-점군퓨전');
    const xyz = Array.from({ length: 500 }, (_, i) => `${i * 0.1} ${Math.sin(i)} ${Math.cos(i)} ${i % 256} 128 64`).join(String.fromCharCode(10));
    const xyzBack = (await importFile({ name: 'cloud.xyz', data: new TextEncoder().encode(xyz).buffer as ArrayBuffer }, []))[0];
    check('XYZ 텍스트 점군 불러오기', vertexCount(xyzBack.data) === 500 && !xyzBack.data.indices && !!xyzBack.data.colors);
    only((n) => n === '텍스처 모델');

    // 디스크 저장·열기 (자동 검증 모드에서는 대화상자 대신 검증 폴더를 쓴다)
    const nBefore = S().objects.length;
    await actions.exportChecked('obj');
    await actions.saveProject();
    await actions.importDialog();
    const added = S().objects.slice(nBefore);
    const fromObj = added.find((o) => o.name === '텍스처 모델' && !!o.texture);
    check(
      '디스크 저장·열기 (OBJ+MTL+PNG, 프로젝트 파일)',
      !!fromObj && triangleCount(fromObj.data) === triangleCount(base) && added.length === 1 + nBefore && S().logs.some((l) => l.text.startsWith('내보냄:')) && S().logs.some((l) => l.text.startsWith('프로젝트 저장:')),
      `새로 열린 객체 ${added.length}개 (OBJ 1 + 프로젝트 ${nBefore})`,
    );
    check('텍스처 → 정점 색 굽기', !!baked.data.colors && baked.data.colors.some((v) => v > 0.5) && baked.data.colors.some((v) => v < 0.3));
    void IDENTITY;

    // Artec Ray II 원본 프로젝트 (환경 변수 DEPTH_LIDAR_RAY_TEST로 경로를 준 경우에만)
    const rayProject = await bridge!.rayOpen();
    if (rayProject) {
      const scans = rayProject.projects.flatMap((p) => p.scans.map((scan) => ({ project: p.name, scan })));
      check('Ray II 프로젝트 목록 읽기', scans.length > 0, `프로젝트 ${rayProject.projects.length}개 · 스캔 ${scans.length}개`);
      // 대화창 표시 확인
      S().set({ rayDialog: rayProject });
      await wait(300);
      await shot('14-Ray대화창');
      S().set({ rayDialog: null });
      for (const o of S().objects) actions.updateObject(o.id, { visible: false, checked: false });
      const n0 = S().objects.length;
      const t0 = performance.now();
      const pick = [scans[0], scans[1]].filter(Boolean);
      const done = await actions.importRayScans(pick, 16, { maxRange: 60 });
      const sec = (performance.now() - t0) / 1000;
      const added = S().objects.slice(n0);
      check('Ray II 스캔 불러오기', done === pick.length && added.length === pick.length && added.every((o) => !o.data.indices && vertexCount(o.data) > 100000 && !!o.data.colors), `${added.map((o) => `${o.name}: ${actions.describe(o.data)}`).join(' / ')} · ${sec.toFixed(1)}초`);
      S().set({ view: { ...S().view, grid: false } });
      for (const o of added.slice(1)) actions.updateObject(o.id, { visible: false });
      getViewer()?.fitView();
      getViewer()?.setPreset('iso');
      await wait(600);
      await shot('15-Ray스캔-등각');
      getViewer()?.setPreset('top');
      await wait(600);
      await shot('16-Ray스캔-위');
    }
  } catch (e) {
    error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
  }
  await bridge!.selfTestDone({
    passed: checks.filter((c) => c.pass).length,
    total: checks.length,
    error,
    checks,
    logs: S().logs.map((l) => `[${l.level}] ${l.text}`),
    objects: S().objects.map((o) => ({ name: o.name, desc: actions.describe(o.data), visible: o.visible })),
  });
}
