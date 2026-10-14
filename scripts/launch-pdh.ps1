param(
    [switch]$Restart,
    [switch]$SkipDocker,
    [ValidateRange(1, 3600)]
    [int]$StartupTimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
$serviceRoot = Split-Path -Parent $PSScriptRoot
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$logRoot = Join-Path $serviceRoot 'logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
function Get-StartupDiagnostics([string]$Name) {
    foreach ($suffix in @('err', 'out')) {
        $path = Join-Path $logRoot "$Name.$suffix.log"
        "Log: $path"
        if (Test-Path -LiteralPath $path) {
            Get-Content -LiteralPath $path -Tail 20 -ErrorAction SilentlyContinue
        }
    }
}
$services = @(
    @{Name='gateway';Port=3000}, @{Name='connector-service';Port=3001},
    @{Name='order-service';Port=3002}, @{Name='merchant-service';Port=3003},
    @{Name='inventory-service';Port=3005},
    @{Name='analytics-service';Port=3006}, @{Name='pos-integration-service';Port=3007},
    @{Name='notification-service';Port=3008}, @{Name='admin-api';Port=3009},
    @{Name='auth-service';Port=3010}
)
# Serialize launches so repeated clicks cannot start competing service copies.
$launchMutex = New-Object System.Threading.Mutex($false, 'Local\PinakaCommerceHubLauncher')
if (-not $launchMutex.WaitOne(0)) { throw 'The local service launcher is already running.' }
try {
    if (-not $SkipDocker) {
        try {
            & docker compose --project-directory $serviceRoot -f (Join-Path $serviceRoot 'docker-compose.yml') up -d 2>$null
            if ($LASTEXITCODE -eq 0) {
                $pgReady = $false
                for ($attempt = 1; $attempt -le 30; $attempt++) {
                    & docker compose --project-directory $serviceRoot exec -T postgres pg_isready -U pdh_user 2>$null | Out-Null
                    if ($LASTEXITCODE -eq 0) { $pgReady = $true; break }
                    Start-Sleep -Seconds 1
                }
                if ($pgReady) {
                    $ensureDatabaseSql = @'
SELECT 'CREATE DATABASE pinaka_commerce_hub' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pinaka_commerce_hub')
\gexec
'@
                    $ensureDatabaseSql | & docker compose --project-directory $serviceRoot exec -T postgres psql -U pdh_user -d postgres -v ON_ERROR_STOP=1 2>$null | Out-Null
                    Write-Host 'PostgreSQL ready: pinaka_commerce_hub (pgAdmin http://localhost:5050).'
                } else {
                    Write-Host '⚠️ Docker PostgreSQL did not respond in time. Proceeding in in-memory fallback mode.'
                }
            } else {
                Write-Host '⚠️ Docker daemon is not running. Microservices will start in in-memory fallback mode.'
            }
        } catch {
            Write-Host '⚠️ Docker startup skipped (Docker daemon offline). Microservices starting in fallback mode.'
        }
    }
    foreach ($service in $services) {
        $entry = Join-Path $serviceRoot "apps/$($service.Name)/src/main.ts"
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $service.Port)
        if ($listeners.Count) {
            $owners = @($listeners.OwningProcess | Select-Object -Unique)
            foreach ($owner in $owners) {
                $process = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
                $normalized = $process.CommandLine -replace '\\', '/'
                $absoluteEntry = $entry -replace '\\', '/'
                # Relative entry points are also used by this project's original launcher.
                $relativeEntry = "apps/$($service.Name)/src/main.ts"
                $matchesService = $process.Name -eq 'node.exe' -and ($normalized.Contains($absoluteEntry) -or $normalized -match ('(?:\s|"|\x27)' + [regex]::Escape($relativeEntry) + '(?:\s|"|\x27|$)'))
                if (-not $matchesService) { throw "Port $($service.Port) belongs to another process (PID $owner). It was not stopped." }
                if ($Restart) { Stop-Process -Id $owner -ErrorAction Stop }
            }
            if (-not $Restart) {
                Write-Host "$($service.Name): already running on $($service.Port); reused."
                continue
            }
            $releaseDeadline = (Get-Date).AddSeconds(10)
            while (@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $service.Port).Count) {
                if ((Get-Date) -gt $releaseDeadline) { throw "Port $($service.Port) did not become free." }
                Start-Sleep -Milliseconds 200
            }
        }
        $started = Start-Process -FilePath $nodeExecutable -ArgumentList @('--import','tsx',('"' + $entry + '"')) -WorkingDirectory $serviceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot "$($service.Name).out.log") -RedirectStandardError (Join-Path $logRoot "$($service.Name).err.log")
        Write-Host "$($service.Name): starting (PID $($started.Id)); waiting up to $StartupTimeoutSeconds seconds for port $($service.Port)."
        $readyDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
        do {
            Start-Sleep -Milliseconds 300
            $started.Refresh()
            if ($started.HasExited) {
                $diagnostics = (Get-StartupDiagnostics $service.Name) -join [Environment]::NewLine
                throw "$($service.Name) exited with code $($started.ExitCode).`n$diagnostics"
            }
            $ready = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq $service.Port -and $_.OwningProcess -eq $started.Id }).Count -gt 0
        } until ($ready -or (Get-Date) -gt $readyDeadline)
        if (-not $ready) {
            $diagnostics = (Get-StartupDiagnostics $service.Name) -join [Environment]::NewLine
            throw "$($service.Name) did not bind port $($service.Port) within $StartupTimeoutSeconds seconds. PID $($started.Id) is still running and may finish starting. Check the logs and process before retrying. For slow startup, increase -StartupTimeoutSeconds.`n$diagnostics"
        }
        Write-Host "$($service.Name): ready on $($service.Port) (PID $($started.Id))."
    }
    $pgAdminListening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -eq 5050).Count -gt 0
    if (-not $pgAdminListening) {
        $pythonExe = 'C:\Program Files\PostgreSQL\18\pgAdmin 4\python\python.exe'
        $pgAdminPy = 'C:\Program Files\PostgreSQL\18\pgAdmin 4\web\pgAdmin4.py'
        if ((Test-Path -LiteralPath $pythonExe) -and (Test-Path -LiteralPath $pgAdminPy)) {
            Write-Host 'Starting pgAdmin 4 Web Server on port 5050...'
            Start-Process -FilePath "powershell.exe" -ArgumentList @('-WindowStyle', 'Hidden', '-Command', "`$env:PATH = 'C:\Program Files\PostgreSQL\18\pgAdmin 4\runtime;C:\Program Files\PostgreSQL\18\bin;' + `$env:PATH; `$env:PGADMIN_INT_PORT = '5050'; Remove-Item env:PGADMIN_INT_KEY -ErrorAction SilentlyContinue; & '$pythonExe' -s '$pgAdminPy'") -WindowStyle Hidden
            for ($attempt = 1; $attempt -le 15; $attempt++) {
                Start-Sleep -Seconds 1
                $pgAdminListening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -eq 5050).Count -gt 0
                if ($pgAdminListening) { break }
            }
        }
    }
    if ($pgAdminListening) {
        Write-Host '🐘 pgAdmin 4: http://localhost:5050 (Direct browser access enabled)'
    } else {
        Write-Host 'PostgreSQL: Native Windows Service (postgresql-x64-18) running on port 5432.'
    }
    Write-Host 'React: http://localhost:5173 (start npm run dev in pinaka-commerce-hub-web).'
    Write-Host 'Re-running this command reuses existing services. Add -Restart to reload backend services.'
} finally {
    $launchMutex.ReleaseMutex()
    $launchMutex.Dispose()
}
