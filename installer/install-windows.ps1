#requires -Version 5.1
#requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs Blueprint on this Windows machine.

.DESCRIPTION
  This is the install path the website download wraps. Copies both
  binaries into Program Files, then registers blueprint-svc.exe with
  the Service Control Manager so llama-server has a 24/7 supervisor.

  After this, the user just runs blueprint.exe (a Start Menu shortcut
  is created) and the Dashboard finds the service already installed.

.PARAMETER From
  Directory containing blueprint.exe + blueprint-svc.exe. Defaults to
  the directory this script lives in (the .\installer folder), which is
  also where the production installer ships them.

.NOTES
  Must be run as Administrator. Right-click the .ps1 or invoke from an
  elevated PowerShell.
#>

[CmdletBinding()]
param(
    [string] $From,
    [string] $InstallDir = "$env:ProgramFiles\Blueprint"
)

$ErrorActionPreference = 'Stop'

if (-not $From) {
    # Default: assume the script lives next to the binaries (the case
    # both for build\bin\ during development and for the production
    # installer's payload directory).
    $From = $PSScriptRoot
    if (-not (Test-Path (Join-Path $From 'blueprint.exe'))) {
        # Fallback for developer flow: build\bin\ alongside this script.
        $candidate = Join-Path (Split-Path -Parent $PSScriptRoot) 'build\bin'
        if (Test-Path (Join-Path $candidate 'blueprint.exe')) { $From = $candidate }
    }
}

$blueprintExe = Join-Path $From 'blueprint.exe'
$svcExe = Join-Path $From 'blueprint-svc.exe'

if (-not (Test-Path $blueprintExe)) {
    throw "blueprint.exe not found at $blueprintExe"
}
if (-not (Test-Path $svcExe)) {
    throw "blueprint-svc.exe not found at $svcExe"
}

Write-Host "Installing Blueprint to $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# 1. Copy binaries.
Write-Host "  copying blueprint.exe…"
Copy-Item -Force $blueprintExe $InstallDir
Write-Host "  copying blueprint-svc.exe…"
Copy-Item -Force $svcExe $InstallDir

# 2. Register the service (idempotent — uninstall first if present).
$installedSvc = Join-Path $InstallDir 'blueprint-svc.exe'
Write-Host "  registering Blueprint LLM Service…" -ForegroundColor Cyan

$svcStatus = (& sc.exe query BlueprintLLM 2>&1 | Out-String)
if ($svcStatus -notmatch 'The specified service does not exist') {
    Write-Host "  stopping + removing existing service…"
    & $installedSvc uninstall 2>&1 | Out-Null
    Start-Sleep -Seconds 1
}

& $installedSvc install
if ($LASTEXITCODE -ne 0) {
    throw "service install failed (exit $LASTEXITCODE)"
}

# 3. Create Start Menu shortcut.
$startMenu = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
$shortcut = Join-Path $startMenu 'Blueprint.lnk'
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($shortcut)
$lnk.TargetPath = Join-Path $InstallDir 'blueprint.exe'
$lnk.WorkingDirectory = $InstallDir
$lnk.Description = 'Run open LLMs on your own hardware'
$lnk.Save()

Write-Host ""
Write-Host "Installed." -ForegroundColor Green
Write-Host "  App:     $(Join-Path $InstallDir 'blueprint.exe')"
Write-Host "  Service: BlueprintLLM (auto-start, supervised)"
Write-Host "  Launch:  Start menu → Blueprint, or run $(Join-Path $InstallDir 'blueprint.exe')"
