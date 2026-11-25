// 파일 열기·저장 창구. Electron(창 앱)에서는 기본 대화상자를, 브라우저에서는 파일 입력과 다운로드를 쓴다.
import type { RayOpenResult, RayScanMeta } from './ray';

export interface PickedFile {
  name: string;
  data: ArrayBuffer;
  /** Electron에서만: 원본 폴더 */
  dir?: string;
}

export interface OutFile {
  /** 주 파일 이름을 기준으로 붙일 이름 (예: model.obj, model.mtl) */
  name: string;
  data: ArrayBuffer | Uint8Array | string;
}

interface Bridge {
  openFiles(filters: { name: string; extensions: string[] }[]): Promise<PickedFile[]>;
  readSibling(dir: string, name: string): Promise<ArrayBuffer | null>;
  saveDialog(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<{ dir: string; base: string; ext: string } | null>;
  writeFile(dir: string, name: string, data: ArrayBuffer | Uint8Array | string): Promise<string>;
  /** Artec Ray II 프로젝트(project.artec)를 고르고 스캔 목록을 받는다. 취소하면 null. */
  rayOpen(dirHint?: string): Promise<RayOpenResult | null>;
  /** 스캔 하나를 줄여서 푼다. 결과는 src/io/ray.ts의 rayBinToCloud로 좌표로 바꾼다. */
  rayDecode(scanDir: string, sampleStep: number, lineStep: number): Promise<{ meta: RayScanMeta; data: ArrayBuffer }>;
  onRayProgress(cb: ((p: { dir: string; done: number; total: number }) => void) | null): void;
  selfTest: string | null;
  selfTestShot(name: string): Promise<void>;
  selfTestInput(events: Record<string, unknown>[]): Promise<void>;
  selfTestDone(report: unknown): Promise<void>;
}

declare global {
  interface Window {
    depthLidar?: Bridge;
  }
}

export const bridge = typeof window !== 'undefined' ? window.depthLidar ?? null : null;
export const isElectron = !!bridge;

export async function openFiles(filters: { name: string; extensions: string[] }[]): Promise<PickedFile[]> {
  if (bridge) return bridge.openFiles(filters);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',') + ',.mtl,.png,.jpg,.jpeg,.bmp';
    input.onchange = async () => {
      const out: PickedFile[] = [];
      for (const f of Array.from(input.files ?? [])) out.push({ name: f.name, data: await f.arrayBuffer() });
      resolve(out);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** 같은 폴더의 딸린 파일(MTL·텍스처)을 읽는다. 브라우저에서는 함께 선택한 파일에서 찾는다. */
export async function readSibling(file: PickedFile, name: string, pool: PickedFile[]): Promise<ArrayBuffer | null> {
  const base = name.replace(/\\/g, '/').split('/').pop()!;
  const hit = pool.find((p) => p.name.toLowerCase() === base.toLowerCase());
  if (hit) return hit.data;
  if (bridge && file.dir) return bridge.readSibling(file.dir, name);
  return null;
}

/** 여러 파일을 한 묶음으로 저장한다. files[0]이 주 파일이며 나머지는 같은 폴더에 같은 기본 이름으로 저장된다. */
export async function saveFiles(
  defaultBase: string,
  filter: { name: string; extensions: string[] },
  build: (base: string) => OutFile[] | Promise<OutFile[]>,
): Promise<string | null> {
  if (bridge) {
    const target = await bridge.saveDialog(`${defaultBase}.${filter.extensions[0]}`, [filter]);
    if (!target) return null;
    const files = await build(target.base);
    let first = '';
    for (const f of files) {
      const p = await bridge.writeFile(target.dir, f.name, f.data);
      if (!first) first = p;
    }
    return first;
  }
  const files = await build(defaultBase);
  for (const f of files) {
    const blob = new Blob([f.data as BlobPart]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  return files[0]?.name ?? null;
}
