#requires -Version 5.1
<#
.SYNOPSIS
  Builds Blueprint: the desktop app (Wails) + the Windows service binary.

.DESCRIPTION
  Wails handles blueprint.exe (frontend bundle + Go backend). The service
  binary (cmd/blueprint-svc/blueprint-svc.exe) is a separate Go program
  that runs under the SCM. Both end up in build/bin/ so the desktop app
  can find blueprint-svc.exe next to itself when installing the service.

.NOTES
  Run from the repo root: .\build.ps1
  Requires Go on PATH (or installed at "C:\Program Files\Go").
  Requires wails CLI installed at $HOME\go\bin\wails.exe.
#>

[CmdletBinding()]
param(
    [switch] $SvcOnly
)

$ErrorActionPreference = 'Stop'

# Put Go + Wails on PATH for this session.
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    $env:PATH = "C:\Program Files\Go\bin;$env:USERPROFILE\go\bin;$env:PATH"
}
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw "go executable not on PATH"
}

$root = $PSScriptRoot
$outDir = Join-Path $root 'build\bin'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 1. Build blueprint-svc.exe (Windows service binary).
Write-Host "Building blueprint-svc.exe…" -ForegroundColor Cyan
$svcOut = Join-Path $outDir 'blueprint-svc.exe'
Push-Location $root
try {
    & go build -o $svcOut ./cmd/blueprint-svc
    if ($LASTEXITCODE -ne 0) { throw "go build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-Host "  → $svcOut" -ForegroundColor Green

if ($SvcOnly) {
    Write-Host "Done (svc only)."
    return
}

# 2. Build blueprint.exe (Wails desktop app).
Write-Host "Building blueprint.exe…" -ForegroundColor Cyan
Push-Location $root
try {
    & wails build
    if ($LASTEXITCODE -ne 0) { throw "wails build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-Host "  → $(Join-Path $outDir 'blueprint.exe')" -ForegroundColor Green

Write-Host ""
Write-Host "Built both binaries in $outDir" -ForegroundColor Green
Write-Host "Install the service from inside the app, or run:" -ForegroundColor Gray
Write-Host "  Start-Process -Verb RunAs `"$svcOut`" -ArgumentList install" -ForegroundColor Gray
