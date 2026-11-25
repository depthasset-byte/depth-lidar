import { Copy, Eye, EyeOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import * as actions from '../actions';
import { useApp } from '../store';

export function Workspace() {
  const objects = useApp((s) => s.objects);
  const gizmo = useApp((s) => s.gizmo);
  const [editing, setEditing] = useState<string | null>(null);
  const allChecked = objects.length > 0 && objects.every((o) => o.checked);
  return (
    <aside className="workspace">
      <div className="ws-head">
        <label className="chk" title="모두 체크/해제">
          <input type="checkbox" checked={allChecked} onChange={(e) => actions.setAllChecked(e.target.checked)} />
        </label>
        <strong>작업공간</strong>
        <span className="spacer" />
        <button className="icon-btn" title="체크한 객체 복제" onClick={actions.duplicateChecked}><Copy size={15} /></button>
        <button className="icon-btn" title="체크한 객체 삭제" onClick={actions.deleteChecked}><Trash2 size={15} /></button>
      </div>
      <div className="ws-list">
        {objects.length === 0 && <div className="dim pad">객체가 없습니다.</div>}
        {objects.map((o) => (
          <div key={o.id} className={`ws-row ${o.checked ? 'checked' : ''} ${gizmo?.id === o.id ? 'gizmo' : ''}`}>
            <input type="checkbox" checked={o.checked} onChange={(e) => actions.updateObject(o.id, { checked: e.target.checked })} title="도구 적용 대상" />
            <button className="icon-btn" onClick={() => actions.updateObject(o.id, { visible: !o.visible })} title="보이기/숨기기">
              {o.visible ? <Eye size={15} /> : <EyeOff size={15} className="dim" />}
            </button>
            <input type="color" className="swatch" value={o.color} onChange={(e) => actions.updateObject(o.id, { color: e.target.value })} title="표시 색" />
            <div className="ws-name" onDoubleClick={() => setEditing(o.id)}>
              {editing === o.id ? (
                <input
                  autoFocus
                  defaultValue={o.name}
                  onBlur={(e) => { actions.updateObject(o.id, { name: e.target.value.trim() || o.name }); setEditing(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }}
                />
              ) : (
                <span title="더블클릭해 이름 바꾸기">{o.name}</span>
              )}
              <small>
                {o.data.indices ? '메시' : '점군'} · {actions.describe(o.data)}
                {o.texture ? ' · 텍스처' : o.data.colors ? ' · 색' : ''}
              </small>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
