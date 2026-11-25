import { Move, RotateCw, Scaling } from 'lucide-react';
import { ReactNode, useState } from 'react';
import * as actions from '../actions';
import { ToolId, useApp } from '../store';
import { getViewer } from './Viewport';

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="section">
    <h4>{title}</h4>
    {children}
  </div>
);

function Num({ label, value, onChange, min, max, step = 1, unit }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
      {unit && <em>{unit}</em>}
    </label>
  );
}

function Slider({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number }) {
  return (
    <label className="field slider">
      <span>{label}</span>
      <input type="range" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
      <em>{value}</em>
    </label>
  );
}

function EditorPanel() {
  const shape = useApp((s) => s.selectShape);
  const visibleOnly = useApp((s) => s.visibleOnly);
  const count = useApp((s) => s.selectionCount);
  const set = useApp((s) => s.set);
  return (
    <>
      <p className="note">체크한 객체에서 필요 없는 부분을 골라 지웁니다. <b>Ctrl</b>을 누른 채 끌어 영역을 그리세요. <b>Shift</b>를 함께 누르면 선택에서 뺍니다.</p>
      <Section title="선택 도형">
        <div className="seg wide">
          <button className={shape === 'lasso' ? 'on' : ''} onClick={() => set({ selectShape: 'lasso' })}>올가미</button>
          <button className={shape === 'rect' ? 'on' : ''} onClick={() => set({ selectShape: 'rect' })}>사각형</button>
        </div>
        <label className="chk-line">
          <input type="checkbox" checked={visibleOnly} onChange={(e) => set({ visibleOnly: e.target.checked })} />
          보이는 면만 선택 (끄면 뒤쪽까지 관통)
        </label>
      </Section>
      <Section title="선택 영역">
        <div className="stat">{count.toLocaleString('ko-KR')}개 선택됨</div>
        <div className="row">
          <button className="btn danger" disabled={!count} onClick={() => void actions.deleteSelected()}>삭제 (Delete)</button>
          <button className="btn" onClick={actions.invertSelection}>반전</button>
          <button className="btn" disabled={!count} onClick={actions.clearSelection}>해제</button>
        </div>
      </Section>
    </>
  );
}

function ToolsPanel() {
  const gizmo = useApp((s) => s.gizmo);
  const [mode, setMode] = useState<'largest' | 'threshold'>('threshold');
  const [minTri, setMinTri] = useState(500);
  const [maxEdges, setMaxEdges] = useState(60);
  const [iters, setIters] = useState(5);
  const [strength, setStrength] = useState(0.5);
  const [taubin, setTaubin] = useState(true);
  const [percent, setPercent] = useState(50);
  const [voxel, setVoxel] = useState(0);
  const [clean, setClean] = useState(true);
  return (
    <>
      <p className="note">작업공간에서 체크한 객체에 적용됩니다. 모든 작업은 Ctrl+Z로 되돌릴 수 있습니다.</p>
      <Section title="변환 (이동·회전·크기)">
        <div className="seg wide">
          <button className={gizmo?.mode === 'translate' ? 'on' : ''} onClick={() => actions.setGizmo('translate')}><Move size={14} />이동</button>
          <button className={gizmo?.mode === 'rotate' ? 'on' : ''} onClick={() => actions.setGizmo('rotate')}><RotateCw size={14} />회전</button>
          <button className={gizmo?.mode === 'scale' ? 'on' : ''} onClick={() => actions.setGizmo('scale')}><Scaling size={14} />크기</button>
        </div>
        <div className="row">
          <button className="btn" disabled={!gizmo} onClick={() => actions.setGizmo(null)}>조작기 끄기</button>
          <button className="btn" onClick={actions.centerToOrigin}>원점 바닥에 놓기</button>
          <button className="btn" onClick={actions.resetTransform}>초기화</button>
        </div>
      </Section>
      <Section title="작은 조각 제거">
        <div className="seg wide">
          <button className={mode === 'threshold' ? 'on' : ''} onClick={() => setMode('threshold')}>기준 미만 제거</button>
          <button className={mode === 'largest' ? 'on' : ''} onClick={() => setMode('largest')}>가장 큰 것만</button>
        </div>
        {mode === 'threshold' && <Num label="최소 면 수" value={minTri} min={1} onChange={setMinTri} />}
        <button className="btn primary" onClick={() => void actions.runRemoveSmall(mode, minTri)}>실행</button>
      </Section>
      <Section title="작은 구멍 자동 메우기">
        <Num label="최대 테두리 간선 수" value={maxEdges} min={3} onChange={setMaxEdges} />
        <button className="btn primary" onClick={() => void actions.runFillSmallHoles(maxEdges)}>실행</button>
      </Section>
      <Section title="스무딩">
        <Num label="반복 횟수" value={iters} min={1} max={200} onChange={setIters} />
        <Slider label="강도" value={strength} min={0.05} max={1} step={0.05} onChange={setStrength} />
        <label className="chk-line">
          <input type="checkbox" checked={taubin} onChange={(e) => setTaubin(e.target.checked)} />
          부피 유지 (타우빈)
        </label>
        <button className="btn primary" onClick={() => void actions.runSmooth(iters, strength, taubin)}>실행</button>
      </Section>
      <Section title="메시 단순화">
        <Slider label="남길 면 비율 %" value={percent} min={1} max={99} step={1} onChange={setPercent} />
        <button className="btn primary" onClick={() => void actions.runSimplify(percent)}>실행</button>
      </Section>
      <Section title="법선">
        <button className="btn" onClick={() => void actions.runFlip()}>법선 뒤집기</button>
      </Section>
      <Section title="퓨전 (스캔 합치기)">
        <p className="note">정렬을 마친 스캔들을 체크한 뒤 실행하면 하나의 메시로 합칩니다.</p>
        <Num label="해상도 (0 = 자동)" value={voxel} min={0} step={0.1} onChange={setVoxel} />
        <label className="chk-line">
          <input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} />
          떠 있는 작은 조각 정리
        </label>
        <button className="btn primary" onClick={() => void actions.runFuse(voxel, clean)}>퓨전 실행</button>
      </Section>
    </>
  );
}

