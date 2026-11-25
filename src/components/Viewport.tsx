import { Box, Grid3x3, Layers, Maximize, Palette, Shapes, Triangle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import * as actions from '../actions';
import { useApp } from '../store';
import { ViewPreset, Viewer } from '../viewer/Viewer';

let viewer: Viewer | null = null;
export const getViewer = () => viewer;

const HINTS: Record<string, string> = {
  editor: 'Ctrl+드래그: 영역 선택 · Ctrl+Shift+드래그: 선택 해제 · Delete: 삭제',
  align: '점 찍기를 켠 뒤 기준 객체와 이동 객체의 같은 위치를 번갈아 클릭하세요',
  measure: '거리 모드에서는 표면을 클릭해 점을 찍습니다',
  holes: '주황색: 메울 구멍 · 파란색: 제외한 경계',
};

export function Viewport() {
  const ref = useRef<HTMLDivElement>(null);
  const view = useApp((s) => s.view);
  const set = useApp((s) => s.set);
  const tool = useApp((s) => s.tool);
  const empty = useApp((s) => s.objects.length === 0);
  const picking = useApp((s) => s.alignPicking);
  const measureMode = useApp((s) => s.measureMode);

  useEffect(() => {
    const v = new Viewer(ref.current!, {
      onPick: actions.handlePick,
      onSelection: actions.applySelection,
      onGizmoCommit: actions.commitGizmo,
    });
    viewer = v;
    v.sync(useApp.getState());
    const unsub = useApp.subscribe((s) => v.sync(s));
    return () => {
      unsub();
      v.dispose();
      if (viewer === v) viewer = null;
    };
  }, []);

  const setView = (p: Partial<typeof view>) => set({ view: { ...view, ...p } });
  const presets: [ViewPreset, string][] = [['front', '앞'], ['back', '뒤'], ['left', '좌'], ['right', '우'], ['top', '위'], ['bottom', '아래'], ['iso', '등각']];
  const hint = tool === 'measure' && measureMode !== 'distance' ? null : tool === 'align' && !picking ? null : tool ? HINTS[tool] : null;

  return (
    <section className="viewport">
      <div className="canvas-host" ref={ref} />
      <div className="vp-toolbar">
        <div className="seg">
          <button className={view.mode === 'solid' ? 'on' : ''} onClick={() => setView({ mode: 'solid' })} title="솔리드"><Box size={15} />솔리드</button>
          <button className={view.mode === 'wire' ? 'on' : ''} onClick={() => setView({ mode: 'wire' })} title="와이어프레임"><Triangle size={15} />와이어</button>
          <button className={view.mode === 'points' ? 'on' : ''} onClick={() => setView({ mode: 'points' })} title="포인트"><Shapes size={15} />포인트</button>
        </div>
        <div className="seg">
          <button className={view.showColor ? 'on' : ''} onClick={() => setView({ showColor: !view.showColor })} title="텍스처·정점 색 표시"><Palette size={15} />색</button>
          <button className={view.flat ? 'on' : ''} onClick={() => setView({ flat: !view.flat })} title="평면 음영"><Layers size={15} />평면 음영</button>
          <button className={view.grid ? 'on' : ''} onClick={() => setView({ grid: !view.grid })} title="격자"><Grid3x3 size={15} />격자</button>
          <button className={view.ortho ? 'on' : ''} onClick={() => setView({ ortho: !view.ortho })} title="직교 투영">직교</button>
        </div>
        <div className="seg">
          <button onClick={() => viewer?.fitView()} title="화면에 맞춤 (F)"><Maximize size={15} />맞춤</button>
          {presets.map(([p, label]) => (
            <button key={p} onClick={() => viewer?.setPreset(p)}>{label}</button>
          ))}
        </div>
      </div>
      {hint && <div className="vp-hint">{hint}</div>}
      {empty && (
        <div className="empty">
          <h2>스캔 데이터를 불러오세요</h2>
          <p>OBJ · PLY · STL · GLB · XYZ 파일을 이 창에 끌어다 놓거나 아래 버튼을 누르세요.</p>
          <div className="row center">
            <button className="btn primary" onClick={() => void actions.importDialog()}>파일 가져오기</button>
            <button className="btn" onClick={() => void actions.loadSample('scans')}>샘플 스캔 3장</button>
            <button className="btn" onClick={() => void actions.loadSample('model')}>샘플 모델</button>
          </div>
        </div>
      )}
    </section>
  );
}
