# Cockpit installer for Windows: irm https://getcockpit.github.io/install.ps1 | iex
# Installs the latest Cockpit for the current user (%LOCALAPPDATA%\Cockpit) with the silent setup .exe, then starts it.
# Files fetched with Invoke-WebRequest carry no Mark of the Web, so SmartScreen doesn't ask.
# COCKPIT_NO_OPEN=1 skips launching it.
# Runs inside a script block so a failure never closes the caller's PowerShell window (iex would run `exit` in it).
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Windows PowerShell 5.1 downloads many times slower with the progress bar on
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $repo = 'getcockpit/cockpit'
  function Say($m) { Write-Host "> $m" -ForegroundColor Yellow }

  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Say "Claude Code isn't installed yet: irm https://claude.ai/install.ps1 | iex (then run 'claude' once to sign in)"
  }

  # The fixed-name copy on every release (no API call, so no rate limit); the API is the fallback.
  $url = "https://github.com/$repo/releases/latest/download/Cockpit-windows-x64-setup.exe"
  try { Invoke-WebRequest $url -Method Head -UseBasicParsing | Out-Null }
  catch {
    $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
    $url = ($rel.assets | Where-Object { $_.name -like '*_x64-setup.exe' } | Select-Object -First 1).browser_download_url
    if (-not $url) { throw 'No Windows build in the latest release' }
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("cockpit-" + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    $setup = Join-Path $tmp 'Cockpit-setup.exe'
    Say "Downloading $(Split-Path $url -Leaf)"
    Invoke-WebRequest $url -OutFile $setup -UseBasicParsing
    Get-Process Cockpit -ErrorAction SilentlyContinue | ForEach-Object { Say 'Closing the running Cockpit'; $_ | Stop-Process -Force }
    Say 'Installing'
    $p = Start-Process $setup -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "The installer failed with exit code $($p.ExitCode)" }
  } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

  $app = Get-ChildItem "$env:LOCALAPPDATA\Cockpit" -Recurse -Filter Cockpit.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $app) { throw "Cockpit.exe wasn't found under $env:LOCALAPPDATA\Cockpit after installing" }
  Say "Installed $($app.FullName)"
  if (-not $env:COCKPIT_NO_OPEN) { Start-Process $app.FullName }
}
