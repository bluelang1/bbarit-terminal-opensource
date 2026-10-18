param(
  [switch]$Quiet,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

function Get-VsSetupPath {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\Installer\setup.exe",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vs_installer.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vs_installer.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }
  throw "Visual Studio setup engine was not found. Install Visual Studio Build Tools 2022 first."
}

function Get-VsInstallPath {
  $vswhereCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
  )
  foreach ($candidate in $vswhereCandidates) {
    if ($candidate -and (Test-Path $candidate)) {
      $path = & $candidate -latest -products * -requires Microsoft.VisualStudio.Workload.VCTools -property installationPath
      if ($path) {
        return $path.Trim()
      }
      $path = & $candidate -latest -products * -property installationPath
      if ($path) {
        return $path.Trim()
      }
    }
  }

  $fallbacks = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Professional",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Enterprise"
  )
  foreach ($fallback in $fallbacks) {
    if ($fallback -and (Test-Path $fallback)) {
      return $fallback
    }
  }
  throw "No Visual Studio 2022 installation path was found."
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "This installer must be run inside Windows."
}

$repoRoot = Get-RepoRoot
Set-Location $repoRoot

$installer = Get-VsSetupPath
$installPath = Get-VsInstallPath
$components = @(
  "Microsoft.VisualStudio.Workload.VCTools",
  "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
  "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
  "Microsoft.VisualStudio.Component.VC.Tools.ARM64EC",
  "Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64",
  "Microsoft.VisualStudio.Component.VC.14.44.17.14.ARM64",
  "Microsoft.VisualStudio.Component.VC.14.44.17.14.ATL.ARM64",
  "Microsoft.VisualStudio.Component.Windows11SDK.26100"
)

$mode = if ($Quiet) { "--quiet" } else { "--passive" }
$installerArgs = @(
  "modify",
  "--installPath", $installPath,
  $mode,
  "--norestart",
  "--includeRecommended"
)

foreach ($component in $components) {
  $installerArgs += "--add"
  $installerArgs += $component
}

Write-Host "Installing Windows ARM64 MSVC prerequisites into: $installPath"
Write-Host "Setup engine: $installer"
Write-Host "Components:"
$components | ForEach-Object { Write-Host "  $_" }

& $installer @installerArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
  throw "Visual Studio setup failed with exit code $code"
}

if (-not $SkipVerify) {
  npm run win:prereq
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    throw "Windows ARM64 prerequisite verification still failed with exit code $code"
  }
}

Write-Host "Windows ARM64 MSVC prerequisites are installed."