function AlignPanel() {
  const objects = useApp((s) => s.objects);
  const fixedId = useApp((s) => s.alignFixedId);
  const movingId = useApp((s) => s.alignMovingId);
  const pairs = useApp((s) => s.alignPairs);
  const picking = useApp((s) => s.alignPicking);
  const set = useApp((s) => s.set);
  const [refine, setRefine] = useState(true);
  const complete = pairs.filter((p) => p.fixed && p.moving).length;
  const opts = objects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>);
  return (
    <>
      <p className="note">이동 객체를 기준 객체에 맞춥니다. 기준 객체는 움직이지 않습니다.</p>
      <Section title="대상">
        <label className="field">
          <span>기준 (고정)</span>
          <select value={fixedId ?? ''} onChange={(e) => set({ alignFixedId: e.target.value || null, alignPairs: [] })}>
            <option value="">선택…</option>
            {opts}
          </select>
        </label>
        <label className="field">
          <span>이동</span>
          <select value={movingId ?? ''} onChange={(e) => set({ alignMovingId: e.target.value || null, alignPairs: [] })}>
            <option value="">선택…</option>
            {opts}
          </select>
        </label>
      </Section>
      <Section title="자동 정렬">
        <button className="btn primary" onClick={() => void actions.alignAuto('icp')}>정밀 정렬 (가까이 있을 때)</button>
        <button className="btn" onClick={() => void actions.alignAuto('coarse')}>위치 무관 자동 정렬 (실험적)</button>
        <p className="note">정밀 정렬은 두 스캔이 대략 겹쳐 있을 때 씁니다. 많이 어긋나 있으면 아래 점 정렬을 먼저 하세요.</p>
      </Section>
      <Section title="점 정렬 (수동)">
        <button className={`btn ${picking ? 'on' : ''}`} onClick={() => set({ alignPicking: !picking })}>{picking ? '점 찍기 중지' : '점 찍기 시작'}</button>
        <div className="stat">대응점 {complete}쌍 완성 {pairs.length > complete ? `(미완성 ${pairs.length - complete})` : ''}</div>
        <div className="row">
          <button className="btn" disabled={!pairs.length} onClick={() => set({ alignPairs: pairs.slice(0, -1) })}>마지막 쌍 지우기</button>
          <button className="btn" disabled={!pairs.length} onClick={() => set({ alignPairs: [] })}>모두 지우기</button>
        </div>
        <label className="chk-line">
          <input type="checkbox" checked={refine} onChange={(e) => setRefine(e.target.checked)} />
          점 정렬 뒤 정밀 정렬까지 실행
        </label>
        <button className="btn primary" disabled={complete < 3} onClick={() => void actions.alignByPairs(refine)}>점으로 정렬 (3쌍 이상)</button>
      </Section>
    </>
  );
}

