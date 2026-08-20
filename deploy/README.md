# Continuous deploy on the VM (pull-based)

The VM keeps itself in sync with `origin/main`: a systemd timer runs [`deploy.sh`](./deploy.sh)
every few minutes; when `main` has moved it rebuilds, restarts the service, checks it came back,
and **rolls the code back to the previous commit** if it didn't. No inbound access and no CI
secrets — the VM pulls, nothing pushes to it.

## What `deploy.sh` does each run

1. `git fetch` — if `HEAD == origin/main`, exit (no-op, no rebuild).
2. `git reset --hard origin/main`.
3. `npm ci && npm run build && npm prune --omit=dev`.
4. `systemctl restart pluggy-mcp`.
5. Poll `/health` for up to 60s, then send a real MCP `initialize` handshake.
6. Healthy → notify. Unhealthy → reset to the previous commit, rebuild, restart, notify, exit
   non-zero.

A `flock` guards against overlapping runs. Telegram pings are best-effort and silently skipped
unless `MCP_DEPLOY_TELEGRAM_BOT_TOKEN` / `MCP_DEPLOY_TELEGRAM_CHAT_ID` are set in
`/etc/pluggy-mcp/env`.

**The build happens before the restart**, so a commit that doesn't compile costs zero downtime:
the running process is still serving the previous build out of memory, and it is never signalled.
Only a commit that compiles but doesn't come back healthy causes an interruption.

**`/health` is not the gate on its own.** It answers as soon as the port is bound, which proves the
process booted and nothing more — the MCP server is constructed per request, so a tool schema that
throws would leave `/health` at 200 while every real call fails. Step 5 therefore performs an
authenticated `initialize` and treats a non-2xx as a failed deploy.

## Install (one-time, on the VM)

Assumes the layout from the main README: repo at `/opt/pluggy-mcp`, env at `/etc/pluggy-mcp/env`,
`pluggy-mcp.service` already running.

```bash
sudo cp /opt/pluggy-mcp/deploy/pluggy-mcp-deploy.service /etc/systemd/system/
sudo cp /opt/pluggy-mcp/deploy/pluggy-mcp-deploy.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pluggy-mcp-deploy.timer
```

## Operate

```bash
systemctl list-timers pluggy-mcp-deploy.timer          # when it next fires
systemctl status pluggy-mcp-deploy.service             # last run result
journalctl -u pluggy-mcp-deploy.service -f             # live deploy logs
sudo systemctl start pluggy-mcp-deploy.service         # force a deploy now
sudo systemctl disable --now pluggy-mcp-deploy.timer   # pause auto-deploy
```

Tune the cadence in the `.timer` (`OnUnitActiveSec`); after editing either unit file run
`sudo systemctl daemon-reload`. Changes to `deploy.sh` itself ship via the normal deploy — it runs
from the repo checkout — but **unit-file** changes have to be re-copied to `/etc/systemd/system/`.

## Caveats

- **Root, by construction.** The deploy runs as root: the checkout is root-owned precisely so the
  service account cannot rewrite its own code, and restarting the unit needs privilege. The trade
  is the one every pull-deploy makes — whoever can push to `main` can run code as root on this box.
  For a public repo, that is your GitHub account and anything holding a token for it.
- **A restart is not free.** The cache is in memory, so every deploy re-sweeps 24 months of
  statements across every connection on boot. Deploys are per-commit rather than per-tick, so the
  5-minute timer costs nothing on its own, but a burst of commits means a burst of full sweeps.
- **Rollback reverts code, not credentials.** If a deploy fails because `/etc/pluggy-mcp/env` is
  wrong — an expired client secret, a revoked item — rolling back the code changes nothing and the
  service stays down. The `🔥` notification exists for exactly that case.
- **Every commit on main lands automatically.** The health check is the only gate. If you want a
  human one, track tags instead of `origin/main` (`MCP_DEPLOY_BRANCH` picks the ref).
