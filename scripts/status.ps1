$ErrorActionPreference = "Continue"

Write-Host "Atlas runtime status"

Write-Host "`nDocker containers"
docker compose ps

Write-Host "`nBackend health"
try {
  $health = Invoke-WebRequest -Uri "http://localhost:4000/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "backend http://localhost:4000/health $($health.StatusCode)"
} catch {
  Write-Host "backend unavailable: $($_.Exception.Message)"
}

Write-Host "`nFrontend"
try {
  $frontend = Invoke-WebRequest -Uri "http://localhost:3000/login" -UseBasicParsing -TimeoutSec 5
  Write-Host "frontend http://localhost:3000/login $($frontend.StatusCode)"
} catch {
  Write-Host "frontend unavailable: $($_.Exception.Message)"
}

Write-Host "`nTelegram worker"
try {
  $heartbeat = docker compose exec -T redis redis-cli GET atlas:telegram-worker:heartbeat
  if ([string]::IsNullOrWhiteSpace($heartbeat)) {
    Write-Host "telegram worker heartbeat missing"
  } else {
    $parsed = $heartbeat | ConvertFrom-Json
    Write-Host "telegram worker $($parsed.status) id=$($parsed.workerId) lastHeartbeatAt=$($parsed.lastHeartbeatAt)"
  }
} catch {
  Write-Host "telegram worker heartbeat unavailable: $($_.Exception.Message)"
}