function HolesPanel() {
  const holes = useApp((s) => s.holes);
  const objects = useApp((s) => s.objects);
  const set = useApp((s) => s.set);
  const name = holes ? objects.find((o) => o.id === holes.objectId)?.name : null;
  const setAll = (checked: boolean) => holes && set({ holes: { ...holes, items: holes.items.map((h) => ({ ...h, checked })) } });
  return (
    <>
      <p className="note">체크한 첫 번째 메시의 뚫린 테두리를 찾아 목록으로 보여 줍니다. 메울 구멍을 고른 뒤 실행하세요.</p>
      <Section title="구멍 목록">
        <button className="btn primary" onClick={() => void actions.detectHoles()}>구멍 찾기</button>
        {holes && (
          <>
            <div className="stat">{name}: 경계 {holes.items.length}개</div>
            <div className="row">
              <button className="btn" onClick={() => setAll(true)}>모두 선택</button>
              <button className="btn" onClick={() => setAll(false)}>모두 해제</button>
            </div>
            <div className="list">
              {holes.items.map((h, i) => (
                <label key={i} className="chk-line">
                  <input
                    type="checkbox"
                    checked={h.checked}
                    onChange={(e) => set({ holes: { ...holes, items: holes.items.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)) } })}
                  />
                  #{i + 1} · 간선 {h.vertices.length} · 둘레 {h.perimeter.toFixed(2)}
                </label>
              ))}
            </div>
            <button className="btn primary" disabled={!holes.items.some((h) => h.checked)} onClick={() => void actions.fillCheckedHoles()}>선택한 구멍 메우기</button>
          </>
        )}
      </Section>
    </>
  );
}

function TexturePanel() {
  const view = useApp((s) => s.view);
  const set = useApp((s) => s.set);
  const [a, setA] = useState({ brightness: 0, contrast: 1, saturation: 1, gamma: 1 });
  return (
    <>
      <p className="note">불러온 텍스처와 정점 색을 표시·보정합니다. 스캐너 촬영 사진으로 텍스처를 새로 입히는 기능은 없습니다.</p>
      <Section title="표시">
        <label className="chk-line">
          <input type="checkbox" checked={view.showColor} onChange={(e) => set({ view: { ...view, showColor: e.target.checked } })} />
          텍스처·정점 색 표시
        </label>
      </Section>
      <Section title="색 보정">
        <Slider label="밝기" value={a.brightness} min={-0.5} max={0.5} step={0.05} onChange={(v) => setA({ ...a, brightness: v })} />
        <Slider label="대비" value={a.contrast} min={0.5} max={2} step={0.05} onChange={(v) => setA({ ...a, contrast: v })} />
        <Slider label="채도" value={a.saturation} min={0} max={2} step={0.05} onChange={(v) => setA({ ...a, saturation: v })} />
        <Slider label="감마" value={a.gamma} min={0.4} max={2.5} step={0.05} onChange={(v) => setA({ ...a, gamma: v })} />
        <div className="row">
          <button className="btn primary" onClick={() => void actions.adjustColors(a)}>적용</button>
          <button className="btn" onClick={() => setA({ brightness: 0, contrast: 1, saturation: 1, gamma: 1 })}>값 초기화</button>
        </div>
      </Section>
      <Section title="변환·제거">
        <button className="btn" onClick={() => void actions.textureToVertexColors()}>텍스처 → 정점 색으로 굽기</button>
        <button className="btn" onClick={() => void actions.removeColors('texture')}>텍스처 제거</button>
        <button className="btn" onClick={() => void actions.removeColors('colors')}>정점 색 제거</button>
      </Section>
    </>
  );
}

