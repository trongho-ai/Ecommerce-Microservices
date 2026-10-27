$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Test-All.ps1') -Group shipment
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
