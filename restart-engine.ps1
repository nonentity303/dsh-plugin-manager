# restart-engine.ps1 — kill engine, START A FRESH ENGINE DIRECTLY (no watchdog dependency),
# wait for readiness, run full recovery verification. Pure ASCII. Run detached.
$ErrorActionPreference = "Continue"
$logDir = "C:\Users\35129\Documents\harness\plugin-manager"
Start-Transcript -Path (Join-Path $logDir ".restart-engine.log") -Force | Out-Null
$env:DSH_HOME = "C:\Users\35129\.dsh"
$node = "C:\Program Files\nodejs\node.exe"
$bin = "C:\Users\35129\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if ($c) {
  Write-Host "killing engine pid $($c.OwningProcess)"
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
Write-Host "starting fresh engine..."
$outLog = Join-Path $logDir ".engine.out.log"
$errLog = Join-Path $logDir ".engine.err.log"
$p = Start-Process -FilePath $node -ArgumentList "`"$bin`" --profile web --host 127.0.0.1 --port 3080" -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
Write-Host "engine pid $($p.Id)"
$deadline = (Get-Date).AddSeconds(150)
$up = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
if (-not $up) {
  Write-Host "ENGINE DID NOT COME BACK"
  Get-Content $errLog -ErrorAction SilentlyContinue | Select-Object -Last 10
  Stop-Transcript | Out-Null
  exit 1
}
Write-Host "port 3080 up; waiting for api readiness"
Start-Sleep -Seconds 10
& node (Join-Path $logDir "verify-recovery.mjs")
$rc = $LASTEXITCODE
Stop-Transcript | Out-Null
exit $rc
