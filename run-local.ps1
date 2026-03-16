param(
    [switch]$Backend,
    [switch]$NoReload
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    throw "Virtual environment not found at .venv. Create it first with: python -m venv .venv"
}

$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
    Write-Warning "Missing .env file. Copy .env.example to .env and set your Google API key before running."
}

$env:OPSVOICE_RELOAD = if ($NoReload) { "false" } else { "true" }

$module = if ($Backend) { "app.main" } else { "app.frontend" }
$port = if ($Backend) { 8080 } else { 7860 }
$url = if ($Backend) { "http://127.0.0.1:8080" } else { "http://127.0.0.1:7860" }

function Get-PortOwningProcesses {
    param(
        [int]$Port
    )

    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $connections) {
        return @()
    }

    return @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
}

$existingProcessIds = @(Get-PortOwningProcesses -Port $port)
foreach ($processId in $existingProcessIds) {
    if ($processId -eq $PID) {
        continue
    }

    try {
        $process = Get-Process -Id $processId -ErrorAction Stop
        Write-Host "Stopping $($process.ProcessName) ($processId) on port $port"
        Stop-Process -Id $processId -Force -ErrorAction Stop
    }
    catch {
        throw "Failed to stop process $processId on port $port. $($_.Exception.Message)"
    }
}

$remainingProcessIds = @(Get-PortOwningProcesses -Port $port)
if ($remainingProcessIds.Count -gt 0) {
    throw "Port $port is still in use by process IDs: $($remainingProcessIds -join ', ')"
}

Write-Host "Starting $module at $url"
& $python -m $module
