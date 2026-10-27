$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$dockerPath = (Get-Command docker.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path
$artifactPath = Join-Path $repoPath 'artifacts'
$runStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$evidencePrefix = Join-Path $artifactPath ('order-restart-' + $runStamp)

function Invoke-DockerCaptured {
    param([string[]]$DockerArguments, [string]$Label)
    # Fixed arguments and strictly validated UUIDs only; no shell interpolation.
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
    [IO.File]::WriteAllText(($evidencePrefix + '-' + $Label + '.stdout.log'), $stdout, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText(($evidencePrefix + '-' + $Label + '.docker.log'), $stderr, (New-Object Text.UTF8Encoding($false)))
    if ($nativeExit -ne 0) {
        if ($stdout) { Write-Host $stdout }
        if ($stderr) { Write-Host $stderr }
        throw ('Docker command ' + $Label + ' failed with exit ' + $nativeExit)
    }
    return [pscustomobject]@{ Output = $stdout; ExitCode = $nativeExit }
}

function Read-ModeEvidence {
    param([string]$Output, [string]$Mode)
    $records = @()
    foreach ($line in ($Output -split '\r?\n')) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $candidate = ConvertFrom-Json -InputObject $line -ErrorAction Stop } catch { continue }
        if ($candidate.mode -eq $Mode) { $records += $candidate }
    }
    if ($records.Count -ne 1 -or $records[0].status -ne 'PASS') { throw ('Expected exactly one PASS JSON record for ' + $Mode) }
    if ([string]$records[0].operationId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') { throw 'Evidence contains an invalid UUID v4.' }
    return $records[0]
}

function Wait-HealthUp {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        try {
            $health = Invoke-RestMethod -Uri ($baseUrl + '/api/health') -TimeoutSec 12 -ErrorAction Stop
            if ($health.status -eq 'UP') { return $health }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Gateway health did not return UP after Order restart.'
}

Push-Location -LiteralPath $repoPath
try {
    if (-not (Test-Path -LiteralPath '.env')) { throw 'Run scripts\Start.ps1 before this recovery check.' }
    $portMatch = [regex]::Match([IO.File]::ReadAllText((Join-Path $repoPath '.env')), '(?m)^API_PORT=(\d+)\s*$')
    if (-not $portMatch.Success) { throw 'API_PORT is missing from .env' }
    $baseUrl = 'http://localhost:' + $portMatch.Groups[1].Value
    New-Item -ItemType Directory -Force -Path $artifactPath | Out-Null
    $prepareEvidence = $null
    $testFailure = $null
    $restartFailure = $null
    $containerId = $null
    $originalRestartPolicy = $null
    $restartPolicyMayHaveChanged = $false
    try {
        Write-Host 'Staging a durable Order attempt with real inventory already applied.'
        $prepared = Invoke-DockerCaptured -Label prepare -DockerArguments @('compose', '--progress', 'quiet', '--profile', 'tools', 'run', '--rm', '--no-deps', '-T', 'test-runner', 'node', 'tests/order-restart.js', 'prepare')
        $prepareEvidence = Read-ModeEvidence -Output $prepared.Output -Mode prepare
        [IO.File]::WriteAllText(($evidencePrefix + '-prepare.json'), ($prepareEvidence | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
        Write-Host ($prepareEvidence | ConvertTo-Json -Compress -Depth 12)

        # stop --timeout 0 can still allow a fast SIGTERM handler to exit normally.
        # Disable auto-restart on this one container, then send SIGKILL explicitly.
        $containerResult = Invoke-DockerCaptured -Label container-id -DockerArguments @('compose', '--progress', 'quiet', 'ps', '-q', 'order-service')
        $containerId = $containerResult.Output.Trim()
        if ($containerId -notmatch '^[a-fA-F0-9]{12,64}$') { throw 'Expected exactly one hexadecimal Order container ID.' }
        $policyResult = Invoke-DockerCaptured -Label restart-policy -DockerArguments @('inspect', '--format={{.HostConfig.RestartPolicy.Name}}', $containerId)
        $originalRestartPolicy = $policyResult.Output.Trim()
        if ($originalRestartPolicy -ne 'unless-stopped') { throw 'Expected this project Order restart policy unless-stopped before the test.' }
        $restartPolicyMayHaveChanged = $true
        $null = Invoke-DockerCaptured -Label disable-restart -DockerArguments @('update', '--restart=no', $containerId)
        Write-Host 'Sending SIGKILL to this project Order Service container.'
        $null = Invoke-DockerCaptured -Label kill -DockerArguments @('kill', '--signal', 'KILL', $containerId)
        $stopped = Invoke-DockerCaptured -Label stopped -DockerArguments @('compose', '--progress', 'quiet', 'ps', '--all', '--format', 'json', 'order-service')
        $container = ConvertFrom-Json -InputObject $stopped.Output -ErrorAction Stop
        if (@($container).Count -ne 1 -or $container.State -ne 'exited' -or [int]$container.ExitCode -ne 137) { throw 'Expected Order container exited with 137 (SIGKILL); see stopped evidence.' }
        [IO.File]::WriteAllText(($evidencePrefix + '-stopped.json'), ($container | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))

        $expired = Invoke-DockerCaptured -Label expire -DockerArguments @('compose', '--progress', 'quiet', '--profile', 'tools', 'run', '--rm', '--no-deps', '-T', 'test-runner', 'node', 'tests/order-restart.js', 'expire', ([string]$prepareEvidence.operationId))
        $expireEvidence = Read-ModeEvidence -Output $expired.Output -Mode expire
        if ($expireEvidence.operationId -ne $prepareEvidence.operationId -or $expireEvidence.leaseExpired -ne $true) { throw 'Expired attempt does not match staged operation.' }
        [IO.File]::WriteAllText(($evidencePrefix + '-expire.json'), ($expireEvidence | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
        Write-Host ($expireEvidence | ConvertTo-Json -Compress -Depth 12)
    } catch { $testFailure = $_ }
    finally {
        # Restore Order even if prepare, stop, parsing or expiry assertion fails.
        Write-Host 'Restoring Order Service and waiting for readiness.'
        if ($restartPolicyMayHaveChanged -and $containerId -and $originalRestartPolicy) {
            try { $null = Invoke-DockerCaptured -Label restore-policy -DockerArguments @('update', ('--restart=' + $originalRestartPolicy), $containerId) }
            catch { $restartFailure = $_ }
        }
        try { $null = Invoke-DockerCaptured -Label restart -DockerArguments @('compose', '--progress', 'quiet', 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'order-service') }
        catch { $restartFailure = $_ }
    }
    if ($restartFailure) {
        if ($testFailure) { Write-Host ('Original error: ' + $testFailure.Exception.Message) }
        throw ('Order restart failed: ' + $restartFailure.Exception.Message + '. Run docker compose up -d --no-deps order-service.')
    }
    if ($testFailure) { throw $testFailure }

    $checked = Invoke-DockerCaptured -Label check -DockerArguments @('compose', '--progress', 'quiet', '--profile', 'tools', 'run', '--rm', '--no-deps', '-T', 'test-runner', 'node', 'tests/order-restart.js', 'check', ([string]$prepareEvidence.operationId))
    $checkEvidence = Read-ModeEvidence -Output $checked.Output -Mode check
    if ($checkEvidence.operationId -ne $prepareEvidence.operationId -or $checkEvidence.state -ne 'ABORTED' -or $checkEvidence.receipt -ne 'CANCELLED' -or [int]$checkEvidence.stock -ne [int]$prepareEvidence.initialStock -or [int]$checkEvidence.orderCount -ne 0 -or [int]$checkEvidence.outboxCount -ne 0) { throw 'Recovery did not restore the staged fixture consistently.' }
    [IO.File]::WriteAllText(($evidencePrefix + '-check.json'), ($checkEvidence | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    Write-Host ($checkEvidence | ConvertTo-Json -Compress -Depth 12)
    $health = Wait-HealthUp
    [IO.File]::WriteAllText(($evidencePrefix + '-health.json'), ($health | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    $null = Invoke-DockerCaptured -Label order-logs -DockerArguments @('compose', '--progress', 'quiet', 'logs', '--no-color', '--tail', '80', 'order-service')
    Write-Host ('Order restart recovery completed. Evidence prefix: ' + $evidencePrefix)
    Write-Host 'Scope: a staged durable boundary plus actual SIGKILL/restart, not a live request interrupted at a deterministic source line.'
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally { Pop-Location }
