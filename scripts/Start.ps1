param([ValidateRange(1024,65535)][int]$Port = 3001, [switch]$SkipSeed)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
function Invoke-DockerChecked {
    param([string[]]$DockerArguments)
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw ('Docker failed (exit ' + $LASTEXITCODE + '): docker ' + ($DockerArguments -join ' ')) }
}
Push-Location -LiteralPath $repoPath
try {
    Get-Command docker -ErrorAction Stop | Out-Null
    & (Join-Path $PSScriptRoot 'Initialize.ps1') -Port $Port
    Invoke-DockerChecked -DockerArguments @('version', '--format', '{{.Server.Version}}')
    $engineType = & docker info --format '{{.OSType}}'
    if ($LASTEXITCODE -ne 0) { throw 'Docker Engine is unavailable. Open Docker Desktop and wait until the Linux Engine is ready.' }
    if (($engineType | Out-String).Trim() -ne 'linux') { throw 'Switch Docker Desktop to Linux containers before starting this project.' }
    Invoke-DockerChecked -DockerArguments @('compose', 'config', '--quiet')
    Invoke-DockerChecked -DockerArguments @('compose', 'build', 'api-gateway')
    Invoke-DockerChecked -DockerArguments @('compose', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '240')
    if (-not $SkipSeed) {
        Invoke-DockerChecked -DockerArguments @('compose', '--profile', 'tools', 'run', '--rm', '-T', 'test-runner', 'node', 'scripts/seed.js')
    }
    Invoke-DockerChecked -DockerArguments @('compose', 'ps', '--all')
    $portMatch = [regex]::Match([IO.File]::ReadAllText((Join-Path $repoPath '.env')), '(?m)^API_PORT=(\d+)\s*$')
    if (-not $portMatch.Success) { throw 'API_PORT is missing from .env' }
    $baseUrl = 'http://localhost:' + $portMatch.Groups[1].Value
    $health = Invoke-RestMethod -Uri ($baseUrl + '/api/health') -TimeoutSec 15
    if ($health.status -ne 'UP') { throw 'Gateway health did not return UP.' }
    Write-Host ('Project ready: ' + $baseUrl)
    Write-Host 'Next: powershell -NoProfile -File .\scripts\Test-All.ps1'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally { Pop-Location }
