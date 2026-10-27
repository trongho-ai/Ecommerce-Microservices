$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Test-All.ps1') -Group auth
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
