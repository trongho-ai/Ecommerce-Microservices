$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Test-All.ps1') -Group order
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
