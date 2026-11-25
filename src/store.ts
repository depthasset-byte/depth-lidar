import type { RayOpenResult } from './io/ray';
import { create } from 'zustand';
import type { MeshInfo } from './geometry/measure';
import type { Mat4, MeshData } from './geometry/mesh';

export type Vec3 = [number, number, number];

export interface TextureInfo {
  canvas: HTMLCanvasElement;
  name: string;
}

export interface ScanObject {
  id: string;
  name: string;
  data: MeshData;
  matrix: Mat4;
  visible: boolean;
  checked: boolean;
  color: string;
  texture: TextureInfo | null;
}

export type ToolId = 'editor' | 'tools' | 'align' | 'holes' | 'texture' | 'measure';

export interface ViewSettings {
  mode: 'solid' | 'wire' | 'points';
  showColor: boolean;
  flat: boolean;
  grid: boolean;
  ortho: boolean;
}

export interface HoleItem {
  vertices: Uint32Array;
  perimeter: number;
  checked: boolean;
}

export interface AlignPair {
  fixed: Vec3 | null;
  moving: Vec3 | null;
}

export interface SectionState {
  segments: Float32Array;
  length: number;
  area: number;
  closedLoops: number;
  openChains: number;
}

export interface LogEntry {
  time: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface AppState {
  objects: ScanObject[];
  tool: ToolId | null;
  view: ViewSettings;
  busy: string | null;
  logs: LogEntry[];
  undoStack: ScanObject[][];
  redoStack: ScanObject[][];
  projectName: string | null;
  /** 열어 둔 Artec Ray II 프로젝트(불러오기 대화창). 없으면 null */
  rayDialog: RayOpenResult | null;
  // 편집기(지우개)
  selectShape: 'rect' | 'lasso';
  visibleOnly: boolean;
  selection: Record<string, Uint8Array>;
  selectionCount: number;
  // 구멍 메우기
  holes: { objectId: string; items: HoleItem[] } | null;
  // 정렬
  alignFixedId: string | null;
  alignMovingId: string | null;
  alignPairs: AlignPair[];
  alignPicking: boolean;
  // 변환 도구
  gizmo: { id: string; mode: 'translate' | 'rotate' | 'scale' } | null;
  // 측정
  measureMode: 'distance' | 'section' | 'info';
  distancePoints: Vec3[];
  sectionAxis: 0 | 1 | 2;
  sectionOffset: number;
  sectionResult: SectionState | null;
  infoRows: { name: string; info: MeshInfo }[];
  set: (p: Partial<AppState>) => void;
  log: (text: string, level?: LogEntry['level']) => void;
}

export const PALETTE = ['#b9c4d0', '#d9b48f', '#9fc7a4', '#c9a6cf', '#e0cf8a', '#8fb8d9', '#d99f9f', '#a8d3cf'];

export const useApp = create<AppState>((set) => ({
  objects: [],
  tool: null,
  view: { mode: 'solid', showColor: true, flat: false, grid: true, ortho: false },
  busy: null,
  logs: [],
  undoStack: [],
  redoStack: [],
  projectName: null,
  rayDialog: null,
  selectShape: 'lasso',
  visibleOnly: true,
  selection: {},
  selectionCount: 0,
  holes: null,
  alignFixedId: null,
  alignMovingId: null,
  alignPairs: [],
  alignPicking: false,
  gizmo: null,
  measureMode: 'distance',
  distancePoints: [],
  sectionAxis: 1,
  sectionOffset: 0,
  sectionResult: null,
  infoRows: [],
  set: (p) => set(p),
  log: (text, level = 'info') =>
    set((s) => ({
      logs: [...s.logs.slice(-300), { time: new Date().toTimeString().slice(0, 8), level, text }],
    })),
}));

let idSeq = 0;
export const newId = () => `o${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export const checkedObjects = () => useApp.getState().objects.filter((o) => o.checked);
export const findObject = (id: string | null) => useApp.getState().objects.find((o) => o.id === id) ?? null;
