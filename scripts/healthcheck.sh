#!/usr/bin/env bash
# Portable Atlas healthcheck for local/dev/VPS use.
# Exits 0 only when required checks pass. Prints no secrets.
set -Eeuo pipefail

BACKEND_URL="${ATLAS_BACKEND_URL:-http://127.0.0.1:4000}"
FRONTEND_URL="${ATLAS_FRONTEND_URL:-http://127.0.0.1:3200}"
FRONTEND_PATH="${ATLAS_FRONTEND_PATH:-/login}"
REDIS_URL="${ATLAS_REDIS_URL:-${REDIS_URL:-redis://127.0.0.1:6379}}"
HEARTBEAT_KEY="${ATLAS_WORKER_HEARTBEAT_KEY:-atlas:telegram-worker:heartbeat}"
TIMEOUT_SECONDS="${ATLAS_HEALTH_TIMEOUT_SECONDS:-5}"
CHECK_WS="${ATLAS_CHECK_WS:-1}"
CHECK_REDIS="${ATLAS_CHECK_REDIS:-1}"
CHECK_WORKER="${ATLAS_CHECK_WORKER:-1}"

failures=0

log() {
  printf '%s\n' "$*"
}

fail() {
  log "FAIL: $*"
  failures=$((failures + 1))
}

ok() {
  log "OK: $*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "missing command: $1"
    return 1
  fi
  return 0
}

http_code() {
  local url=$1
  curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT_SECONDS" "$url" || true
}

require_cmd curl || true

# Backend /health
backend_health="${BACKEND_URL%/}/health"
code="$(http_code "$backend_health")"
if [[ "$code" == "200" ]]; then
  ok "backend health ($backend_health) -> $code"
else
  fail "backend health ($backend_health) -> ${code:-unreachable}"
fi

# Frontend
frontend_target="${FRONTEND_URL%/}${FRONTEND_PATH}"
code="$(http_code "$frontend_target")"
if [[ "$code" =~ ^(200|301|302|307|308)$ ]]; then
  ok "frontend ($frontend_target) -> $code"
else
  fail "frontend ($frontend_target) -> ${code:-unreachable}"
fi

# WebSocket endpoint availability (HTTP upgrade handshake may return 400 without token; connection refused is failure)
if [[ "$CHECK_WS" == "1" ]]; then
  ws_probe_url="${BACKEND_URL%/}/ws"
  ws_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT_SECONDS" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$ws_probe_url" || true)"
  if [[ -z "$ws_code" || "$ws_code" == "000" ]]; then
    fail "websocket endpoint unreachable ($ws_probe_url)"
  else
    ok "websocket endpoint reachable ($ws_probe_url) -> HTTP $ws_code"
  fi
fi

# Redis + worker heartbeat
if [[ "$CHECK_REDIS" == "1" || "$CHECK_WORKER" == "1" ]]; then
  if command -v redis-cli >/dev/null 2>&1; then
    if [[ "$CHECK_REDIS" == "1" ]]; then
      if redis-cli -u "$REDIS_URL" --no-auth-warning ping 2>/dev/null | grep -qi pong; then
        ok "redis ping"
      else
        fail "redis ping failed"
      fi
    fi

    if [[ "$CHECK_WORKER" == "1" ]]; then
      heartbeat="$(redis-cli -u "$REDIS_URL" --no-auth-warning GET "$HEARTBEAT_KEY" 2>/dev/null || true)"
      if [[ -n "${heartbeat:-}" ]]; then
        ok "telegram worker heartbeat present"
      else
        fail "telegram worker heartbeat missing (key=$HEARTBEAT_KEY)"
      fi
    fi
  else
    if [[ "$CHECK_REDIS" == "1" || "$CHECK_WORKER" == "1" ]]; then
      log "SKIP: redis-cli not installed; set CHECK_REDIS=0 CHECK_WORKER=0 to silence"
      if [[ "${ATLAS_REQUIRE_REDIS_CLI:-0}" == "1" ]]; then
        fail "redis-cli required but not installed"
      fi
    fi
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  log "Healthcheck failed ($failures check(s))"
  exit 1
fi

log "Healthcheck passed"
exit 0
