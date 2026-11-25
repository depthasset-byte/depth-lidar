// 화면(렌더러)에 노출하는 최소한의 창구. 파일 접근은 주 프로세스가 대화상자로 고른 위치에만 허용한다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('depthLidar', {
  openFiles: (filters) => ipcRenderer.invoke('open-files', filters),
  readSibling: (dir, name) => ipcRenderer.invoke('read-sibling', dir, name),
  saveDialog: (defaultName, filters) => ipcRenderer.invoke('save-dialog', defaultName, filters),
  writeFile: (dir, name, data) => ipcRenderer.invoke('write-file', dir, name, data),
  rayOpen: (dirHint) => ipcRenderer.invoke('ray-open', dirHint),
  rayDecode: (scanDir, sampleStep, lineStep) => ipcRenderer.invoke('ray-decode', scanDir, sampleStep, lineStep),
  onRayProgress: (cb) => {
    ipcRenderer.removeAllListeners('ray-progress');
    if (cb) ipcRenderer.on('ray-progress', (_e, p) => cb(p));
  },
  selfTest: process.argv.includes('--scan-selftest=1') ? '1' : null,
  selfTestShot: (name) => ipcRenderer.invoke('selftest-shot', name),
  selfTestInput: (events) => ipcRenderer.invoke('selftest-input', events),
  selfTestDone: (report) => ipcRenderer.invoke('selftest-done', report),
});
