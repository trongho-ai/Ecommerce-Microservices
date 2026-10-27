$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repoPath
try {
    Get-Command docker -ErrorAction Stop | Out-Null
    & docker compose stop --timeout 30
    if ($LASTEXITCODE -ne 0) { throw ('Docker Compose stop failed with exit ' + $LASTEXITCODE) }
    Write-Host 'Project containers stopped. Containers, volumes and database data are preserved.'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally { Pop-Location }
