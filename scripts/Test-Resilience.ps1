$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Test-All.ps1') -Suite resilience
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit 0
