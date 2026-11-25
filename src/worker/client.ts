// 지오메트리 워커 호출 창구. 워커를 만들 수 없는 환경에서는 같은 스레드에서 실행한다.
import { OpArgs, OpName, OpResult, ops } from '../geometry/ops';

let worker: Worker | null = null;
let failed = false;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (failed || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./geomWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error !== undefined) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    worker.onerror = (e) => {
      failed = true;
      worker = null;
      for (const p of pending.values()) p.reject(new Error(e.message || '워커 오류'));
      pending.clear();
    };
    return worker;
  } catch {
    failed = true;
    return null;
  }
}

export function runOp<K extends OpName>(op: K, args: OpArgs<K>): Promise<OpResult<K>> {
  const w = getWorker();
  if (!w) {
    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          resolve((await (ops[op] as (a: unknown) => unknown)(args)) as OpResult<K>);
        } catch (e) {
          reject(e as Error);
        }
      }, 0);
    });
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, op, args });
  });
}
