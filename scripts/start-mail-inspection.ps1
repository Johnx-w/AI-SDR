param(
  [string]$DataDir = '.data/mail-review-local',
  [int]$Port = 14324
)

$ErrorActionPreference = 'Stop'
$snapshot = (Resolve-Path -LiteralPath $DataDir).Path
$credentialFile = Join-Path $snapshot 'deepseek.dpapi'
$previousKey = $env:DEEPSEEK_API_KEY
try {
  if (!$previousKey -and (Test-Path -LiteralPath $credentialFile)) {
    $protectedKey = (Get-Content -LiteralPath $credentialFile -Raw).Trim()
    $secureKey = ConvertTo-SecureString -String $protectedKey
    $env:DEEPSEEK_API_KEY = [Net.NetworkCredential]::new('', $secureKey).Password
  }
  & node (Join-Path $PSScriptRoot 'start-mail-inspection.mjs') --data-dir $snapshot --port $Port
  exit $LASTEXITCODE
} finally {
  $env:DEEPSEEK_API_KEY = $previousKey
  if ($secureKey) { $secureKey.Dispose() }
}
