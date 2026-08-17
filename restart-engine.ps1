# restart-engine.ps1 — kill engine on PORT, START A FRESH ENGINE DIRECTLY (no watchdog
# dependency), wait for readiness, run verify script. Pure ASCII. Run detached.
# Usage: restart-engine.ps1 -Port 3080 -VerifyScript verify-stable.mjs [-Profile web]
param(
  [int]$Port = 3080,
  [string]$VerifyScript = "verify-stable.mjs",
  [string]$Profile = "web"
)
$ErrorActionPreference = "Continue"
$logDir = "C:\Users\35129\Documents\harness\plugin-manager"
Start-Transcript -Path (Join-Path $logDir ".restart-engine.log") -Force | Out-Null
$env:DSH_HOME = "C:\Users\35129\.dsh"
$node = "C:\Program Files\nodejs\node.exe"
$bin = "C:\Users\35129\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
$c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($c) {
  Write-Host "killing engine pid $($c.OwningProcess) on port $Port"
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
Write-Host "starting fresh engine (profile $Profile, port $Port)..."
$outLog = Join-Path $logDir ".engine.out.log"
$errLog = Join-Path $logDir ".engine.err.log"
$p = Start-Process -FilePath $node -ArgumentList "`"$bin`" --profile $Profile --host 127.0.0.1 --port $Port" -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
Write-Host "engine pid $($p.Id)"
$deadline = (Get-Date).AddSeconds(150)
$up = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
if (-not $up) {
  Write-Host "ENGINE DID NOT COME BACK on port $Port"
  Get-Content $errLog -ErrorAction SilentlyContinue | Select-Object -Last 12
  Stop-Transcript | Out-Null
  exit 1
}
Write-Host "port $Port up; waiting for api readiness"
Start-Sleep -Seconds 10
$env:VERIFY_PORT = [string]$Port
& node (Join-Path $logDir $VerifyScript)
$rc = $LASTEXITCODE
Stop-Transcript | Out-Null
exit $rc
