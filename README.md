# pluggy-mcp-server

A **read-only** MCP server that exposes your personal financial data (Brazilian
Open Finance, via [Pluggy](https://pluggy.ai)) to any MCP client — Claude Code,
Cursor, Cline, Zed.

A self-hosted alternative to paid "bank over MCP" services:
[Meu Pluggy](https://meu.pluggy.ai) is **free with no expiration date** for
individuals accessing their own data over the API.

**No money movement.** There is no PIX, no transfer, no payment. Pluggy's
`PaymentsClient` is never imported, and a test fails if anyone imports it.

## Tools

| Tool | What it does |
|---|---|
| `list_connections` | Connections, status, and data freshness per product |
| `list_accounts` | Checking, savings and credit card accounts, with balances |
| `list_transactions` | Statement as TSV: posting date, purchase date, installment, and the bill each row landed on |
| `search_transactions` | Search by text, amount range and category, across accounts |
| `list_credit_card_bills` | Bills: due date, closing date, total, payments, finance charges |
| `list_investments` | Current portfolio positions |
| `list_investment_transactions` | Contributions and withdrawals, to compute returns |
| `list_loans` | Loans and financing: outstanding balance, rates, installments |
| `refresh_connection` | Triggers a Pluggy sync (non-blocking) |

Amounts are normalised so **negative always means money leaving the account**, on
bank accounts and credit cards alike. Pluggy's raw data disagrees between the two,
which makes card spending cancel bank spending if summed naively. They are also
always in the account's own currency: Pluggy reports a foreign purchase in the
merchant's currency, so the converted value is used and the original is kept in
`valor_orig` for reconciliation.

On a credit card, `date` is the **posting** date, not the purchase date — an
instalment of a year-old purchase posts this month. `data_compra` carries the
original date where the two differ, and `fatura` says which bill the row landed
on, so `list_transactions({ bill })` returns the line items behind a bill total.

## Prompts

Saved analyses, so the same question is asked the same way each month.

| Prompt | What it does |
|---|---|
| `analise_mensal` | A month end to end: in, out, categories, and the change against the month before |
| `fatura_cartao` | One bill: reconciled against the bank's total, new purchases split from instalments of old ones |
| `revisao_assinaturas` | Recurring charges, including the forgotten ones and the ones that went up |
| `saude_financeira` | Net worth, debt, credit usage and savings rate |

## Setup

### 1. Connect your banks (once, ~15 min)

1. Create an account at [meu.pluggy.ai](https://meu.pluggy.ai) and connect your banks
2. Create an account at [dashboard.pluggy.ai](https://dashboard.pluggy.ai). This starts a
   15-day trial, which you can ignore: Pluggy states you can still pull your data after
   it expires
3. **Before creating the application**, go to *Customize* and add the **MeuPluggy**
   connector to your connector list. Skip this and it will not show up later
4. Create a *Development Application* and copy its `Client ID` and `Client Secret`
5. Open the *Demo* application and link your Meu Pluggy account through the MeuPluggy
   OAuth authorization. **Repeat this once per connected bank** — Pluggy issues one item
   per bank, not per account
6. Copy the **Item ID** of each connection ("Copiar Item ID")

Connection names are derived from the account names Pluggy reports, so a new bank
needs no configuration. When an item names no institution anywhere — some report every
account as `Conta Corrente` — name it yourself with
`PLUGGY_ITEM_LABELS=<item id>=Banco X`, comma-separated for more than one.

Connector 200 acts as a proxy over the connections Meu Pluggy owns, and refreshes them
daily. Because Meu Pluggy owns them, **Pluggy refuses to sync them through the API** —
`refresh_connection` answers `400 MeuPluggy item cant be updated` and says where to go
instead. Forcing an update means reconnecting the bank at meu.pluggy.ai, and a window
missing from your history only comes back if the bank still exposes it over Open Finance.

### 2. Check what Connector 200 actually returns

```bash
npm install
npm run setup   # prompts for the credentials, writes .env with mode 0600
npm run probe
```

`npm run setup` masks the client secret while you type it, generates the MCP bearer
token for you, and verifies the credentials against the Pluggy API before writing
anything. Re-running it keeps your current values — press Enter to skip a prompt.

The probe reports whether investments, credit card bills and loans are available
on your connections, and validates date and category handling. It does **not**
print account numbers, tax IDs, or transaction descriptions.

### 3. Run

```bash
npm run dev            # development, reads .env directly
npm run build && npm start   # production
```

Check it is alive with `curl localhost:8787/health`.

## Deployment (VM + Tailscale)

The process listens **on loopback only**. Exposure is handled by Tailscale, never
by binding to `0.0.0.0` — cloud VMs have public IPs, and a wrong bind combined
with an open security list puts your bank statement on the internet.

The VM needs Node 22.6+ and Tailscale already up (`tailscale up`). The unit file
runs `/usr/bin/node`, which is where a distro or NodeSource package lands; if you
installed Node through nvm, point `ExecStart` at the real binary instead.

### 1. Service account and code

The service never writes to disk — the cache is in memory, and the unit sets
`ProtectSystem=strict` with an empty `ReadWritePaths`. So the code is owned by
root and the service user only reads it: a compromised process cannot rewrite its
own source.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin pluggy-mcp

sudo git clone https://github.com/brunopedrazza/pluggy-mcp-server /opt/pluggy-mcp
cd /opt/pluggy-mcp
sudo npm ci                  # dev dependencies included: tsc is needed to build
sudo npm run build
sudo npm prune --omit=dev    # and dropped again; free-tier VMs are small
```

### 2. Credentials

Run the setup on the VM rather than copying a `.env` over scp. It verifies the
credentials against the Pluggy API before writing anything, which also proves the
VM has outbound connectivity — worth knowing before systemd is in the picture.

```bash
sudo npm run setup

sudo install -d -m 700 /etc/pluggy-mcp
sudo install -m 600 .env /etc/pluggy-mcp/env
sudo rm /opt/pluggy-mcp/.env   # one copy of the secret, not two
```

### 3. Service

```bash
sudo cp deploy/pluggy-mcp.service /etc/systemd/system/
sudo systemctl enable --now pluggy-mcp
```

Confirm it reached Pluggy, not just that the port answers:

```bash
curl localhost:8787/health
journalctl -u pluggy-mcp -n 20
```

The journal should end in `transaction cache warmed`. If instead it says
`cache warm failed` with a name resolution error, the cause is
`RestrictAddressFamilies` in the unit: where glibc resolves through
`systemd-resolved`, `getaddrinfo` needs a unix socket. Add `AF_UNIX` to that line
and restart.

### 4. Publish on the tailnet

Check what the node already publishes before claiming a port — `serve` replaces
a handler on the same port and path without warning, and taking `/` on 443 from
a service already there is a silent outage:

```bash
sudo tailscale serve status   # empty output means 443 is free
```

If 443 is free, use it. If something already holds it, mount on another HTTPS
port instead of sharing the path:

```bash
sudo tailscale serve --bg --https=8443 127.0.0.1:8787
sudo tailscale serve status   # prints the https://…ts.net URL used below
```

This requires HTTPS enabled for the tailnet (admin console > DNS). The
certificate is real and issued automatically, so the bearer token never travels
in the clear. Serve config survives reboots, so this is a one-time command.

### Connect a client

```bash
claude mcp add --transport http pluggy https://YOUR-VM.YOUR-TAILNET.ts.net/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

The URL has to come before `--header`. That flag is variadic, so anything after it
is parsed as another header and the URL never reaches the positional argument.

Locally, against `npm run dev`:

```bash
claude mcp add --transport http pluggy http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer $(grep '^MCP_BEARER_TOKEN=' .env | cut -d= -f2-)"
```

> This does not work in Claude web or the mobile app: claude.ai custom connectors
> are dialed by Anthropic's infrastructure, which cannot reach a private tailnet.
> Clients that connect from the machine they run on work normally.

### Updating

```bash
cd /opt/pluggy-mcp
sudo git pull && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo systemctl restart pluggy-mcp
```

Rotating the bearer token is the same restart: edit `/etc/pluggy-mcp/env`,
restart the service, and update the header on every client.

Or let the box do it: a systemd timer can track `origin/main`, rebuild when it
moves, and roll back if the new commit doesn't come back healthy. Two files to
copy — see [deploy/README.md](./deploy/README.md).

## Design

Every decision and its reasoning is in [DESIGN.md](./DESIGN.md).

## License

MIT
