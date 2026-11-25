# Depth Lidar build: type-check, unit tests, bundle, package the exe.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build.ps1
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:Path = (Join-Path $root '.tools\node') + ';' + $env:Path
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

& node (Join-Path $root 'node_modules\typescript\bin\tsc') --noEmit
if ($LASTEXITCODE -ne 0) { throw 'type check failed' }
& node (Join-Path $root 'node_modules\vitest\vitest.mjs') run
if ($LASTEXITCODE -ne 0) { throw 'unit tests failed' }
& node (Join-Path $root 'node_modules\vite\bin\vite.js') build
if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }
# Command-line tool bundle (dist-cli\depth-lidar.cjs) plus the PowerShell helper it needs as real files.
& node (Join-Path $root 'node_modules\vite\bin\vite.js') build --config vite.cli.config.ts
if ($LASTEXITCODE -ne 0) { throw 'cli build failed' }
Copy-Item -LiteralPath (Join-Path $root 'electron\raydecode.ps1'), (Join-Path $root 'electron\raydecode.cs') -Destination (Join-Path $root 'dist-cli') -Force
& node (Join-Path $root 'scripts\package.mjs')
if ($LASTEXITCODE -ne 0) { throw 'packaging failed' }
'build OK: release\Depth Lidar-win32-x64\Depth Lidar.exe'
