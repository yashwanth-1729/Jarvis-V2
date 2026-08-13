<#
.SYNOPSIS
    Start the JARVIS backend and frontend together (native PowerShell).

.EXAMPLE
    .\run.ps1
    Start both servers.

.EXAMPLE
    .\run.ps1 -Setup
    Install backend and frontend dependencies first, then start both.
#>
[CmdletBinding()]
param(
    [switch]$Setup,
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 3000
)

$ErrorActionPreference = 'Stop'

$Root     = $PSScriptRoot
$Backend  = Join-Path $Root 'backend'
$Frontend = Join-Path $Root 'frontend'
$Python   = Join-Path $Backend '.venv\Scripts\python.exe'

function Write-Jarvis($Message, $Color = 'Cyan') {
    Write-Host "[jarvis] " -ForegroundColor $Color -NoNewline
    Write-Host $Message
}

if ($Setup) {
    Write-Jarvis 'Creating backend virtualenv...'
    Push-Location $Backend
    try {
        python -m venv .venv
        & $Python -m pip install --upgrade pip --quiet
        Write-Jarvis 'Installing backend dependencies...'
        & $Python -m pip install -r requirements.txt
    } finally { Pop-Location }

    Write-Jarvis 'Installing frontend dependencies...'
    Push-Location $Frontend
    try { npm install --no-audit --no-fund } finally { Pop-Location }

    Write-Jarvis 'Setup complete.'
}

# --- preflight -------------------------------------------------------------

if (-not (Test-Path $Python)) {
    Write-Jarvis 'No virtualenv found. Run: .\run.ps1 -Setup' 'Red'
    exit 1
}
if (-not (Test-Path (Join-Path $Frontend 'node_modules'))) {
    Write-Jarvis 'Frontend dependencies missing. Run: .\run.ps1 -Setup' 'Red'
    exit 1
}

$envFile = Join-Path $Backend '.env'
if (-not (Test-Path $envFile)) {
    Write-Jarvis 'backend\.env not found - copying from .env.example.' 'Yellow'
    Copy-Item (Join-Path $Backend '.env.example') $envFile
    Write-Jarvis 'Add your ANTHROPIC_API_KEY to backend\.env, then restart.' 'Yellow'
}

$localEnv = Join-Path $Frontend '.env.local'
if (-not (Test-Path $localEnv)) {
    Write-Jarvis 'Creating frontend\.env.local from the example.'
    Copy-Item (Join-Path $Frontend '.env.local.example') $localEnv
}

# --- run -------------------------------------------------------------------

Write-Jarvis "Backend  -> http://127.0.0.1:$BackendPort  (docs at /docs)"
$backendProc = Start-Process -FilePath $Python `
    -ArgumentList @('-m', 'uvicorn', 'main:app', '--reload', '--port', "$BackendPort") `
    -WorkingDirectory $Backend -NoNewWindow -PassThru

Write-Jarvis "Frontend -> http://localhost:$FrontendPort"
$frontendProc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/c', 'npm', 'run', 'dev', '--', '--port', "$FrontendPort") `
    -WorkingDirectory $Frontend -NoNewWindow -PassThru

Write-Jarvis 'Both processes started. Press Ctrl-C to stop.'

try {
    while ($true) {
        if ($backendProc.HasExited -or $frontendProc.HasExited) { break }
        Start-Sleep -Seconds 1
    }
} finally {
    Write-Jarvis 'Shutting down...'
    foreach ($proc in @($backendProc, $frontendProc)) {
        if ($proc -and -not $proc.HasExited) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
        }
    }
}
