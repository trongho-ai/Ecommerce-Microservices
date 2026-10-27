$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$dockerPath = (Get-Command docker.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path
$artifactPath = Join-Path $repoPath 'artifacts'
$runStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$evidencePrefix = Join-Path $artifactPath ('kafka-outage-' + $runStamp)

function Invoke-DockerCaptured {
    param([string[]]$DockerArguments, [string]$Label)
    # No shell is involved. Arguments are fixed script values and a validated numeric oid.
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $dockerPath
    $startInfo.Arguments = ($DockerArguments -join ' ')
    $startInfo.WorkingDirectory = $repoPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $startInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    $stdout = ''
    $stderr = ''
    $nativeExit = -1
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Could not start Docker CLI.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(180000)) { throw ('Docker command timed out: ' + $Label) }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $nativeExit = $process.ExitCode
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
    $stdoutPath = $evidencePrefix + '-' + $Label + '.stdout.log'
    $stderrPath = $evidencePrefix + '-' + $Label + '.docker.log'
    [IO.File]::WriteAllText($stdoutPath, $stdout, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($stderrPath, $stderr, (New-Object Text.UTF8Encoding($false)))
    if ($nativeExit -ne 0) {
        if ($stdout) { Write-Host $stdout }
        if ($stderr) { Write-Host $stderr }
        throw ('Docker command ' + $Label + ' failed with exit ' + $nativeExit + '. See ' + $stderrPath)
    }
    return [pscustomobject]@{ Output = $stdout; ExitCode = $nativeExit }
}

function Get-HealthHttpStatus {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + '/api/health') -TimeoutSec 12 -ErrorAction Stop
        return [int]$response.StatusCode
    } catch {
        # Windows PowerShell 5.1 throws for HTTP 503. Inspect the response rather
        # than treating the expected HTTP error as an invocation failure.
        if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

function Wait-HealthStatus {
    param([int]$Expected, [int]$TimeoutSeconds = 60)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastStatus = 0
    do {
        $lastStatus = Get-HealthHttpStatus
        if ($lastStatus -eq $Expected) { return }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw ('Health did not return HTTP ' + $Expected + ' within timeout; last status=' + $lastStatus)
}

function Read-ModeEvidence {
    param([string]$Output, [string]$Mode)
    $records = @()
    foreach ($line in ($Output -split '\r?\n')) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $candidate = ConvertFrom-Json -InputObject $line -ErrorAction Stop }
        catch { continue }
        if ($candidate.mode -eq $Mode) { $records += $candidate }
    }
    if ($records.Count -ne 1 -or $records[0].status -ne 'PASS') { throw ('Expected exactly one successful JSON evidence record for ' + $Mode) }
    $oid = [long]$records[0].oid
    if ($oid -lt 1 -or $oid -gt 2147483647) { throw 'Evidence contains an invalid oid.' }
    if ([string]::IsNullOrWhiteSpace([string]$records[0].eventId)) { throw 'Evidence is missing eventId.' }
    return $records[0]
}

Push-Location -LiteralPath $repoPath
try {
    if (-not (Test-Path -LiteralPath '.env')) { throw 'Run scripts\Start.ps1 before testing Kafka recovery.' }
    $portMatch = [regex]::Match([IO.File]::ReadAllText((Join-Path $repoPath '.env')), '(?m)^API_PORT=(\d+)\s*$')
    if (-not $portMatch.Success) { throw 'API_PORT is missing from .env' }
    $baseUrl = 'http://localhost:' + $portMatch.Groups[1].Value
    New-Item -ItemType Directory -Force -Path $artifactPath | Out-Null
    $createEvidence = $null
    $testFailure = $null
    $restartFailure = $null

    try {
        Write-Host 'Stopping this project Kafka broker for the controlled outage test.'
        $null = Invoke-DockerCaptured -Label stop -DockerArguments @('compose', '--progress', 'quiet', 'stop', '--timeout', '20', 'kafka')
        Wait-HealthStatus -Expected 503
        Write-Host 'Observed HTTP 503. Creating an Order while its Outbox must remain PENDING.'
        $created = Invoke-DockerCaptured -Label create -DockerArguments @('compose', '--progress', 'quiet', '--profile', 'tools', 'run', '--rm', '--no-deps', '-T', 'test-runner', 'node', 'tests/kafka-outage.js', 'create')
        $createEvidence = Read-ModeEvidence -Output $created.Output -Mode create
        if ($createEvidence.outbox -ne 'PENDING') { throw 'Outbox was not PENDING during the Kafka outage.' }
        [IO.File]::WriteAllText(($evidencePrefix + '-create.json'), ($createEvidence | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
        Write-Host ($createEvidence | ConvertTo-Json -Compress -Depth 12)
    } catch { $testFailure = $_ }
    finally {
        # Restore the broker even if stopping, the health assertion, JSON parsing,
        # or Order creation failed. Never remove containers, databases or volumes.
        Write-Host 'Restoring Kafka and waiting for broker readiness.'
        try {
            $null = Invoke-DockerCaptured -Label restart -DockerArguments @('compose', '--progress', 'quiet', 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'kafka')
        } catch { $restartFailure = $_ }
    }

    if ($restartFailure) {
        if ($testFailure) { Write-Host ('Original test error: ' + $testFailure.Exception.Message) }
        throw ('Kafka restart failed: ' + $restartFailure.Exception.Message + '. Run docker compose up -d --no-deps kafka and inspect Kafka logs.')
    }
    if ($testFailure) { throw $testFailure }

    Write-Host ('Verifying recovered Outbox/Kafka/Shipment for oid=' + $createEvidence.oid)
    $checked = Invoke-DockerCaptured -Label check -DockerArguments @('compose', '--progress', 'quiet', '--profile', 'tools', 'run', '--rm', '--no-deps', '-T', 'test-runner', 'node', 'tests/kafka-outage.js', 'check', ([string]$createEvidence.oid))
    $checkEvidence = Read-ModeEvidence -Output $checked.Output -Mode check
    if ([long]$checkEvidence.oid -ne [long]$createEvidence.oid -or $checkEvidence.eventId -ne $createEvidence.eventId) { throw 'Recovered evidence does not match the newly created Order/event.' }
    if ($checkEvidence.outbox -ne 'SENT' -or $checkEvidence.kafkaObserved -ne $true -or [int]$checkEvidence.shipmentCount -ne 1) { throw 'Recovered evidence must show SENT, matching Kafka observation and one Shipment.' }
    [IO.File]::WriteAllText(($evidencePrefix + '-check.json'), ($checkEvidence | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    Write-Host ($checkEvidence | ConvertTo-Json -Compress -Depth 12)
    Wait-HealthStatus -Expected 200 -TimeoutSeconds 90
    $health = Invoke-RestMethod -Uri ($baseUrl + '/api/health') -TimeoutSec 12
    if ($health.status -ne 'UP') { throw 'Health HTTP 200 did not contain status UP.' }
    [IO.File]::WriteAllText(($evidencePrefix + '-health.json'), ($health | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    Write-Host ('Kafka outage/recovery check completed. Evidence prefix: ' + $evidencePrefix)
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally { Pop-Location }
