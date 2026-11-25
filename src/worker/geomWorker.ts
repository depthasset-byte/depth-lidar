/// <reference lib="webworker" />
import { collectBuffers } from '../geometry/mesh';
import { ops } from '../geometry/ops';

self.onmessage = async (e: MessageEvent<{ id: number; op: string; args: unknown }>) => {
  const { id, op, args } = e.data;
  try {
    const fn = (ops as unknown as Record<string, (a: unknown) => unknown>)[op];
    if (!fn) throw new Error(`알 수 없는 연산: ${op}`);
    const result = await fn(args);
    const transfer = [...collectBuffers(result)].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
    (self as unknown as Worker).postMessage({ id, result }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
