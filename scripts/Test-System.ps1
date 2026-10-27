$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Test-All.ps1') -Suite system
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit 0
