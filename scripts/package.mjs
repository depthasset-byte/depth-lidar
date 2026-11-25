// 실행 파일 패키징: dist(빌드 결과)와 electron 폴더만 담아 release/Depth Lidar-win32-x64 를 만든다.
import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = new Set(['dist', 'electron', 'package.json']);

const out = await packager({
  dir: root,
  name: 'Depth Lidar',
  platform: 'win32',
  arch: 'x64',
  // 실행 중인 앱 때문에 release 폴더를 못 바꿀 때는 DEPTH_LIDAR_RELEASE_DIR로 다른 폴더에 만든다.
  out: process.env.DEPTH_LIDAR_RELEASE_DIR ? path.resolve(root, process.env.DEPTH_LIDAR_RELEASE_DIR) : path.join(root, 'release'),
  overwrite: true,
  asar: true,
  prune: false,
  // 실행에 필요한 것(dist, electron, package.json)만 남긴다. 화면 코드는 dist에 모두 묶여 있다.
  ignore: (p) => {
    if (!p) return false;
    const top = p.split('/').filter(Boolean)[0];
    return !keep.has(top);
  },
  appCopyright: 'Depth Lidar',
  win32metadata: { ProductName: 'Depth Lidar', FileDescription: 'Depth Lidar' },
  // 명령줄 도구 묶음(dist-cli)은 asar 밖 resources\dist-cli 에 둔다. PowerShell 도우미가 파일로 읽어야 하기 때문이다.
  extraResource: [path.join(root, 'dist-cli')],
});
// 명령줄 진입점: 같은 실행 파일을 Node 모드(ELECTRON_RUN_AS_NODE)로 돌려 창 없이 실행한다. ASCII만 쓴다.
const launcher = ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', '"%~dp0Depth Lidar.exe" "%~dp0resources\\dist-cli\\depth-lidar.cjs" %*', 'exit /b %errorlevel%', ''].join('\r\n');
for (const dir of out) await fs.writeFile(path.join(dir, 'depth-lidar.cmd'), launcher, 'ascii');
console.log('packaged:', out.join(', '));
