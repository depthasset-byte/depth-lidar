// Depth Lidar 창 앱(Electron) 주 프로세스.
const { app, BrowserWindow, dialog, ipcMain, protocol, net, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const ray = require('./ray.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const devUrl = process.env.DEPTH_LIDAR_DEV_URL || null;
const stIdx = process.argv.indexOf('--selftest');
const selfTestDir = stIdx >= 0 ? path.resolve(process.argv[stIdx + 1] || 'selftest-out') : null;

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob: data:";

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** 사용자가 대화상자로 직접 고른 폴더만 읽기·쓰기를 허용한다. */
const readDirs = new Set();
const writeDirs = new Set();
/** 대화상자로 고른 Artec Ray II 프로젝트 폴더. 이 안의 스캔만 변환한다. */
const rayRoots = new Set();
/** 자동 검증 때만: 환경 변수로 받은 Ray II 프로젝트 경로(project.artec 또는 폴더) */
const rayTestPath = process.env.DEPTH_LIDAR_RAY_TEST || null;
let win = null;

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#1b1f25',
    title: 'Depth Lidar',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: selfTestDir ? ['--scan-selftest=1'] : [],
    },
  });
  win.once('ready-to-show', () => win.show());
  if (selfTestDir) {
    // 자동 검증 중에는 화면 쪽 콘솔을 표준 출력으로 넘기고, 끝나지 않으면 스스로 종료한다.
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
    win.webContents.on('render-process-gone', (_e, d) => console.log(`[renderer-gone] ${d.reason}`));
    setTimeout(() => {
      console.log('[selftest] 시간 초과');
      app.exit(2);
    }, rayTestPath ? 600000 : 240000);
  }
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  // 외부 페이지로 이동하거나 새 창을 여는 것을 막는다.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !(devUrl && url.startsWith(devUrl))) e.preventDefault();
  });
  win.loadURL(devUrl || 'app://depth-lidar/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      const res = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  ipcMain.handle('open-files', async (_e, filters) => {
    if (selfTestDir) {
      // 자동 검증: 대화상자 대신 검증 폴더의 export 하위 폴더에 있는 파일을 연다.
      const dir = path.join(selfTestDir, 'export');
      const exts = new Set(filters.flatMap((f) => f.extensions.map((x) => '.' + x.toLowerCase())));
      readDirs.add(dir);
      const list = [];
      for (const name of await fs.readdir(dir)) if (exts.has(path.extname(name).toLowerCase())) list.push({ name, dir, data: toArrayBuffer(await fs.readFile(path.join(dir, name))) });
      return list;
    }
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [...filters, { name: '모든 파일', extensions: ['*'] }] });
    if (r.canceled) return [];
    const out = [];
    for (const p of r.filePaths) {
      const dir = path.dirname(p);
      readDirs.add(dir);
      out.push({ name: path.basename(p), dir, data: toArrayBuffer(await fs.readFile(p)) });
    }
    return out;
  });

  ipcMain.handle('read-sibling', async (_e, dir, name) => {
    if (typeof dir !== 'string' || typeof name !== 'string' || !readDirs.has(dir)) return null;
    const target = path.resolve(dir, name);
    if (!target.startsWith(dir + path.sep)) return null;
    try {
      return toArrayBuffer(await fs.readFile(target));
    } catch {
      return null;
    }
  });

  ipcMain.handle('save-dialog', async (_e, defaultName, filters) => {
    if (selfTestDir) {
      const dir = path.join(selfTestDir, 'export');
      await fs.mkdir(dir, { recursive: true });
      writeDirs.add(dir);
      const ext = path.extname(defaultName);
      return { dir, base: path.basename(defaultName, ext), ext: ext.slice(1) };
    }
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
    if (r.canceled || !r.filePath) return null;
    const dir = path.dirname(r.filePath);
    writeDirs.add(dir);
    const ext = path.extname(r.filePath);
    return { dir, base: path.basename(r.filePath, ext), ext: ext.slice(1) };
  });

  ipcMain.handle('write-file', async (_e, dir, name, data) => {
    if (typeof dir !== 'string' || typeof name !== 'string' || !writeDirs.has(dir)) throw new Error('저장 위치가 허용되지 않았습니다.');
    if (path.basename(name) !== name) throw new Error('잘못된 파일 이름입니다.');
    const target = path.join(dir, name);
    await fs.writeFile(target, typeof data === 'string' ? data : Buffer.from(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset || 0, data.byteLength));
    return target;
  });

  // Artec Ray II 원본 프로젝트: project.artec을 고르면 그 폴더의 프로젝트·스캔 목록을 돌려준다.
  ipcMain.handle('ray-open', async (_e, dirHint) => {
    let picked = null;
    if (selfTestDir) picked = rayTestPath;
    else if (typeof dirHint === 'string' && readDirs.has(dirHint)) picked = dirHint;
    else {
      const r = await dialog.showOpenDialog(win, {
        title: 'Artec Ray II 프로젝트 열기 (project.artec)',
        properties: ['openFile'],
        filters: [{ name: 'Artec Ray II 프로젝트 (project.artec)', extensions: ['artec'] }, { name: '모든 파일', extensions: ['*'] }],
      });
      if (!r.canceled && r.filePaths.length) picked = r.filePaths[0];
    }
    if (!picked) return null;
    const st = await fs.stat(picked);
    const root = st.isDirectory() ? picked : path.dirname(picked);
    const result = await ray.scanRoot(root);
    rayRoots.add(root);
    return result;
  });

  ipcMain.handle('ray-decode', async (e, scanDir, sampleStep, lineStep) => {
    if (typeof scanDir !== 'string') throw new Error('잘못된 스캔 경로입니다.');
    const dir = path.resolve(scanDir);
    if (![...rayRoots].some((root) => dir === root || dir.startsWith(root + path.sep))) throw new Error('열어 둔 프로젝트 밖의 스캔입니다.');
    const s = Math.max(1, Math.min(64, Math.round(Number(sampleStep) || 8)));
    const l = Math.max(1, Math.min(64, Math.round(Number(lineStep) || 8)));
    return ray.decodeScan(dir, s, l, (done, total) => {
      if (!e.sender.isDestroyed()) e.sender.send('ray-progress', { dir, done, total });
    });
  });

  ipcMain.handle('selftest-shot', async (_e, name) => {
    if (!selfTestDir) return;
    await fs.mkdir(selfTestDir, { recursive: true });
    const img = await win.webContents.capturePage();
    await fs.writeFile(path.join(selfTestDir, `${String(name).replace(/[\\/:*?"<>|]/g, '_')}.png`), img.toPNG());
  });

  // 자동 검증용: 실제 마우스 입력을 창에 주입한다.
  ipcMain.handle('selftest-input', async (_e, events) => {
    if (!selfTestDir) return;
    for (const ev of events) {
      win.webContents.sendInputEvent(ev);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 150));
  });

  ipcMain.handle('selftest-done', async (_e, report) => {
    if (!selfTestDir) return;
    await fs.mkdir(selfTestDir, { recursive: true });
    await fs.writeFile(path.join(selfTestDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    setTimeout(() => app.quit(), 200);
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
