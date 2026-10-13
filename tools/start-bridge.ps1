# start-bridge.ps1
# Starts the opencode-bridge node server hidden (no console window).
# Skips if the bridge is already listening on port 47821.

$ErrorActionPreference = 'SilentlyContinue'
$BridgePort = 47821
$ToolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeScript = Join-Path $ToolsDir 'opencode-bridge.js'
$LogFile = Join-Path $ToolsDir 'bridge.log'

# Already running?
$existing = Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Output 'Bridge already running.'
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Output 'node not found.'
  exit 1
}

Start-Process -FilePath $node -ArgumentList "`"$BridgeScript`"" -WorkingDirectory $ToolsDir -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err"
Write-Output 'Bridge started.'