# Depth Lidar helper launcher. Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
# Scan slices: powershell -NoProfile -ExecutionPolicy Bypass -File raydecode.ps1 -Source raydecode.cs -List slices.txt -Out out.bin -SampleStep 8 -LineStep 8
# Cubemap:     powershell -NoProfile -ExecutionPolicy Bypass -File raydecode.ps1 -Source raydecode.cs -Cube file.cubemap -Out out.bin -SampleStep 1
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$List = '',
  [string]$Cube = '',
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$SampleStep = 8,
  [int]$LineStep = 8
)
$ErrorActionPreference = 'Stop'
try {
  $code = [IO.File]::ReadAllText($Source)
  Add-Type -TypeDefinition $code -ReferencedAssemblies PresentationCore, WindowsBase, System.Xaml
  if ($Cube -ne '') { [RayDecode]::Cube($Cube, $Out, $SampleStep) }
  elseif ($List -ne '') { [RayDecode]::Run($List, $Out, $SampleStep, $LineStep) }
  else { throw 'either -List or -Cube is required' }
  exit 0
} catch {
  [Console]::Error.WriteLine('ERROR ' + $_.Exception.Message)
  if ($_.Exception.InnerException) { [Console]::Error.WriteLine('ERROR ' + $_.Exception.InnerException.Message) }
  exit 1
}
