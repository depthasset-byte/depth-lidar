import { useEffect, useState } from 'react';
import * as actions from '../actions';
import { useApp } from '../store';
import { getViewer } from './Viewport';

type Item = { label: string; key?: string; run: () => void } | 'sep';

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const project = useApp((s) => s.projectName);
  const view = useApp((s) => s.view);
  const set = useApp((s) => s.set);
  useEffect(() => {
    const close = () => setOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);
  const menus: Record<string, Item[]> = {
    파일: [
      { label: '새 프로젝트', run: actions.newProject },
      { label: '가져오기… (OBJ·PLY·STL·GLB·XYZ·프로젝트)', key: 'Ctrl+O', run: () => void actions.importDialog() },
      { label: 'Artec Ray II 스캔 불러오기… (project.artec)', run: () => void actions.openRayDialog() },
      { label: '프로젝트 저장…', key: 'Ctrl+S', run: () => void actions.saveProject() },
      'sep',
      { label: '내보내기: OBJ', run: () => void actions.exportChecked('obj') },
      { label: '내보내기: PLY', run: () => void actions.exportChecked('ply') },
      { label: '내보내기: STL', run: () => void actions.exportChecked('stl') },
      { label: '내보내기: GLB', run: () => void actions.exportChecked('glb') },
      'sep',
      { label: '샘플 스캔 3장 불러오기', run: () => void actions.loadSample('scans') },
      { label: '샘플 모델 불러오기', run: () => void actions.loadSample('model') },
    ],
    편집: [
      { label: '실행 취소', key: 'Ctrl+Z', run: actions.undo },
      { label: '다시 실행', key: 'Ctrl+Y', run: actions.redo },
      'sep',
      { label: '선택 영역 삭제', key: 'Delete', run: () => void actions.deleteSelected() },
      { label: '선택 반전', run: actions.invertSelection },
      { label: '선택 해제', key: 'Esc', run: actions.clearSelection },
      'sep',
      { label: '체크한 객체 복제', run: actions.duplicateChecked },
      { label: '체크한 객체 삭제', run: actions.deleteChecked },
    ],
    보기: [
      { label: '화면에 맞춤', key: 'F', run: () => getViewer()?.fitView() },
      'sep',
      { label: '앞', run: () => getViewer()?.setPreset('front') },
      { label: '뒤', run: () => getViewer()?.setPreset('back') },
      { label: '왼쪽', run: () => getViewer()?.setPreset('left') },
      { label: '오른쪽', run: () => getViewer()?.setPreset('right') },
      { label: '위', run: () => getViewer()?.setPreset('top') },
      { label: '아래', run: () => getViewer()?.setPreset('bottom') },
      { label: '등각', run: () => getViewer()?.setPreset('iso') },
      'sep',
      { label: `${view.grid ? '✓ ' : ''}격자`, run: () => set({ view: { ...view, grid: !view.grid } }) },
      { label: `${view.ortho ? '✓ ' : ''}직교 투영`, run: () => set({ view: { ...view, ortho: !view.ortho } }) },
    ],
    도움말: [{ label: '조작법', run: () => setHelp(true) }],
  };
  return (
    <header className="menubar" onPointerDown={(e) => e.stopPropagation()}>
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3" />
          <path d="M12 6l5 3v6l-5 3-5-3V9z" />
        </svg>
        Depth Lidar
      </div>
      {Object.keys(menus).map((name) => (
        <div key={name} className="menu">
          <button className={`menu-btn ${open === name ? 'open' : ''}`} onClick={() => setOpen(open === name ? null : name)} onMouseEnter={() => open && setOpen(name)}>
            {name}
          </button>
          {open === name && (
            <div className="menu-pop">
              {menus[name].map((it, i) =>
                it === 'sep' ? (
                  <div key={i} className="menu-sep" />
                ) : (
                  <button key={i} className="menu-item" onClick={() => { setOpen(null); it.run(); }}>
                    <span>{it.label}</span>
                    {it.key && <kbd>{it.key}</kbd>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
      <div className="project-name">{project ?? '이름 없는 프로젝트'}</div>
      {help && (
        <div className="modal" onClick={() => setHelp(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>조작법</h3>
            <ul>
              <li>왼쪽 드래그: 회전 · 오른쪽 드래그: 이동 · 휠: 확대/축소</li>
              <li>더블클릭: 찍은 곳을 회전 중심으로</li>
              <li>편집기: Ctrl+드래그로 영역 선택, Ctrl+Shift+드래그로 선택 해제, Delete로 삭제</li>
              <li>정렬·측정: 표면을 클릭해 점 찍기</li>
              <li>오른쪽 작업공간에서 체크한 객체에만 도구가 적용됩니다.</li>
              <li>파일을 창에 끌어다 놓아 불러올 수 있습니다 (OBJ는 MTL·텍스처를 함께).</li>
            </ul>
            <button className="btn primary" onClick={() => setHelp(false)}>닫기</button>
          </div>
        </div>
      )}
    </header>
  );
}
