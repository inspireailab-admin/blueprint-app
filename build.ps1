#requires -Version 5.1
<#
.SYNOPSIS
  Builds Blueprint: the desktop app (Wails) + the Windows service binary
  + the Linux service binary (cross-compiled).

.DESCRIPTION
  Three artifacts end up in build\bin\:

    blueprint.exe          ← Wails desktop app (Windows)
    blueprint-svc.exe      ← Windows Service binary
    blueprint-svc-linux    ← Linux service binary (systemd)

  The Linux build is cross-compiled from this Windows host. Pure-Go +
  std-lib only, no CGO required for the service path.

.PARAMETER SvcOnly
  Skip the Wails desktop app build; produce only the service binaries.

.PARAMETER NoLinux
  Skip the Linux cross-compile.

.NOTES
  Run from the repo root: .\build.ps1
  Requires Go on PATH (or installed at "C:\Program Files\Go").
  Requires wails CLI installed at $HOME\go\bin\wails.exe (unless -SvcOnly).
#>

[CmdletBinding()]
param(
    [switch] $SvcOnly,
    [switch] $NoLinux
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    $env:PATH = "C:\Program Files\Go\bin;$env:USERPROFILE\go\bin;$env:PATH"
}
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw "go executable not on PATH"
}

$root = $PSScriptRoot
$outDir = Join-Path $root 'build\bin'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 1. blueprint-svc.exe (Windows service).
Write-Host "Building blueprint-svc.exe…" -ForegroundColor Cyan
$svcWinOut = Join-Path $outDir 'blueprint-svc.exe'
Push-Location $root
try {
    & go build -o $svcWinOut ./cmd/blueprint-svc
    if ($LASTEXITCODE -ne 0) { throw "go build (windows svc) failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-Host "  → $svcWinOut" -ForegroundColor Green

# 2. blueprint-svc-linux (Linux service, cross-compiled).
if (-not $NoLinux) {
    Write-Host "Cross-compiling blueprint-svc-linux…" -ForegroundColor Cyan
    $svcLinuxOut = Join-Path $outDir 'blueprint-svc-linux'
    Push-Location $root
    try {
        $env:GOOS = 'linux'
        $env:GOARCH = 'amd64'
        try {
            & go build -o $svcLinuxOut ./cmd/blueprint-svc
            if ($LASTEXITCODE -ne 0) { throw "go build (linux svc) failed (exit $LASTEXITCODE)" }
        } finally {
            Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
        }
    } finally {
        Pop-Location
    }
    Write-Host "  → $svcLinuxOut" -ForegroundColor Green
}

if ($SvcOnly) {
    Write-Host "Done (svc only)." -ForegroundColor Green
    return
}

# 3. blueprint.exe (Wails desktop app).
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
Write-Host "Artifacts in $outDir" -ForegroundColor Green
Write-Host "Install on this machine (Windows):" -ForegroundColor Gray
Write-Host "  .\installer\install-windows.ps1" -ForegroundColor Gray
Write-Host "Install on a Linux host:" -ForegroundColor Gray
Write-Host "  scp $outDir\blueprint-svc-linux user@host:/tmp/" -ForegroundColor Gray
Write-Host "  ssh user@host 'sudo /tmp/blueprint-svc-linux install'" -ForegroundColor Gray
