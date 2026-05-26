# Deploy de 1 comando. Uso:  .\atualizar.ps1 "mensagem do commit"
param([string]$msg = "update")
$ErrorActionPreference = "Stop"
$src = (Get-ChildItem "$env:APPDATA\Claude\local-agent-mode-sessions" -Recurse -Directory -Filter "bet-analyzer-pro" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
if (-not $src) { Write-Host "Pasta de origem nao encontrada."; exit 1 }
robocopy $src "$HOME\Desktop\bet-analyzer-pro" /E /XD node_modules .git /XF .env atualizar.ps1 | Out-Null
Set-Location "$HOME\Desktop\bet-analyzer-pro"
git add .
git commit -m $msg
git push
Write-Host ""
Write-Host "OK! Codigo enviado pro GitHub. O Render atualiza sozinho em 2-4 min."