function MeasurePanel() {
  const mode = useApp((s) => s.measureMode);
  const pts = useApp((s) => s.distancePoints);
  const axis = useApp((s) => s.sectionAxis);
  const offset = useApp((s) => s.sectionOffset);
  const sec = useApp((s) => s.sectionResult);
  const rows = useApp((s) => s.infoRows);
  const set = useApp((s) => s.set);
  let total = 0;
  const segs: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    segs.push(d);
    total += d;
  }
  const v = getViewer();
  const c = v ? v.sceneCenter()[axis] : 0;
  const r = v ? v.sceneRadius() : 100;
  return (
    <>
      <div className="seg wide">
        <button className={mode === 'distance' ? 'on' : ''} onClick={() => set({ measureMode: 'distance' })}>거리</button>
        <button className={mode === 'section' ? 'on' : ''} onClick={() => set({ measureMode: 'section' })}>단면</button>
        <button className={mode === 'info' ? 'on' : ''} onClick={() => set({ measureMode: 'info' })}>치수·부피</button>
      </div>
      <p className="note">단위는 파일에 저장된 단위 그대로입니다 (스캔 데이터는 보통 mm).</p>
      {mode === 'distance' && (
        <Section title="점 사이 거리">
          <p className="note">표면을 차례로 클릭하면 점을 잇는 선의 길이를 잽니다.</p>
          <div className="list">
            {segs.map((d, i) => (
              <div key={i} className="kv"><span>{i + 1} → {i + 2}</span><b>{d.toFixed(3)}</b></div>
            ))}
          </div>
          <div className="stat">점 {pts.length}개 · 합계 {total.toFixed(3)}</div>
          <div className="row">
            <button className="btn" disabled={!pts.length} onClick={() => set({ distancePoints: pts.slice(0, -1) })}>마지막 점 지우기</button>
            <button className="btn" disabled={!pts.length} onClick={() => set({ distancePoints: [] })}>모두 지우기</button>
          </div>
        </Section>
      )}
      {mode === 'section' && (
        <Section title="평면 단면">
          <div className="seg wide">
            {(['X', 'Y', 'Z'] as const).map((n, i) => (
              <button key={n} className={axis === i ? 'on' : ''} onClick={() => set({ sectionAxis: i as 0 | 1 | 2, sectionOffset: Number((v ? v.sceneCenter()[i] : 0).toFixed(3)), sectionResult: null })}>{n}축에 수직</button>
            ))}
          </div>
          <label className="field slider">
            <span>위치</span>
            <input type="range" min={c - r} max={c + r} step={r / 200} value={offset} onChange={(e) => set({ sectionOffset: Number(e.target.value), sectionResult: null })} />
          </label>
          <Num label="위치 값" value={Number(offset.toFixed(3))} step={0.1} onChange={(x) => set({ sectionOffset: x, sectionResult: null })} />
          <button className="btn primary" onClick={() => void actions.computeSection()}>단면 계산</button>
          {sec && (
            <div className="list">
              <div className="kv"><span>윤곽 길이</span><b>{sec.length.toFixed(3)}</b></div>
              <div className="kv"><span>닫힌 윤곽</span><b>{sec.closedLoops}개</b></div>
              <div className="kv"><span>닫힌 윤곽 면적 합</span><b>{sec.area.toFixed(3)}</b></div>
              {sec.openChains > 0 && <div className="kv warn"><span>열린 윤곽</span><b>{sec.openChains}개</b></div>}
            </div>
          )}
        </Section>
      )}
      {mode === 'info' && (
        <Section title="치수·표면적·부피">
          <button className="btn primary" onClick={() => void actions.computeInfo()}>체크한 객체 계산</button>
          {rows.map((row, i) => (
            <div key={i} className="list">
              <div className="kv head"><span>{row.name}</span></div>
              <div className="kv"><span>크기 X×Y×Z</span><b>{row.info.size.map((x) => x.toFixed(2)).join(' × ')}</b></div>
              <div className="kv"><span>표면적</span><b>{row.info.area.toFixed(2)}</b></div>
              <div className="kv"><span>부피</span><b>{row.info.triangles ? row.info.volume.toFixed(2) : '-'}</b></div>
              {row.info.triangles > 0 && !row.info.closed && <div className="kv warn"><span>열린 메시 (경계 간선 {row.info.boundaryEdges})</span><b>부피는 참고값</b></div>}
              <div className="kv"><span>정점 / 면</span><b>{row.info.vertices.toLocaleString('ko-KR')} / {row.info.triangles.toLocaleString('ko-KR')}</b></div>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

const TITLES: Record<ToolId, string> = { editor: '편집기', tools: '도구', align: '정렬', holes: '구멍 메우기', texture: '텍스처', measure: '측정' };

export function ToolPanel({ tool }: { tool: ToolId }) {
  return (
    <aside className="panel">
      <div className="panel-head">
        <strong>{TITLES[tool]}</strong>
        <button className="icon-btn" onClick={() => actions.setTool(null)} title="닫기">✕</button>
      </div>
      <div className="panel-body">
        {tool === 'editor' && <EditorPanel />}
        {tool === 'tools' && <ToolsPanel />}
        {tool === 'align' && <AlignPanel />}
        {tool === 'holes' && <HolesPanel />}
        {tool === 'texture' && <TexturePanel />}
        {tool === 'measure' && <MeasurePanel />}
      </div>
    </aside>
  );
}
