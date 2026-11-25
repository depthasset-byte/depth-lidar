// ray.cjs(주 프로세스와 명령줄 도구가 함께 쓰는 모듈)의 형식 선언.
import type { RayOpenResult, RayScanMeta } from '../src/io/ray';

export function scanRoot(root: string): Promise<RayOpenResult>;
export function decodeScan(
  scanDir: string,
  sampleStep: number,
  lineStep: number,
  onProgress: ((done: number, total: number) => void) | null,
  helperDir?: string,
): Promise<{ meta: RayScanMeta; data: ArrayBuffer }>;
export function readColor(scanDir: string): Promise<{ data: ArrayBuffer; matrix: number[] | null } | null>;
export function readScan(dir: string): Promise<(RayScanMeta & { slices: string[] }) | null>;
