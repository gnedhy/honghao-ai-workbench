param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
try {
    $appRoot = 'C:/ProgramData/HonghaoAI/application'
    $config = Get-Content "$appRoot/active.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $python = Join-Path $config.release_dir '.venv/Scripts/python.exe'
    $launcher = "$appRoot/launch-production.py"
    foreach ($path in @($python, $launcher, $config.data_dir)) {
        if (!(Test-Path -LiteralPath $path)) { throw "Missing deployment path: $path" }
    }
    if ($config.database_profile -ne 'production' -or $config.host -ne '127.0.0.1') {
        throw 'Unexpected production configuration. Check active.json.'
    }
    if ((Get-Service HonghaoPostgreSQL18).Status -ne 'Running') {
        throw 'HonghaoPostgreSQL18 is not running. Start the database service first.'
    }
    $url = "http://127.0.0.1:$($config.port)"
    $listener = Get-NetTCPConnection -State Listen -LocalPort $config.port -ErrorAction SilentlyContinue
    if ($listener) {
        foreach ($owner in ($listener.OwningProcess | Select-Object -Unique)) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
            $verifiedPython = $process.ExecutablePath -and
                [IO.Path]::GetFullPath($process.ExecutablePath) -eq [IO.Path]::GetFullPath($python)
            if (!$verifiedPython) {
                # Windows venv launches a child process using the base Python executable.
                $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)"
                $verifiedPython = $parent.ExecutablePath -and
                    [IO.Path]::GetFullPath($parent.ExecutablePath) -eq [IO.Path]::GetFullPath($python)
            }
            if (!$verifiedPython -or !$process.CommandLine -or
                !$process.CommandLine.Replace('\','/').Contains('"' + $launcher + '"')) {
                throw 'Port occupied by an unverified process. No process was stopped.'
            }
        }
    } elseif (!$CheckOnly) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $errorLog = "$appRoot/service-$stamp.err.log"
        Write-Host "Starting workbench. Error log: $errorLog"
        Start-Process -FilePath $python -ArgumentList "-X utf8 `"$launcher`"" `
            -WorkingDirectory $config.release_dir -WindowStyle Hidden `
            -RedirectStandardOutput "$appRoot/service-$stamp.out.log" `
            -RedirectStandardError $errorLog
    }
    if ($CheckOnly) {
        Write-Host "Configuration, database service and port check OK: $url"
        exit 0
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $response = Invoke-RestMethod "$url/api/readiness" -TimeoutSec 2
            $ready = $response.status -eq 'ready'
        } catch { $ready = $false }
        if ($ready) { break }
        Start-Sleep -Seconds 1
    }
    if (!$ready) { throw "Workbench is not ready. Check service logs in $appRoot" }
    Write-Host "Workbench ready: $url"
    Start-Process $url
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
