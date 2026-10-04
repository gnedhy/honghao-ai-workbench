param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$appRoot = 'C:/ProgramData/HonghaoAI/application'
$monitorRoot = 'C:/ProgramData/HonghaoAI/operations-monitor'
$description = 'Maintained by HonghaoAI operations monitor v1'
$config = Get-Content -LiteralPath "$appRoot/active.json" -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.database_profile -ne 'production' -or $config.host -ne '127.0.0.1') { throw 'Unexpected production identity' }
$python = Join-Path $config.release_dir '.venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $python)) { throw 'Production Python is unavailable' }
$uv = (Get-Command uv -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$files = @('operations-monitor.py','operations-policy.json','monitor-process.ps1','check-dependencies.py')
$fingerprints = [ordered]@{}
foreach ($file in $files) { $fingerprints[$file] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot $file)).Hash }
$payload = [Text.Encoding]::UTF8.GetBytes(($fingerprints | ConvertTo-Json -Compress))
$digest = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($payload))).Replace('-','').ToLower()
$versionRoot = Join-Path $monitorRoot "versions/$digest"
$reportRoot = Join-Path $monitorRoot 'reports'
$taskNames = @('HonghaoAI-ProductionMonitor','HonghaoAI-DependencyAudit')
foreach ($name in $taskNames) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing -and $existing.Description -ne $description) { throw "Task name belongs to another owner: $name" }
}
$plan = [ordered]@{ version = $digest; principal = $user; logon = 'S4U'; intervalSeconds = 300; reportRoot = $reportRoot; files = $fingerprints; tasks = $taskNames }
if (!$Apply) { $plan | ConvertTo-Json -Depth 5; exit 0 }
function Protect-MonitorTree {
    $rootPath = [IO.Path]::GetFullPath($monitorRoot).TrimEnd('\')
    $items = New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
    $pending = New-Object 'System.Collections.Generic.Queue[System.IO.DirectoryInfo]'
    $rootItem = Get-Item -LiteralPath $rootPath
    $pending.Enqueue($rootItem)
    # Inspect each directory before traversing it; never follow a junction or symlink.
    while ($pending.Count) {
        $directory = $pending.Dequeue()
        if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in monitor package' }
        $items.Add($directory)
        foreach ($item in Get-ChildItem -LiteralPath $directory.FullName -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in monitor package' }
            if (![IO.Path]::GetFullPath($item.FullName).StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Monitor path escaped private root' }
            if ($item.PSIsContainer) { $pending.Enqueue($item) } else { $items.Add($item) }
        }
    }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $identities = @($owner.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
    foreach ($item in $items) {
        if ($item.PSIsContainer) { $acl = New-Object Security.AccessControl.DirectorySecurity } else { $acl = New-Object Security.AccessControl.FileSecurity }
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($owner)
        foreach ($sid in $identities) {
            $identity = New-Object Security.Principal.SecurityIdentifier($sid)
            if ($item.PSIsContainer) {
                $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            } else { $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow') }
            $acl.AddAccessRule($rule)
        }
        # Persist only the constructed access/owner sections; Set-Acl also attempts SACL writes.
        $item.SetAccessControl($acl)
        $verified = Get-Acl -LiteralPath $item.FullName
        $rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if (!$verified.AreAccessRulesProtected -or $rules.Count -ne $identities.Count) { throw 'Incomplete private DACL' }
        foreach ($rule in $rules) {
            if ($rule.IsInherited -or $rule.IdentityReference.Value -notin $identities -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unexpected monitor access rule' }
        }
    }
}
$ancestor = [IO.DirectoryInfo][IO.Path]::GetFullPath($monitorRoot)
while ($ancestor) {
    if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse point in monitor ancestors' }
    $ancestor = $ancestor.Parent
}
New-Item -ItemType Directory -Force $monitorRoot | Out-Null
Protect-MonitorTree
New-Item -ItemType Directory -Force $versionRoot,$reportRoot | Out-Null
foreach ($file in $files) {
    $target = Join-Path $versionRoot $file
    if (Test-Path -LiteralPath $target) {
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash -ne $fingerprints[$file]) { throw 'Existing frozen monitor version differs' }
    } else { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $target }
}
Protect-MonitorTree
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromMinutes(4)) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$monitorAction = New-ScheduledTaskAction -Execute $python -Argument "-X utf8 `"$versionRoot/operations-monitor.py`" --output `"$reportRoot`"" -WorkingDirectory $versionRoot
$auditAction = New-ScheduledTaskAction -Execute $python -Argument "-X utf8 `"$versionRoot/check-dependencies.py`" --application-root `"$appRoot`" --output `"$reportRoot/dependencies.json`" --uv `"$uv`" --npm `"$npm`"" -WorkingDirectory $versionRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(45) -RepetitionInterval ([TimeSpan]::FromMinutes(5))
$weekly = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '04:00'
foreach ($name in $taskNames) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
        Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $monitorRoot ("task-before-" + $name + '-' + (Get-Date -Format yyyyMMddHHmmss) + '.xml')) -Encoding UTF8
    }
}
Register-ScheduledTask -TaskName $taskNames[0] -Action $monitorAction -Trigger $trigger -Principal $principal -Settings $settings -Description $description -Force | Out-Null
Register-ScheduledTask -TaskName $taskNames[1] -Action $auditAction -Trigger $weekly -Principal $principal -Settings $settings -Description $description -Force | Out-Null
$plan | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $monitorRoot 'install-receipt.json') -Encoding UTF8
Start-ScheduledTask -TaskName $taskNames[1]
Start-ScheduledTask -TaskName $taskNames[0]
Write-Output 'Tasks registered and started. Verify fresh reports and Task Scheduler results before declaring activation complete.'
