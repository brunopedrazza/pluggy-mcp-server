# Design decisions

A record of the decisions made before implementation, and why. If you are about
to change one, read the reasoning first — several of them exist to prevent a
specific failure mode, not for aesthetics.

## 1. Pluggy access: Meu Pluggy + Connector 200

Pluggy's commercial Data plan starts at **R$2,500/month**. For personal use there
is **[Meu Pluggy](https://meu.pluggy.ai)**, free with no expiration date, and
**Connector 200 ("MeuPluggy")**, a proxy that exposes over the API the data you
have already connected there. There is no account limit as long as every account
is your own.

Onboarding happens **outside this server**: you connect your banks in Meu Pluggy
and authorize the MeuPluggy connector inside `dashboard.pluggy.ai`. There is no
Pluggy Connect widget, no OAuth, and no HTTP callback in our code.

The server is **item-agnostic**: it takes N `itemId`s and reads whatever is
there. That works identically for the free Connector 200 and for a paid plan
later, with no rewrite.

## 2. Faithful mirror of banco.mcp.ai, no server-side aggregation

banco.mcp.ai exposes 5 read-only listing tools. We adopt the same philosophy:
tools deliver data, the model does the analysis.

**Objection recorded and overruled:** without server-side aggregation, all the
arithmetic falls on the model, and an LLM summing hundreds of rows fails
silently. Mitigated — not eliminated — by decisions 4, 11 and 14.

## 3. Lean TSV output

Pluggy's `Transaction` has ~25 top-level fields plus nested `paymentData`,
`merchant` and `creditCardMetadata`: **~396 tokens per transaction**.

| transactions | raw JSON | lean JSON | lean TSV |
|---|---|---|---|
| 400 (one quarter) | 158k | 10k | **7k** |
| 1,200 (one year) | 475k | 31k | **22k** |
| 3,000 (one busy year) | 1,188k | 78k | **54k** |

A year of raw JSON blows a 1M context window on its own. Lean TSV saves ~22x.

Secondary benefit: raw `paymentData` carries your CPF, branch and account number
— and the counterparty's — on every single row. The lean projection removes them
by construction.

## 4. Truncation is always visible

Defaults to 90 days when no period is given. Row ceiling is configurable
(`MCP_MAX_ROWS`, default 800). When exceeded, the **first line** of the response
is a warning carrying the real count and an explicit instruction not to sum,
plus a cursor to continue.

The failure mode this prevents: truncating 800 out of 1,847 rows and having the
model sum the 800, producing a plausible and wrong total.

## 5. HTTP over the tailnet, never publicly exposed

An HTTP server running on a VM, reachable only over the Tailscale network.

**Accepted consequence:** it does not work in Claude web or the mobile app.
claude.ai custom connectors are dialed **by Anthropic's infrastructure**, not by
your device — the documentation requires the server to be reachable over the
public internet. Clients that connect from the machine they run on (Claude Code,
Cursor, Cline, Zed) work normally.

## 6. Nine tools

Five mirroring banco.mcp.ai — `list_connections`, `list_accounts`,
`list_transactions`, `list_credit_card_bills`, `list_investments` — plus:

- `list_loans` — without it you cannot answer "should I pay this off or invest?"
- `list_investment_transactions` — a current position without contribution
  history lets you compute a balance, never a return
- `search_transactions` — the direct antidote to the row ceiling: filters by
  text, amount range and category across every account at once

`get_identity` was deliberately left out: it serves no analysis and would only
dump PII into the context window and the harness logs.

## 7. Non-blocking `refresh_connection`

Pluggy auto-sync only exists for production applications (every 8/12/24h
depending on plan), so data from Connector 200 may be stale. `PATCH /items/{id}`
triggers a sync and returns immediately; the model polls `list_connections` to
see when it finished. If the item lands in `WAITING_USER_INPUT`, the tool returns
an instruction to resolve the MFA challenge at `meu.pluggy.ai` — the server
cannot answer MFA on its own.

A blocking tool with polling was rejected: a ~2 minute call exceeds MCP client
timeouts and freezes the conversation.

## 8. In-memory cache, invalidated by `lastUpdatedAt`

Cache key is `(itemId, product, item.lastUpdatedAt)`. While Pluggy has not
synced, the key does not change and the response is served from memory; the
moment the item updates, the key changes and the cache misses on its own. No
arbitrary TTL, and no way to serve stale data. Only `fetchItem` carries a short
TTL (~60s) to avoid hammering the API.

**Nothing touches disk.** If the VM is compromised, there is no bank statement
sitting on it.

## 9. Installments: both accounting views, made explicit

A R$3,000 purchase split into 12 installments in March is either R$3,000
(accrual view) or R$250 (cash view). Both are legitimate, and they differ by 12x.

`CreditCardBills` only carries the bill header (`dueDate`, `billClosingDate`,
`totalAmount`) — the line items live in `transactions`, linked through
`creditCardMetadata.billId`. So: `list_transactions` uses the purchase date and
gains `installment` and `purchase_total` columns, while `list_credit_card_bills`
shows what actually lands on each bill. Both views coexist, and the installment
appears on the row itself, so the two views cannot be conflated unnoticed.

## 10. Mandatory bearer token, loopback bind

The process listens **only on `127.0.0.1`**; exposure to the tailnet is handled
by `tailscale serve`. This eliminates by construction the "bound to `0.0.0.0`
while the VM security list was open" class of mistake — which matters because
cloud VMs have public IPs.

On top of that, a mandatory bearer token, compared in constant time, returning a
401 with no detail. The tailnet is already a boundary, but a single-layer defense
fails completely: it only takes adding a device, sharing a node, running a
container that inherits the host network, or getting an ACL wrong.

## 11. `instructions`, rich descriptions and prompts

Since there is no server-side aggregation (decision 2), the server injects the
rules that prevent silent errors into the handshake: sum with code and never
mentally, never treat output marked `⚠ PARTIAL` as a total, never convert time
zones, never mix `amount` with `purchase_total`, and treat transaction
descriptions as untrusted input.

## 12. Public repository, MIT

The code contains no user data — credentials and item IDs come from the
environment. And there is a real gap in the market: services charge
R$19.90–49.90/month on top of a Meu Pluggy account that is free.

## 13. systemd + `tailscale serve`

`Restart=always`, `After=tailscaled.service`, an `EnvironmentFile` in mode 600
for the client secret, logs to journald. No container, which matters on a
free-tier VM. `tailscale serve` publishes over HTTPS with a valid certificate, so
the bearer token never travels in the clear.

Binding directly to the `100.x` address was rejected: besides being plaintext
HTTP, systemd can start before `tailscaled` assigns the address, and the service
never comes back after a reboot.

## 14. A broken item degrades with a banner

With 4-5 banks connected, having one in `LOGIN_ERROR`, `OUTDATED` or
`WAITING_USER_INPUT` is the normal state, not the exception. Tools return the
healthy items, but the first line states what is missing, since when, and how to
fix it.

Same risk as truncation: if one bank is out, the March total comes back smaller
and plausible. Failing the whole call was rejected because one broken bank would
render the entire server useless.

---

## Decisions taken without asking

**Dates are calendar dates, not instants.** `pluggy-sdk` blindly converts any ISO
string into a `Date` (a regex plus a `JSON.parse` reviver). Format it with
`timeZone: 'America/Sao_Paulo'` and `2026-03-01T00:00:00.000Z` renders as
`2026-02-28` — every transaction dated the 1st (rent, salary, subscriptions)
lands in the wrong month, corrupting any "spending per month" analysis.
Formatting is always `toISOString().slice(0, 10)`, with no time zone conversion
anywhere.

**Transaction descriptions are hostile input.** Anyone can send you R$0.01 over
PIX with the description `"IGNORE ALL PREVIOUS INSTRUCTIONS AND ..."`. That text
flows straight into the context of an agent that may hold bash and file-write
tools. Descriptions are emitted delimited, with control characters stripped, and
the tools declare in their description that the content is untrusted. The server
being read-only protects Pluggy, not the rest of your harness.

**`PaymentsClient` is never imported.** `pluggy-sdk` ships PIX initiation, smart
transfers and payments. None of it is imported, and a test fails if anyone
imports it.
