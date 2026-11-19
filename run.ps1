# Quick launcher: installs deps if needed, then starts the bridge.
# Usage: .\run.ps1 [-Port 8787] [-Model auto] [-ApiKey secret]
param(
  [int]$Port = 8787,
  [string]$Model = "auto",
  [string]$ApiKey
)
Set-Location $PSScriptRoot
if (-not (Test-Path node_modules)) { npm install }
$env:PORT = $Port
$env:DEFAULT_MODEL = $Model
if ($ApiKey) { $env:BRIDGE_API_KEY = $ApiKey }
node server.mjs
