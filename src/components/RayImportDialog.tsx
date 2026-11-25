import { useEffect, useMemo, useState } from 'react';
import * as actions from '../actions';
import { RAY_DENSITY, RayScanMeta, rayPointEstimate } from '../io/ray';
import { useApp } from '../store';
import { getViewer } from './Viewport';

const nf = (n: number) => n.toLocaleString('ko-KR');

/** Artec Ray II 프로젝트에서 불러올 스캔과 촘촘함을 고르는 대화창. */
export function RayImportDialog() {
  const ray = useApp((s) => s.rayDialog);
  const set = useApp((s) => s.set);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [density, setDensity] = useState('fast');
  const [level, setLevel] = useState(true);
  const [maxRange, setMaxRange] = useState(60);
  useEffect(() => setOff({}), [ray]);

  const all = useMemo(() => (ray ? ray.projects.flatMap((p) => p.scans.map((scan) => ({ project: p.name, scan }))) : []), [ray]);
  if (!ray) return null;
  const step = RAY_DENSITY.find((d) => d.id === density)?.step ?? 16;
  const chosen = all.filter((it) => !off[it.scan.dir]);
  const points = chosen.reduce((sum, it) => sum + rayPointEstimate(it.scan, step), 0);
  const close = () => set({ rayDialog: null });
  const toggle = (scan: RayScanMeta) => setOff({ ...off, [scan.dir]: !off[scan.dir] });
  const setProject = (name: string, checked: boolean) => {
    const next = { ...off };
    for (const it of all) if (it.project === name) next[it.scan.dir] = !checked;
    setOff(next);
  };
  const run = async () => {
    close();
    const n = await actions.importRayScans(chosen, step, { level, maxRange: maxRange > 0 ? maxRange : undefined });
    if (n) getViewer()?.fitView();
  };

  return (
    <div className="modal" onClick={close}>
      <div className="modal-card ray-card" onClick={(e) => e.stopPropagation()}>
        <h3>Artec Ray II 스캔 불러오기</h3>
        <div className="note ray-path">{ray.root}</div>
        <div className="ray-list">
          {ray.projects.map((p) => {
            const mine = all.filter((it) => it.project === p.name);
            const on = mine.filter((it) => !off[it.scan.dir]).length;
            return (
              <div key={p.folder || p.name} className="ray-project">
                <label className="ray-row head">
                  <input type="checkbox" checked={on === mine.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < mine.length; }} onChange={(e) => setProject(p.name, e.target.checked)} />
                  <b>{p.name}</b>
                  <span>스캔 {mine.length}개</span>
                </label>
                {p.scans.map((scan) => (
                  <label key={scan.dir} className="ray-row">
                    <input type="checkbox" checked={!off[scan.dir]} onChange={() => toggle(scan)} />
                    <span className="ray-name">{scan.name}</span>
                    <span>{nf(scan.lines)} × {nf(scan.samples)}</span>
                    <span>{scan.resolution}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
        <label className="field">
          <span>촘촘함</span>
          <select value={density} onChange={(e) => setDensity(e.target.value)}>
            {RAY_DENSITY.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>최대 거리 (m, 0이면 제한 없음)</span>
          <input type="number" min={0} max={200} step={5} value={maxRange} onChange={(e) => setMaxRange(Number(e.target.value) || 0)} />
        </label>
        <label className="ray-row">
          <input type="checkbox" checked={level} onChange={(e) => setLevel(e.target.checked)} />
          <span>기울기 센서 값으로 수평 맞추기</span>
        </label>
        <p className="note">
          고른 스캔 {chosen.length}개 · 약 {nf(points)}점. 스캔마다 포인트 클라우드 객체 하나로 들어오며 색은 레이저 밝기(회색)입니다. 단위는 mm이고 스캔끼리는 아직 정렬되지 않은 상태입니다.
          좌표는 원본 값을 근사 모델로 계산한 것이라 Artec Studio 결과와 조금 다를 수 있습니다.
        </p>
        <div className="row">
          <button className="btn primary" disabled={!chosen.length} onClick={() => void run()}>불러오기</button>
          <button className="btn" onClick={close}>취소</button>
        </div>
      </div>
    </div>
  );
}
