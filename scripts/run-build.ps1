<#
.SYNOPSIS
  Run a build inside the container, with the same limits Fargate will apply.

.EXAMPLE
  .\scripts\run-build.ps1 -Fixture static-ok
  .\scripts\run-build.ps1 -Tarball C:\path\to\my-app.tar.gz -DeploymentId dep_demo
#>
[CmdletBinding()]
param(
  [string]$Fixture = 'static-ok',
  [string]$Tarball,
  [string]$DeploymentId = "dep_$(-join ((48..57) + (97..102) | Get-Random -Count 12 | ForEach-Object { [char]$_ }))",
  [int]$TimeoutSec = 600,
  [string]$Image = 'deploy-builder:dev',
  [switch]$NoNetwork
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Tarball) {
  $Tarball = Join-Path $root "tests\fixtures\tarballs\$Fixture.tar.gz"
}
if (-not (Test-Path $Tarball)) {
  Write-Error "tarball not found: $Tarball`nRun `npm run fixtures` first."
}

$Tarball = (Resolve-Path $Tarball).Path
$inputDir = Split-Path -Parent $Tarball
$inputName = Split-Path -Leaf $Tarball
$outputDir = Join-Path $root '.out'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

# These mirror the Fargate task definition in docs/04-build-contract.md.
# --cap-drop ALL and no-new-privileges are not in that document; they cost
# nothing here and make the local run a closer match to the real sandbox.
$dockerArgs = @(
  'run', '--rm',
  '--memory', '2g',
  '--cpus', '1',
  '--pids-limit', '512',
  '--security-opt', 'no-new-privileges',
  '--cap-drop', 'ALL',
  '-v', "${inputDir}:/in:ro",
  '-v', "${outputDir}:/out",
  '-e', 'BUILDER_MODE=local',
  '-e', "DEPLOYMENT_ID=$DeploymentId",
  '-e', "BUILD_TIMEOUT_SEC=$TimeoutSec",
  '-e', 'CONTAINER_MEMORY_MB=2048'
)

# A build that installs dependencies needs the network. A plain static site
# does not — and proving that is a useful thing to be able to demonstrate.
if ($NoNetwork) { $dockerArgs += @('--network', 'none') }

$dockerArgs += @($Image, 'build', "/in/$inputName")

Write-Host "deployment : $DeploymentId"
Write-Host "source     : $Tarball"
Write-Host "output     : $outputDir\$DeploymentId"
Write-Host ''

& docker @dockerArgs
$code = $LASTEXITCODE

Write-Host ''
switch ($code) {
  0  { Write-Host "DEPLOYED  -> $outputDir\$DeploymentId" -ForegroundColor Green }
  10 { Write-Host 'FAILED (10) source error'          -ForegroundColor Red }
  11 { Write-Host 'FAILED (11) unsupported framework' -ForegroundColor Red }
  12 { Write-Host 'FAILED (12) dependency install'    -ForegroundColor Red }
  13 { Write-Host 'FAILED (13) build command'         -ForegroundColor Red }
  14 { Write-Host 'FAILED (14) no build output'       -ForegroundColor Red }
  15 { Write-Host 'FAILED (15) artifact too large'    -ForegroundColor Red }
  16 { Write-Host 'FAILED (16) publish'               -ForegroundColor Red }
  17 { Write-Host 'FAILED (17) timeout'               -ForegroundColor Red }
  20 { Write-Host 'FAILED (20) configuration'         -ForegroundColor Red }
  137 { Write-Host 'FAILED (137) killed - out of memory' -ForegroundColor Red }
  default { Write-Host "FAILED ($code)" -ForegroundColor Red }
}

exit $code
