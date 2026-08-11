<#
.SYNOPSIS
  Start baatjie-mcp-server (tanOS + sigscheCore) locally.

.DESCRIPTION
  Credentials are read from .env in this folder, which is gitignored. This script
  holds no secrets and is safe to commit.

  Environment variables set here take precedence over .env, because dotenv does
  not overwrite values that are already present in the process environment.

.EXAMPLE
  .\run.ps1
  HTTP on http://127.0.0.1:3000/mcp

.EXAMPLE
  .\run.ps1 -Port 3100 -Rebuild

.EXAMPLE
  .\run.ps1 -Stdio
  stdio mode, for attaching a local MCP client

.NOTES
  The /mcp endpoint has no authentication and the server holds service_role keys
  that bypass RLS on both projects. Do not change -BindHost off loopback.
#>

[CmdletBinding()]
param(
    [int]    $Port      = 3000,
    [string] $BindHost  = "127.0.0.1",
    [switch] $Stdio,
    [switch] $Rebuild
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# --- preflight ------------------------------------------------------------

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node was not found on PATH. Install Node 18 or newer."
}

if (-not (Test-Path ".\.env")) {
    Write-Host ""
    Write-Host "No .env found." -ForegroundColor Yellow
    Write-Host "Create one from the template, then fill in both service_role keys:"
    Write-Host ""
    Write-Host "    Copy-Item .env.example .env" -ForegroundColor Cyan
    Write-Host "    notepad .env" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Find the keys in Supabase under Project Settings -> API -> service_role."
    throw "Missing .env"
}

# Warn on placeholder/empty keys before the server exits with a less obvious error.
$envText  = Get-Content ".\.env" -Raw
foreach ($key in @("TANOS_SERVICE_KEY", "SIGSCHE_SERVICE_KEY")) {
    if ($envText -notmatch "(?m)^\s*$key\s*=\s*\S+") {
        Write-Warning "$key looks empty in .env. RLS is enabled with no policies on both projects, so a missing or non-service-role key returns EMPTY RESULTS rather than an error."
    }
}

if ($Rebuild -and (Test-Path ".\dist")) {
    Remove-Item ".\dist" -Recurse -Force
}

if (-not (Test-Path ".\node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

if (-not (Test-Path ".\dist\index.js")) {
    Write-Host "Building..." -ForegroundColor Cyan
    npx tsc
    if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed" }
}

# --- run ------------------------------------------------------------------

if ($Stdio) {
    $env:TRANSPORT = "stdio"
    Write-Host "Starting on stdio. Ctrl+C to stop." -ForegroundColor Green
}
else {
    $env:TRANSPORT = "http"
    $env:PORT      = "$Port"
    $env:HOST      = $BindHost

    Write-Host ""
    Write-Host "  MCP endpoint  http://${BindHost}:${Port}/mcp"  -ForegroundColor Green
    Write-Host "  Health        http://${BindHost}:${Port}/health"
    Write-Host ""
    Write-Host "  No authentication on /mcp - keep this on loopback." -ForegroundColor Yellow
    Write-Host "  Ctrl+C to stop."
    Write-Host ""
}

node ".\dist\index.js"
