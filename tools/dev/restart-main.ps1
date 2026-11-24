# restart-main.ps1 - restart the MAIN engine (default profile web, port 3080) and smoke-test
# the manager over the gateway. Keeps the engine running afterwards.
#
# Dev-only tool (not published). No machine-specific paths: everything is derived
# from the environment (DSH_HOME / USERPROFILE / APPDATA) plus $PSScriptRoot.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\dev\restart-main.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\dev\restart-main.ps1 -Profile web -Port 3080
param(
  [string]$Profile = "web",
  [int]$Port = 3080,
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" })
)
$ErrorActionPreference = "Continue"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "node not found in PATH"; exit 1 }
$dshBin = Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
if (-not (Test-Path $dshBin)) { Write-Host "dsh CLI not found at $dshBin (npm i -g @deepseek-ai/dsh?)"; exit 1 }

$env:DSH_HOME = $DshHome
$logDir = Join-Path $DshHome "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "dev-engine.out.log"
$errLog = Join-Path $logDir "dev-engine.err.log"

$c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($c) {
  Write-Host "killing engine pid $($c.OwningProcess) on port $Port"
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}
Write-Host "starting engine profile=$Profile port=$Port (DSH_HOME=$DshHome) ..."
$p = Start-Process -FilePath $node -ArgumentList "`"$dshBin`" --profile $Profile --host 127.0.0.1 --port $Port" `
  -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
Write-Host "engine pid $($p.Id)"
$deadline = (Get-Date).AddSeconds(180)
$up = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
if (-not $up) {
  Write-Host "ENGINE DID NOT COME UP on $Port"
  Get-Content $errLog -ErrorAction SilentlyContinue | Select-Object -Last 25
  exit 1
}
Write-Host "port $Port up; running smoke verification"
$env:VERIFY_PORT = [string]$Port
& node (Join-Path $PSScriptRoot "verify-main-smoke.mjs")
exit $LASTEXITCODE
