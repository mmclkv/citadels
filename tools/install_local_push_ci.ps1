param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$stateDir = [System.IO.Path]::GetFullPath($cfg.state)
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$runner = Join-Path $stateDir 'local_push_ci.py'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local_push_ci.py') -Destination $runner -Force
$pythonWindowless = Join-Path (Split-Path $cfg.python) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonWindowless)) { throw 'pythonw.exe is required' }
$arguments = '"{0}" --config "{1}"' -f $runner, ([System.IO.Path]::GetFullPath($Config))
$action = New-ScheduledTaskAction -Execute $pythonWindowless -Argument $arguments -WorkingDirectory $stateDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(1) -RepetitionInterval (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Hourly: push existing local citadels main commits to GitHub without force or automatic commits. Logs and last-run.json in state directory.'
Register-ScheduledTask -TaskName 'Citadels-GitHubPushCI' -InputObject $task -Force | Select-Object TaskName,State | Format-List
Get-ScheduledTaskInfo -TaskName 'Citadels-GitHubPushCI' | Select-Object NextRunTime,LastTaskResult | Format-List
