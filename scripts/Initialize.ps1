param([int]$Port = 3001)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoPath '.env'
if (Test-Path -LiteralPath $envPath) { Write-Host '.env already exists; preserving all settings.'; exit 0 }
function New-LocalSecret {
    $buffer = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($buffer)).Replace('-', '').ToLowerInvariant()
}
$content = [IO.File]::ReadAllText((Join-Path $repoPath '.env.example'))
$content = $content.Replace('API_PORT=3001', ('API_PORT=' + $Port))
foreach ($placeholder in @('replace-with-random-internal-key','replace-with-at-least-32-random-characters','replace-auth-db-password','replace-customer-db-password','replace-order-db-password','replace-product-db-password','replace-shipment-db-password','replace-with-long-random-alphanumeric-key','replace-redis-password')) {
    $content = $content.Replace($placeholder, (New-LocalSecret))
}
[IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding($false)))
Write-Host ('.env created with random local secrets. API port: ' + $Port)
