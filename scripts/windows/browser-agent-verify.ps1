param(
  [switch]$SkipBuild,
  [int]$StartupTimeoutSeconds = 120,
  [string]$ReportPath = ".octo-tmp\win-browser-agent-verify.json"
)

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

$repoRoot = Get-RepoRoot
Set-Location $repoRoot

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "This verifier must be run on Windows because it validates the WebView2 runtime path."
}

$nodeArgs = @(
  "scripts/browser-agent-verify.mjs",
  "--require-platform", "win32",
  "--report", $ReportPath,
  "--startup-timeout-seconds", "$StartupTimeoutSeconds"
)

if ($SkipBuild) {
  $nodeArgs += "--skip-build"
}

& node @nodeArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
  throw "Windows browser + BBARIT agent verification failed with exit code $code"
}

Write-Host "Windows browser + BBARIT agent verification passed."
