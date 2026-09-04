# restart-main.ps1 - restart the MAIN engine (profile web, port 3080) and smoke-test
# the v0.8 manager over the gateway. Keeps the engine running afterwards.
$ErrorActionPreference = "Continue"
$node = "C:\Program Files\nodejs\node.exe"
$bin = "C:\Users\nonen\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
$dir = "C:\Users\nonen\Documents\harness\plugin-manager"
$port = 3080
$env:DSH_HOME = "C:\Users\nonen\.dsh"

$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($c) {
  Write-Host "killing engine pid $($c.OwningProcess) on port $port"
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}
Write-Host "starting engine profile=web port=$port ..."
$p = Start-Process -FilePath $node -ArgumentList "`"$bin`" --profile web --host 127.0.0.1 --port $port" -WindowStyle Hidden -RedirectStandardOutput "$dir\.main-engine.out.log" -RedirectStandardError "$dir\.main-engine.err.log" -PassThru
Write-Host "engine pid $($p.Id)"
$deadline = (Get-Date).AddSeconds(180)
$up = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
}
if (-not $up) {
  Write-Host "ENGINE DID NOT COME UP on $port"
  Get-Content "$dir\.main-engine.err.log" -ErrorAction SilentlyContinue | Select-Object -Last 25
  exit 1
}
Write-Host "port $port up; running smoke verification"
$env:VERIFY_PORT = [string]$port
& node "$dir\verify-main-smoke.mjs"
exit $LASTEXITCODE
