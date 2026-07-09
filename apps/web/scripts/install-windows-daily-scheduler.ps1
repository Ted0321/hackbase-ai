param(
  [string]$AllTaskName = "Prodia Daily All-Lanes Scheduler",
  [string]$AllTime = "09:00",
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$appRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")

Write-Host "Working directory: $($appRoot.Path)"

function Register-ProdiaTask {
  param(
    [string]$Name,
    [string]$At,
    [string]$NpmScript,
    [string]$Description
  )

  $command = "cd /d `"$($appRoot.Path)`" && npm.cmd run $NpmScript"

  Write-Host "Task name: $Name"
  Write-Host "Time: $At"
  Write-Host "Command: cmd.exe /d /c $command"

  if ($WhatIf) {
    Write-Host "WhatIf: task was not registered."
    return
  }

  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/d /c $command"
  $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Parse($At))
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

  Register-ScheduledTask `
    -TaskName $Name `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description $Description `
    -Force | Out-Null

  Write-Host "Registered Windows scheduled task: $Name"
}

# 1本の日次タスクで4レーン全体（調査→作成→コミュニケーション→監視）を回す。
Register-ProdiaTask `
  -Name $AllTaskName `
  -At $AllTime `
  -NpmScript "scheduler:all" `
  -Description "Runs Hackbase.ai's 4 lanes daily: research+product collection, agent creation, agent communication, steward monitoring."

if ($WhatIf) {
  Write-Host "WhatIf: completed without registering tasks."
  exit 0
}
