param(
    [ValidateSet('all','auth','customer','product','order','shipment')][string]$Group = 'all',
    [ValidateSet('integration','system','resilience')][string]$Suite = 'integration'
)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repoPath
try {
    $dockerPath = (Get-Command docker.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path
    if (-not (Test-Path -LiteralPath '.env')) { throw 'Run scripts\Start.ps1 first to initialize and start the project.' }
    if ($Suite -ne 'integration' -and $Group -ne 'all') { throw 'The Group parameter only applies to the integration suite.' }
    $artifactPath = Join-Path $repoPath 'artifacts'
    New-Item -ItemType Directory -Force -Path $artifactPath | Out-Null
    $reportPath = Join-Path $artifactPath ($Suite + '-' + $Group + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
    $dockerLogPath = [IO.Path]::ChangeExtension($reportPath, '.docker.log')
    $dockerArguments = @('compose', '--progress', 'quiet', '--profile', 'tools', 'run', '--rm', '-T', 'test-runner', 'node', ('tests/' + $Suite + '.js'))
    if ($Suite -eq 'integration' -and $Group -ne 'all') { $dockerArguments += @('--group', $Group) }
    # Direct process execution avoids PowerShell 5.1 converting ordinary Docker stderr
    # into red NativeCommandError records. All arguments here are fixed values or a
    # validated group name; the working directory is passed separately and may contain spaces.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $dockerPath
    $startInfo.Arguments = ($dockerArguments -join ' ')
    $startInfo.WorkingDirectory = $repoPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $startInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $nativeExit = -1
    $started = $false
    $dockerStderr = ''
    [IO.File]::WriteAllText($reportPath, '', (New-Object Text.UTF8Encoding($false)))
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Could not start Docker CLI.' }
        $stderrTask = $process.StandardError.ReadToEndAsync()
        while ($null -ne ($line = $process.StandardOutput.ReadLine())) {
            $line | Tee-Object -FilePath $reportPath -Append
        }
        $process.WaitForExit()
        $dockerStderr = $stderrTask.GetAwaiter().GetResult()
        $nativeExit = $process.ExitCode
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
    [IO.File]::WriteAllText($dockerLogPath, $dockerStderr, (New-Object Text.UTF8Encoding($false)))
    Write-Host ('Evidence: ' + $reportPath)
    if ($nativeExit -ne 0) {
        if ($dockerStderr) { Write-Host $dockerStderr }
        throw ($Suite + ' tests failed with exit ' + $nativeExit + '. See ' + $reportPath + ' and ' + $dockerLogPath)
    }
    Write-Host ('Test suite completed successfully: ' + $Suite + '; group: ' + $Group)
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally { Pop-Location }
