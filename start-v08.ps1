# start-v08.ps1 — start the v0.8 E2E engine on port 3082 ONLY (isolated profile web-v08).
# run: powershell -File start-v08.ps1 (starts detached, waits for port, runs verify-v08.mjs, then kills it)
$ErrorActionPreference = "Continue"
$node = "C:\Program Files\nodejs\node.exe"
$bin = "C:\Users\nonen\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
$dir = "C:\Users\nonen\Documents\harness\plugin-manager"
$port = 3082
$env:DSH_HOME = "C:\Users\nonen\.dsh"

$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }

Write-Host "starting engine profile=web-v08 port=$port ..."
$p = Start-Process -FilePath $node -ArgumentList "`"$bin`" --profile web-v08 --host 127.0.0.1 --port $port" -WindowStyle Hidden -RedirectStandardOutput "$dir\.v08-engine.out.log" -RedirectStandardError "$dir\.v08-engine.err.log" -PassThru
Write-Host "engine pid $($p.Id)"

$deadline = (Get-Date).AddSeconds(180)
$up = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
if (-not $up) {
  Write-Host "ENGINE DID NOT COME UP on $port"
  Get-Content "$dir\.v08-engine.err.log" -ErrorAction SilentlyContinue | Select-Object -Last 20
  exit 1
}
Write-Host "port $port up; running verify-v08.mjs"
$env:VERIFY_PORT = [string]$port
& node "$dir\verify-v08.mjs"
$rc = $LASTEXITCODE
Write-Host "verify rc=$rc; stopping engine on $port"
$c2 = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($c2) { Stop-Process -Id $c2.OwningProcess -Force -ErrorAction SilentlyContinue }
exit $rc
