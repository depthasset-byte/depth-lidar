// Artec Ray II(라이카 RTC360 기반) 원본 스캔 프로젝트 읽기.
// 폴더 구조와 목차(XML)를 읽고, 거리·밝기 영상은 Windows 내장 코덱을 쓰는 도우미(raydecode.ps1)로 푼다.
// 형식은 사용자 스캔 파일을 직접 살펴 알아낸 것이며 Artec 프로그램 코드를 참고하지 않았다.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

/** 목차 파일 이름: "TableOfContent"의 base64 */
const TOC_NAME = 'VGFibGVPZkNvbnRlbnQ=';

const unescapeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
};
/** "74.289deg" 같은 각도 문자열을 도 단위 숫자로 바꾼다. */
function angleDeg(v) {
  const s = Array.isArray(v) ? String(v[1]) : String(v ?? '');
  const m = /^\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*([a-z]*)/i.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 'rad': return (n * 180) / Math.PI;
    case 'gon': return n * 0.9;
    case 'arcmin': return n / 60;
    case 'arcsec': return n / 3600;
    default: return n;
  }
}
const tryJson = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};
const exists = (p) => fs.access(p).then(() => true, () => false);

async function readToc(dir) {
  try {
    return await fs.readFile(path.join(dir, TOC_NAME), 'utf8');
  } catch {
    return null;
  }
}

