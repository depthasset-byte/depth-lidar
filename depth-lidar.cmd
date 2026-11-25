@echo off
rem Depth Lidar command-line tool (keep this file ASCII-only). Usage: depth-lidar help
if not exist "%~dp0release\Depth Lidar-win32-x64\depth-lidar.cmd" (
  echo Depth Lidar is not built yet. Run scripts\build.ps1 first. 1>&2
  exit /b 1
)
call "%~dp0release\Depth Lidar-win32-x64\depth-lidar.cmd" %*
exit /b %errorlevel%
