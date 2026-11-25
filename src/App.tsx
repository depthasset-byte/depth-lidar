import { RayImportDialog } from './components/RayImportDialog';
import { CircleDashed, Combine, Eraser, Image, Ruler, Wrench } from 'lucide-react';
import { useEffect, useRef } from 'react';
import * as actions from './actions';
import { MenuBar } from './components/MenuBar';
import { ToolPanel } from './components/panels';
import { Viewport, getViewer } from './components/Viewport';
import { Workspace } from './components/Workspace';
import { triangleCount, vertexCount } from './geometry/mesh';
import { bridge } from './io/platform';
import { runSelfTest } from './selftest';
import { ToolId, useApp } from './store';

const TOOLS: { id: ToolId; label: string; icon: typeof Eraser }[] = [
  { id: 'editor', label: '편집기', icon: Eraser },
  { id: 'tools', label: '도구', icon: Wrench },
  { id: 'align', label: '정렬', icon: Combine },
  { id: 'holes', label: '구멍 메우기', icon: CircleDashed },
  { id: 'texture', label: '텍스처', icon: Image },
  { id: 'measure', label: '측정', icon: Ruler },
];

function Sidebar() {
  const tool = useApp((s) => s.tool);
  return (
    <nav className="sidebar">
      {TOOLS.map((t) => (
        <button key={t.id} className={`side-btn ${tool === t.id ? 'active' : ''}`} onClick={() => actions.setTool(tool === t.id ? null : t.id)} title={t.label}>
          <t.icon size={22} strokeWidth={1.6} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

function LogPanel() {
  const logs = useApp((s) => s.logs);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [logs]);
  return (
    <div className="log" ref={ref}>
      {logs.length === 0 && <div className="log-line dim">작업 기록이 여기에 표시됩니다.</div>}
      {logs.map((l, i) => (
        <div key={i} className={`log-line ${l.level}`}>
          <span className="log-time">{l.time}</span>
          {l.text}
        </div>
      ))}
    </div>
  );
}

function StatusBar() {
  const objects = useApp((s) => s.objects);
  const sel = useApp((s) => s.selectionCount);
  let v = 0, t = 0;
  for (const o of objects) {
    v += vertexCount(o.data);
    t += triangleCount(o.data);
  }
  return (
    <div className="status">
      <span>객체 {objects.length}개 (체크 {objects.filter((o) => o.checked).length})</span>
      <span>정점 {v.toLocaleString('ko-KR')}</span>
      <span>면 {t.toLocaleString('ko-KR')}</span>
      {sel > 0 && <span className="accent">선택 {sel.toLocaleString('ko-KR')}</span>}
      <span className="spacer" />
      <span>왼쪽 드래그 회전 · 오른쪽 드래그 이동 · 휠 확대 · 더블클릭 회전 중심</span>
    </div>
  );
}

export function App() {
  const busy = useApp((s) => s.busy);
  const tool = useApp((s) => s.tool);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); actions.undo(); }
      else if ((e.ctrlKey && k === 'y') || (e.ctrlKey && e.shiftKey && k === 'z')) { e.preventDefault(); actions.redo(); }
      else if (e.ctrlKey && k === 'o') { e.preventDefault(); void actions.importDialog(); }
      else if (e.ctrlKey && k === 's') { e.preventDefault(); void actions.saveProject(); }
      else if (k === 'delete') {
        if (useApp.getState().selectionCount) void actions.deleteSelected();
      } else if (k === 'f' && !e.ctrlKey) getViewer()?.fitView();
      else if (k === 'escape') {
        const s = useApp.getState();
        if (s.alignPicking) s.set({ alignPicking: false });
        else if (s.selectionCount) actions.clearSelection();
        else if (s.gizmo) s.set({ gizmo: null });
      }
    };
    window.addEventListener('keydown', onKey);
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      const picked = [];
      for (const f of files) picked.push({ name: f.name, data: await f.arrayBuffer() });
      void actions.importPicked(picked);
    };
    const onOver = (e: DragEvent) => e.preventDefault();
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onOver);
    // 자동 검증·디버깅용 창구
    (window as unknown as Record<string, unknown>).__scan = { store: useApp, actions, viewer: getViewer };
    if (bridge?.selfTest) void runSelfTest();
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onOver);
    };
  }, []);

  return (
    <div className="app">
      <MenuBar />
      <div className="main">
        <Sidebar />
        {tool && <ToolPanel tool={tool} />}
        <Viewport />
        <Workspace />
      </div>
      <LogPanel />
      <StatusBar />
      <RayImportDialog />
      {busy && (
        <div className="busy">
          <div className="busy-card">
            <div className="spinner" />
            {busy}…
          </div>
        </div>
      )}
    </div>
  );
}
