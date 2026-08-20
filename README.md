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
| `list_transactions` | Statement as TSV, including installment and full purchase amount |
| `search_transactions` | Search by text, amount range and category, across accounts |
| `list_credit_card_bills` | Bills: due date, closing date, total, payments |
| `list_investments` | Current portfolio positions |
| `list_investment_transactions` | Contributions and withdrawals, to compute returns |
| `list_loans` | Loans and financing: outstanding balance, rates, installments |
| `refresh_connection` | Triggers a Pluggy sync (non-blocking) |

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

Connector 200 acts as a proxy over the connections Meu Pluggy owns, and refreshes them
daily.

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
npm run build
npm start
```

## Deployment (VM + Tailscale)

The process listens **on loopback only**. Exposure is handled by Tailscale, never
by binding to `0.0.0.0` — cloud VMs have public IPs, and a wrong bind combined
with an open security list puts your bank statement on the internet.

```bash
sudo cp deploy/pluggy-mcp.service /etc/systemd/system/
sudo install -d -m 700 /etc/pluggy-mcp
sudo install -m 600 .env /etc/pluggy-mcp/env
sudo systemctl enable --now pluggy-mcp

tailscale serve --bg --https=443 127.0.0.1:8787
```

### Connect a client

```bash
claude mcp add pluggy --transport http \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN" \
  https://YOUR-VM.YOUR-TAILNET.ts.net/mcp
```

> This does not work in Claude web or the mobile app: claude.ai custom connectors
> are dialed by Anthropic's infrastructure, which cannot reach a private tailnet.
> Clients that connect from the machine they run on work normally.

## Design

Every decision and its reasoning is in [DESIGN.md](./DESIGN.md).

## License

MIT
