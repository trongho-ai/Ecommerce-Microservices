$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
function Invoke-DockerChecked {
    param([string[]]$DockerArguments)
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw ('Docker command failed with exit ' + $LASTEXITCODE) }
}
Push-Location -LiteralPath $repoPath
try {
    Get-Command docker -ErrorAction Stop | Out-Null
    if (-not (Test-Path -LiteralPath '.env')) { throw 'Run scripts\Start.ps1 before the grading demonstration.' }

    Write-Host '[1/8] Proto contracts and DDD folders'
    Get-ChildItem -LiteralPath '.\proto' -Filter '*.proto' | Select-Object Name,Length | Format-Table -AutoSize
    Get-ChildItem -LiteralPath '.\services' -Directory | Select-Object -ExpandProperty Name
    Write-Host 'Explain: service/RPC/request/response/field numbers, four DDD layers, database ownership, gRPC vs Kafka.'

    Write-Host '[2/8] Docker Compose and the container list'
    Invoke-DockerChecked -DockerArguments @('compose', 'config', '--quiet')
    Invoke-DockerChecked -DockerArguments @('compose', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '240')
    Invoke-DockerChecked -DockerArguments @('compose', 'ps', '--all')
    $portMatch = [regex]::Match([IO.File]::ReadAllText((Join-Path $repoPath '.env')), '(?m)^API_PORT=(\d+)\s*$')
    if (-not $portMatch.Success) { throw 'API_PORT is missing from .env' }
    $health = Invoke-RestMethod -Uri ('http://localhost:' + $portMatch.Groups[1].Value + '/api/health') -TimeoutSec 15
    if ($health.status -ne 'UP') { throw 'Gateway health did not return UP.' }
    $health | ConvertTo-Json -Depth 8 | Write-Host

    Write-Host '[3/8] Kafka topic and consumer group'
    Invoke-DockerChecked -DockerArguments @('compose', 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'kafka:9092', '--list')
    Invoke-DockerChecked -DockerArguments @('compose', 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'kafka:9092', '--describe', '--topic', 'order-created')
    Write-Host 'Explain: Order Outbox publisher -> order-created -> Shipment consumer; offsets, retries and eventId deduplication.'

    Write-Host '[4/8] TC-PRO-01: product list from MongoDB'
    Write-Host '[5/8] TC-CUS-04: membership name and score from PostgreSQL'
    Write-Host '[6/8] TC-CUS-05: Customer request without JWT returns HTTP 401'
    Write-Host '[7/8] TC-ORD-04: discount calculated independently from the configured score policy'
    Write-Host '[8/8] TC-ORD-05: committed Order, Outbox, a fresh Kafka event and persisted Shipment'
    Write-Host 'Run the full 25-case suite, including those five grading cases, against the live stack:'
    & (Join-Path $PSScriptRoot 'Test-All.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'The grading integration suite failed.' }
    Invoke-DockerChecked -DockerArguments @('compose', 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-consumer-groups.sh', '--bootstrap-server', 'kafka:9092', '--describe', '--group', 'shipment-service-v1')
    Write-Host 'Demonstration commands completed. Use the integration report for API/database/Kafka evidence.'
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally { Pop-Location }
