@echo off
rem Depth Lidar launcher (keep this file ASCII-only)
set ELECTRON_RUN_AS_NODE=
if not exist "%~dp0release\Depth Lidar-win32-x64\Depth Lidar.exe" (
  echo Depth Lidar.exe not found. Run scripts\build.ps1 first.
  pause
  exit /b 1
)
start "" "%~dp0release\Depth Lidar-win32-x64\Depth Lidar.exe"
