param([string]$ApplicationRoot = 'C:/ProgramData/HonghaoAI/application')
$ErrorActionPreference = 'Stop'
try {
    $config = Get-Content -LiteralPath (Join-Path $ApplicationRoot 'active.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $python = [IO.Path]::GetFullPath((Join-Path $config.release_dir '.venv/Scripts/python.exe'))
    $launcher = [IO.Path]::GetFullPath((Join-Path $ApplicationRoot 'launch-production.py')).Replace('\','/')
    if ($config.database_profile -ne 'production' -or $config.host -ne '127.0.0.1') { throw 'identity' }
    if ((Get-Service HonghaoPostgreSQL18).Status -ne 'Running') { throw 'database' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $config.port -ErrorAction Stop)
    if (!$listeners.Count) { throw 'listener' }
    $marker = Get-Content -LiteralPath (Join-Path $config.data_dir '.service.pid') -Raw -Encoding UTF8
    foreach ($owner in ($listeners.OwningProcess | Select-Object -Unique)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
        if ($marker.Trim() -ne "service:$owner") { throw 'data-directory' }
        $verified = $process.ExecutablePath -and [IO.Path]::GetFullPath($process.ExecutablePath) -eq $python
        if (!$verified) {
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)"
            $verified = $parent.ExecutablePath -and [IO.Path]::GetFullPath($parent.ExecutablePath) -eq $python
        }
        if (!$verified -or !$process.CommandLine -or !$process.CommandLine.Replace('\','/').Contains('"' + $launcher + '"')) { throw 'process' }
    }
    Write-Output '{"status":"ok"}'
    exit 0
} catch {
    Write-Output '{"status":"failed"}'
    exit 2
}
