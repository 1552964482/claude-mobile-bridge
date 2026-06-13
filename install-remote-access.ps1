$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Join-Path $root "tools"
$target = Join-Path $tools "cloudflared.exe"
$url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

New-Item -ItemType Directory -Path $tools -Force | Out-Null

Write-Host "Downloading official Cloudflare Tunnel client..."
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $target

Write-Host ""
& $target --version
Write-Host ""
Write-Host "Installation complete. Double-click start-remote-web.cmd to start remote access."
Read-Host "Press Enter to close"
