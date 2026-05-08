#requires -version 5
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "  Limpiando procesos previos..."
Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Get-Process -Name cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item cloudflared.log -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if (-not (Test-Path 'cloudflared.exe')) {
    Write-Host ""
    Write-Host "  ERROR: cloudflared.exe no esta en esta carpeta." -ForegroundColor Red
    Write-Host "  Bajalo de:"
    Write-Host "    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    Write-Host ""
    Read-Host "ENTER para salir"
    exit 1
}

Write-Host "  Verificando dependencias de Python..."
$null = python -c "import fastapi, uvicorn, faster_whisper, multipart, dotenv, groq, bcrypt" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Instalando dependencias por primera vez (puede tardar)..." -ForegroundColor Yellow
    python -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR instalando dependencias." -ForegroundColor Red
        Read-Host "ENTER para salir"
        exit 1
    }
}

Write-Host "  Lanzando API en ventana minimizada..."
Start-Process -FilePath 'python' `
    -ArgumentList '-m','uvicorn','api:app','--host','127.0.0.1','--port','8000','--proxy-headers' `
    -WindowStyle Minimized

Write-Host -NoNewline "  Esperando API en :8000 ..."
$apiOk = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    Write-Host -NoNewline "."
    if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) {
        $apiOk = $true
        break
    }
}
if (-not $apiOk) {
    Write-Host ""
    Write-Host "  ERROR: el API no respondio en 60 segundos." -ForegroundColor Red
    Write-Host "  Revise la ventana minimizada 'python.exe' por el error de uvicorn."
    Read-Host "ENTER para salir"
    exit 1
}
Write-Host " listo"

Write-Host "  Lanzando tunel publico Cloudflare..."
Start-Process -FilePath '.\cloudflared.exe' `
    -ArgumentList 'tunnel','--url','http://localhost:8000','--protocol','http2','--logfile','cloudflared.log' `
    -WindowStyle Minimized

Write-Host -NoNewline "  Esperando URL del tunel (hasta 90s) ..."
$url = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 3
    Write-Host -NoNewline "."
    if (Test-Path cloudflared.log) {
        $m = Select-String -Path cloudflared.log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) {
            $url = $m.Matches[0].Value
            break
        }
        $logTxt = Get-Content cloudflared.log -Raw -ErrorAction SilentlyContinue
        if ($logTxt -match 'failed to request quick Tunnel') { break }
    }
}
if ($url) { Write-Host " listo" } else { Write-Host " sin respuesta" }

if ($url) {
    Write-Host -NoNewline "  Verificando alcance del tunel ..."
    $reachable = $false
    for ($i = 0; $i -lt 8; $i++) {
        Start-Sleep -Seconds 2
        Write-Host -NoNewline "."
        try {
            $r = Invoke-WebRequest -Uri "$url/api/extract/status" -UseBasicParsing -TimeoutSec 10
            if ($r.StatusCode -eq 200) { $reachable = $true; break }
        } catch { }
    }
    Write-Host (" " + $(if ($reachable) { "OK" } else { "tardando (puede tomar 30-60s mas)" }))
}

Clear-Host
Write-Host ""
Write-Host ("=" * 64) -ForegroundColor Blue
Write-Host "                BACCITA - Servicios listos" -ForegroundColor Blue
Write-Host ("=" * 64) -ForegroundColor Blue
Write-Host ""
if ($url) {
    Write-Host "  ACCESO PUBLICO (cualquier dispositivo con internet):" -ForegroundColor Green
    Write-Host ""
    Write-Host "    Cliente         $url/" -ForegroundColor Cyan
    Write-Host "    Trabajador      $url/worker/" -ForegroundColor Cyan
    Write-Host "    Administrador   $url/admin/" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Si el navegador dice 'no se puede acceder', espere 30-60s"
    Write-Host "  y refresque (propagacion DNS de Cloudflare)."
} else {
    Write-Host "  EL TUNEL PUBLICO NO ARRANCO. Use solo desde laptop:" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  ACCESO LOCAL (esta laptop):"
Write-Host ""
Write-Host "    Cliente         http://localhost:8000/" -ForegroundColor Cyan
Write-Host "    Trabajador      http://localhost:8000/worker/" -ForegroundColor Cyan
Write-Host "    Administrador   http://localhost:8000/admin/" -ForegroundColor Cyan
Write-Host ""
Write-Host "  CREDENCIALES POR DEFECTO:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    Admin           admin / admin1234"
Write-Host "    Trabajador      ana / 3333"
Write-Host "                    (jubelkys/1111, adriana/2222, eddy/4444,"
Write-Host "                     stefany/5555, badner/9999)"
Write-Host "    Cliente         cliente9 / demo1234"
Write-Host ""
Write-Host ("=" * 64) -ForegroundColor Blue
Write-Host "  No cierre las ventanas minimizadas. Para detener: stop.bat" -ForegroundColor Gray
Write-Host ("=" * 64) -ForegroundColor Blue
Write-Host ""
Read-Host "ENTER para cerrar esta ventana (los servicios siguen vivos)"
