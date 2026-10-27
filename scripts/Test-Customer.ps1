$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Test-All.ps1') -Group customer
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
