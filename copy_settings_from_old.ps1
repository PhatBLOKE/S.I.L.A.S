# SILAS v2.3: copy your settings (API keys, calendar link, LAN token, alert log, AI usage,
# drive undo history) from the SILAS you ran before into this folder. Nothing is deleted.
# Runs once: after that, v2.3 keeps its own settings.
$here = Join-Path $PSScriptRoot 'backend\data'
$marker = Join-Path $here '.settings_copied'
if (Test-Path $marker) { Write-Host 'Settings already brought across earlier - starting v2.3.'; exit 0 }

$candidates = @(
    (Join-Path $PSScriptRoot '..\..\havoc-v2.2\jarvis-pa\backend\data'),
    (Join-Path $env:USERPROFILE '.gemini\antigravity\scratch\jarvis-pa\backend\data')
) | Where-Object { Test-Path (Join-Path $_ 'config.json') }

if (-not $candidates) {
    Write-Host '[!] No old SILAS settings found - v2.3 will start with a fresh config.'
    exit 0
}
# If both exist, use whichever was saved most recently (the one you've actually been running).
$src = $candidates | Sort-Object { (Get-Item (Join-Path $_ 'config.json')).LastWriteTime } -Descending |
    Select-Object -First 1
$src = (Resolve-Path $src).Path
Write-Host "Copying your settings from: $src"
Get-ChildItem -Path $src -File | Where-Object { $_.Name -ne 'config.example.json' } | ForEach-Object {
    Copy-Item $_.FullName -Destination $here -Force
    Write-Host "  - $($_.Name)"
}
Set-Content -Path $marker -Value "copied from $src on $(Get-Date)"
