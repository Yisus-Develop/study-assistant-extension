# install-bridge.ps1
# Registers a Scheduled Task that starts the opencode bridge at logon.
# Run once as the current user:
#   powershell -ExecutionPolicy Bypass -File tools\install-bridge.ps1

$ErrorActionPreference = 'Stop'
$ToolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartScript = Join-Path $ToolsDir 'start-bridge.ps1'
$TaskName = 'StudyAssistant-OpencodeBridge'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0 -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the local opencode key bridge used by the Study Assistant browser extension.' -Force | Out-Null
Write-Output "Scheduled task '$TaskName' registered."