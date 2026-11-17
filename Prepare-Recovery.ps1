param([string]$InstallPath = '')
$ErrorActionPreference = 'Stop'
try {
  if (Get-Process -Name BuyerLog -ErrorAction SilentlyContinue) { throw 'Once tum Buyer Log pencerelerini kapatin / Close all Buyer Log windows first.' }
  if ([string]::IsNullOrWhiteSpace($InstallPath)) { $InstallPath = Read-Host 'BuyerLog.exe klasoru / Installation folder' }
  $root = (Resolve-Path -LiteralPath $InstallPath.Trim().Trim('"')).ProviderPath
  $exe = Join-Path $root 'BuyerLog.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'BuyerLog.exe bulunamadi / not found.' }
  $answer = Read-Host '7.0.360 imzali yamayi hazirla? E veya Y / Prepare signed patch? Y'
  if ($answer -notmatch '^(E|Y)$') { Write-Host 'Iptal / Cancelled'; exit 0 }
  $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $exe (Join-Path $PSScriptRoot 'prepare-recovery.cjs') $root | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Yama hazirlanamadi; yukaridaki hatayi kontrol edin / Patch staging failed; see error above.' }
  } finally { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
