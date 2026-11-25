// src/vendor/EXRLoader.js (three.js 사본)의 최소 형식 선언.
export class EXRLoader {
  setDataType(type: number): this;
  parse(buffer: ArrayBuffer): { width: number; height: number; data: Float32Array | Uint16Array; format: number; type: number };
}