/** 스캔 폴더 하나의 목차를 읽어 변환에 필요한 값만 추린다. */
async function readScan(dir) {
  const xml = await readToc(dir);
  if (!xml || !/<Setup\b/.test(xml)) return null;
  const setup = /<Setup\b[^>]*>/.exec(xml)?.[0] ?? '';
  const params = /<ScanParameters\b[^>]*>/.exec(xml)?.[0] ?? '';
  const clip = tryJson(attr(params, 'ClippingWindow') ?? '');
  const raster = tryJson(attr(params, 'MeasuredRaster') ?? '') ?? tryJson(attr(params, 'RequestedRaster') ?? '');
  const slices = [];
  for (const m of xml.matchAll(/<ScanSlice\b[^>]*>/g)) {
    const name = attr(m[0], 'filename');
    if (name && path.basename(name) === name && (await exists(path.join(dir, name)))) slices.push(name);
  }
  let tilt = null;
  const tiltJson = tryJson(unescapeXml(/<Tilt>([^<]*)<\/Tilt>/.exec(xml)?.[1] ?? ''));
  const lin = tiltJson?.Linear?.[1];
  if (typeof lin === 'string') {
    const nums = (lin.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (nums.length === 9 && nums.every(Number.isFinite)) tilt = nums;
  }
  // 컬러 파노라마(형식 17)와 색 보정 행렬
  let colorFile = null;
  for (const m of xml.matchAll(/<LwpoSlice\b[^>]*>/g)) {
    if (attr(m[0], 'format') === '17') {
      const name = attr(m[0], 'filename');
      if (name && path.basename(name) === name && (await exists(path.join(dir, name)))) colorFile = name;
    }
  }
  let colorMatrix = null;
  const cc = tryJson(attr(setup, 'LwpoColorCorrection') ?? '');
  if (typeof cc?.Linear?.[1] === 'string') {
    const nums = (cc.Linear[1].match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (nums.length === 9 && nums.every(Number.isFinite)) colorMatrix = nums;
  }
  return {
    dir,
    folder: path.basename(dir),
    name: attr(setup, 'Name') ?? path.basename(dir),
    device: attr(setup, 'CreatorDevice') ?? '',
    created: attr(setup, 'Creation') ?? '',
    resolution: attr(params, 'Resolution') ?? '',
    lines: Number(raster?.Horizontal?.[1]) || 0,
    samples: Number(raster?.Vertical?.[1]) || 0,
    azCenterDeg: angleDeg(clip?.Center?.Azimuth),
    elCenterDeg: angleDeg(clip?.Center?.Elevation),
    hSizeDeg: angleDeg(clip?.Size?.Horizontal),
    vSizeDeg: angleDeg(clip?.Size?.Vertical),
    clockwise: attr(params, 'AzRotationIsClockwise') === '1',
    tilt,
    hasColor: !!colorFile,
    colorMatrix,
    colorFile,
    sliceCount: slices.length,
    slices,
  };
}

async function subDirs(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) if (e.isDirectory()) out.push(path.join(dir, e.name));
  return out.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

async function readProjectDir(dir) {
  const xml = await readToc(dir);
  if (!xml || !/<Job\b/.test(xml)) return null;
  const job = /<Job\b[^>]*>/.exec(xml)?.[0] ?? '';
  const scans = [];
  for (const d of await subDirs(dir)) {
    const s = await readScan(d);
    if (s && s.sliceCount > 0) scans.push(s);
  }
  return { name: attr(job, 'Name') ?? path.basename(dir), folder: path.basename(dir), scans };
}

/** project.artec이 있는 폴더(또는 그 안의 프로젝트·스캔 폴더)를 훑어 프로젝트와 스캔 목록을 만든다. */
async function scanRoot(root) {
  const projects = [];
  const self = await readProjectDir(root);
  if (self) projects.push(self);
  else {
    const one = await readScan(root);
    if (one && one.sliceCount > 0) projects.push({ name: path.basename(path.dirname(root)), folder: '', scans: [one] });
    else
      for (const d of await subDirs(root)) {
        const p = await readProjectDir(d);
        if (p && p.scans.length) projects.push(p);
      }
  }
  return { root, projects: projects.map((p) => ({ ...p, scans: p.scans.map(({ slices, colorFile, ...rest }) => rest) })) };
}

let jobSeq = 0;

/** 스캔 하나의 거리·밝기 영상을 줄여서 푼다. 진행 상황은 onProgress(done, total)로 알린다. */
async function decodeScan(scanDir, sampleStep, lineStep, onProgress, helperDir = __dirname) {
  const scan = await readScan(scanDir);
  if (!scan || !scan.sliceCount) throw new Error('스캔 조각(.scan)을 찾지 못했습니다.');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `depthlidar-ray-${process.pid}-${++jobSeq}-`));
  try {
    // 도우미 파일은 앱 묶음(asar) 안에 있을 수 있어 임시 폴더에 풀어 쓴다.
    const ps1 = path.join(tmp, 'raydecode.ps1');
    const cs = path.join(tmp, 'raydecode.cs');
    const list = path.join(tmp, 'slices.txt');
    const out = path.join(tmp, 'out.bin');
    await fs.writeFile(ps1, await fs.readFile(path.join(helperDir, "raydecode.ps1")));
    await fs.writeFile(cs, await fs.readFile(path.join(helperDir, "raydecode.cs")));
    await fs.writeFile(list, scan.slices.map((n) => path.join(scanDir, n)).join('\r\n') + '\r\n', 'utf8');
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Source', cs, '-List', list, '-Out', out, '-SampleStep', String(sampleStep), '-LineStep', String(lineStep)];
    await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      let pending = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const m = /^P (\d+) (\d+)/.exec(line);
          if (m && onProgress) onProgress(Number(m[1]), Number(m[2]));
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error((err.trim().split(/\r?\n/).slice(0, 3).join(' ') || `도우미 종료 코드 ${code}`).slice(0, 400)))));
    });
    const buf = await fs.readFile(out);
    const { slices, colorFile, ...meta } = scan;
    return { meta, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** 스캔의 컬러 파노라마 파일을 통째로 읽는다. 없으면 null. */
async function readColor(scanDir) {
  const scan = await readScan(scanDir);
  if (!scan || !scan.colorFile) return null;
  const buf = await fs.readFile(path.join(scanDir, scan.colorFile));
  return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), matrix: scan.colorMatrix };
}

module.exports = { scanRoot, decodeScan, readScan, readColor };
