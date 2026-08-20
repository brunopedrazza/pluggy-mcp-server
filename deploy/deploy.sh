#!/usr/bin/env bash
# Pull-deploy for the VM: if origin/main moved, rebuild, restart the service and check it came
# back; roll the code back to the previous commit if it didn't. Idempotent — a no-op when already
# at origin/main. Driven by pluggy-mcp-deploy.timer (see deploy/README.md).
#
# Tuning via env (the systemd unit sets MCP_DEPLOY_REPO_DIR):
#   MCP_DEPLOY_REPO_DIR   path to the checked-out repo (default: this script's repo root)
#   MCP_DEPLOY_BRANCH     branch to track (default: main)
set -uo pipefail

BRANCH="${MCP_DEPLOY_BRANCH:-main}"
SERVICE="pluggy-mcp"
ENV_FILE="/etc/pluggy-mcp/env"
HEALTH_RETRIES=30      # 30 * 2s = up to 60s for the service to answer
HEALTH_DELAY=2

# Resolve repo dir: explicit env wins, else derive from this script's location (deploy/..).
if [ -n "${MCP_DEPLOY_REPO_DIR:-}" ]; then
  REPO_DIR="$MCP_DEPLOY_REPO_DIR"
else
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$REPO_DIR" || { echo "repo dir not found: $REPO_DIR" >&2; exit 1; }

# The port is whatever the service is actually configured with, not a second copy of the default.
PORT="$(grep -E '^MCP_BIND_PORT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
PORT="${PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
MCP_URL="http://127.0.0.1:${PORT}/mcp"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Best-effort Telegram ping; silently skipped unless both values are set in the env file.
notify() {
  local msg="$1" token chat
  [ -f "$ENV_FILE" ] || return 0
  token="$(grep -E '^MCP_DEPLOY_TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  chat="$(grep -E '^MCP_DEPLOY_TELEGRAM_CHAT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  curl -fsS -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
    -d chat_id="$chat" --data-urlencode "text=[pluggy-mcp deploy] ${msg}" >/dev/null 2>&1 || true
}

# Install and compile. Dev dependencies come in for tsc and go away again — the running service
# only ever needs the runtime ones.
build() {
  npm ci --silent && npm run build && npm prune --omit=dev --silent
}

# `/health` answers as soon as the port is bound, which proves the process booted but not that it
# can serve MCP: the server is built per request, so a tool schema that throws leaves /health at
# 200 while every real call fails. So the gate is an actual `initialize` handshake.
probe_mcp() {
  local token
  token="$(grep -E '^MCP_BEARER_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
  [ -n "$token" ] || { log "no bearer token readable; skipping MCP probe"; return 0; }
  curl -fsS -m 15 -o /dev/null -X POST "$MCP_URL" \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-probe","version":"0"}}}'
}

# 0 if the service answers both checks within the budget, 1 otherwise.
wait_healthy() {
  local i
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    if curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1; then
      probe_mcp && return 0
      log "port is up but the MCP handshake failed"
      return 1
    fi
    sleep "$HEALTH_DELAY"
  done
  log "service did not answer ${HEALTH_URL} within $((HEALTH_RETRIES * HEALTH_DELAY))s"
  return 1
}

restart_and_wait() {
  systemctl restart "$SERVICE" || { log "systemctl restart failed"; return 1; }
  wait_healthy
}

# Put the previous commit back and rebuild it. The service is left running whatever this produces,
# so failures here are logged but not fatal — there is nothing better to fall back to.
rollback() {
  local prev="$1"
  log "rolling back to ${prev:0:9}"
  git reset --hard --quiet "$prev" || log "rollback reset failed"
  build || log "rollback build failed"
}

# Serialize runs so an overlapping timer fire can't deploy on top of an in-flight one.
exec 9>"/run/pluggy-mcp-deploy.lock"
flock -n 9 || { log "another deploy is in progress; skipping"; exit 0; }

git fetch --quiet origin "$BRANCH" || { log "git fetch failed"; exit 1; }
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/${BRANCH}")"

if [ "$LOCAL" = "$REMOTE" ]; then
  log "up to date at ${LOCAL:0:9}"
  exit 0
fi

PREV="$LOCAL"
log "deploying ${PREV:0:9} -> ${REMOTE:0:9}"
# reset --hard (not pull) so a box that somehow drifted still converges cleanly. Untracked,
# gitignored files are left untouched — the credentials live in /etc anyway.
git reset --hard --quiet "$REMOTE" || { log "git reset failed"; exit 1; }

# Build before restarting: a commit that doesn't compile costs no downtime at all, because the
# running process is still serving the previous build from memory.
if ! build; then
  log "build FAILED at ${REMOTE:0:9}; service untouched and still serving ${PREV:0:9}"
  rollback "$PREV"
  notify "⚠️ build failed at ${REMOTE:0:9}, stayed on ${PREV:0:9} (no downtime)"
  exit 1
fi

if restart_and_wait; then
  log "deploy OK at ${REMOTE:0:9}"
  notify "✅ deployed $(git log -1 --pretty='%h %s')"
else
  log "health check FAILED at ${REMOTE:0:9}"
  rollback "$PREV"
  if restart_and_wait; then
    log "rolled back and healthy at ${PREV:0:9}"
    notify "⚠️ unhealthy at ${REMOTE:0:9}, rolled back to ${PREV:0:9}"
  else
    log "STILL UNHEALTHY after rollback to ${PREV:0:9} — needs a human"
    notify "🔥 unhealthy at ${REMOTE:0:9} AND after rollback to ${PREV:0:9} — needs a human"
  fi
  exit 1
fi
