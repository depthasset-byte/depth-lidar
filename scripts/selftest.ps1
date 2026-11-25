# Depth Lidar self-test: build, run the Electron app with --selftest, print a summary.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\selftest.ps1 [-Packaged] [-NoBuild]
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([switch]$Packaged, [switch]$NoBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:Path = (Join-Path $root '.tools\node') + ';' + $env:Path
# Electron must not inherit this variable, otherwise it starts in Node mode instead of GUI mode.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

if (-not $NoBuild) {
  & node (Join-Path $root 'node_modules\vite\bin\vite.js') build | Select-Object -Last 2
  if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }
}
$out = Join-Path $root 'selftest-out'
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force -Confirm:$false }
if ($Packaged) {
  $exe = Join-Path $root 'release\Depth Lidar-win32-x64\Depth Lidar.exe'
  $argList = @('--selftest', "`"$out`"")
} else {
  $exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
  $argList = @('.', '--selftest', "`"$out`"")
}
$stdout = Join-Path $root 'selftest-stdout.log'
$p = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $root -RedirectStandardOutput $stdout -RedirectStandardError (Join-Path $root 'selftest-stderr.log') -PassThru -Wait
"exit=$($p.ExitCode)"
$report = Join-Path $out 'report.json'
if (-not (Test-Path -LiteralPath $report)) {
  Get-Content -LiteralPath $stdout -Encoding UTF8 -Tail 30
  throw 'report.json was not produced'
}
& node (Join-Path $PSScriptRoot 'print-report.cjs') $report
Get-Content -LiteralPath $stdout -Encoding UTF8 | Select-String -Pattern 'renderer:3|renderer-gone|selftest\]' | Select-Object -First 12 | ForEach-Object { $_.Line }
