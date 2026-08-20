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

Pluggy issues **one item per bank**, not per account, so anyone with more than
one connected institution has several. The server is therefore **item-agnostic**:
it takes N `itemId`s and reads whatever is there. That works identically for the
free Connector 200 and for a paid plan later, with no rewrite.

Item IDs have to be configured explicitly, and that is not a shortcut. Pluggy has
no endpoint that lists an application's connections, by design: *"For security
reasons, Pluggy does not provide a method to list all existing connections.
Customers are responsible for tracking and maintaining their own references to
Pluggy item IDs."* There is nothing to auto-discover, so `list_connections`
resolves the configured IDs through `fetchItem` rather than enumerating anything.

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

Connector 200 refreshes its connections **daily**, so data is never more than
about a day old — but "yesterday" is not good enough for "how much did I spend
today". `PATCH /items/{id}`
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

Pluggy's `Transaction.date` on a card is the **posting** date, so the raw stream
is already the cash view: an installment of a year-old purchase carries this
month's date, and connectors post the whole installment batch on one day near
the closing date. Sorting and filtering therefore run on the posting date, which
is the only date every row has.

The purchase view is grafted on rather than substituted, through three columns:

- `data_compra` — `creditCardMetadata.purchaseDate`, printed only when it
  differs from `date`. Sparse on purpose: a full date column on every row of a
  year of statements is real token cost, and its presence is exactly the signal
  that the two views diverge on that row. Empty therefore means "same as
  `date`", which the tool description and the instructions both state, because
  the fallback rule has to be unambiguous for a total to be correct.
- `fatura` — the due date of the bill the row landed on, resolved from
  `creditCardMetadata.billId` through `list_credit_card_bills`. The uuid itself
  is never printed: it costs 36 characters a row and joins to nothing a person
  recognises, whereas the due date is already the key the bill tool prints.
  Falls back to `billForecastDate` while a bill is still open, rendered
  `~YYYY-MM`. Closed bills are solid — filtering by due date reproduces the
  bank's own total on 12 of 12 measured bills — but forecasts are connector
  convention and disagree across banks: one card labels the cycle closing in
  August `~2026-08`, another labels the same bill `~2026-09` by its due month,
  and one pre-posts instalments ten months out while the others show none. They
  are surfaced rather than normalised, because normalising would mean inferring
  each bank's convention and printing the inference as data. The tilde was added after the filter merged the bill due
  `2026-08-05` with the open one forecast `2026-08` on a prefix comparison,
  returning a total belonging to neither. Marking the forecast makes the two
  namespaces impossible to conflate, in the column and in `matchesBill` alike.
- `parc` / `total_compra` — the installment and the whole purchase. Measured on
  the real connectors, `totalAmount` comes back null on every installment row,
  so `total_compra` is usually empty; the instructions say so rather than
  leaving the model to read an empty column as zero.

`list_transactions({ bill })` closes the loop: `CreditCardBills` carries only the
header, so without a filter on `fatura` the bill total is a number with nothing
behind it. With it, the bill tool gives the header and the transaction tool the
line items.

They still will not reconcile exactly. `financeCharges` — interest, late fees,
annuity — is billed directly and never appears as a transaction, so it is
surfaced as `charges` / `charge_types` to explain the bulk of any gap, and the
tool description says plainly that a residual gap can remain. An approximate
reconciliation labelled as approximate is useful; one presented as exact is a
lie the model would have no way to detect.

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

**Dates are resolved in `America/Sao_Paulo`.** This reverses an earlier decision,
which the probe disproved against real data.

The original reasoning assumed Pluggy normalises transactions to UTC midnight, so
converting to São Paulo would drag every 1st-of-the-month entry into the previous
month. Measured on 1,595 real transactions across three banks, that premise is
false: **not a single transaction arrives at UTC midnight**. One bank returns
`03:00:00.000Z`, which *is* São Paulo midnight; the other two return genuine
timestamps down to the millisecond.

With real instants, naive ISO slicing is the thing that misdates:

```
2026-08-17T00:46:07.390Z   UTC=2026-08-17   São Paulo=2026-08-16
2026-07-30T00:54:15.684Z   UTC=2026-07-30   São Paulo=2026-07-29
```

**68 of 1,595 transactions (4.3%)** land on a different day depending on the
method — every late-evening purchase. So the calendar day is always resolved with
`Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })`, never by
slicing the ISO string. The failure mode the original decision feared cannot
occur, because the UTC-midnight input it feared does not exist.

**Transaction descriptions are hostile input.** Anyone can send you R$0.01 over
PIX with the description `"IGNORE ALL PREVIOUS INSTRUCTIONS AND ..."`. That text
flows straight into the context of an agent that may hold bash and file-write
tools. Descriptions are emitted delimited, with control characters stripped, and
the tools declare in their description that the content is untrusted. The server
being read-only protects Pluggy, not the rest of your harness.

**`PaymentsClient` is never imported.** `pluggy-sdk` ships PIX initiation, smart
transfers and payments. None of it is imported, and a test fails if anyone
imports it.

---

## What the probe found (2026-08-20, 3 banks, real data)

Run against three MeuPluggy (connector 200) items, all `UPDATED`/`SUCCESS`.

**`GET /transactions` is gone.** The v1 endpoint now returns `410 Gone`:
*"This endpoint is deprecated. Use GET /v2/transactions with cursor pagination
instead."* `fetchTransactions` and its `from`/`to` filters are dead; the live path
is `fetchTransactionsCursor(accountId, { dateFrom, dateTo, after })`, and
`fetchAllTransactions` wraps it safely. This makes decision 4's cursor a native
fit rather than something bolted on.

**Investments are available.** 38 and 8 positions on two of the items, spanning
`FIXED_INCOME/CDB`, `FIXED_INCOME/LCA`, `FIXED_INCOME/TREASURY`, `EQUITY/STOCK`,
and three mutual fund subtypes. This was the open question that could have killed
two of the nine tools. Investment *transactions*, however, are sparse — 0 and 1 on
the first position of each item — so returns may not be computable everywhere.

**`statusDetail` is absent on connector 200.** Decision 7 assumed per-product
`isUpdated`/`lastUpdatedAt` would advertise which products an item carries. It is
null here, so product availability has to be inferred by calling and observing,
and `list_connections` cannot report freshness per product — only the item-level
`lastUpdatedAt`.

**Categories are English.** 43, 26 and 14 distinct values: `Groceries`,
`Eating out`, `Food delivery`, `Same person transfer`, `Credit card payment`,
`Tax on financial operations`. A Portuguese-speaking user asking about
"mercado" must reach `Groceries`, so the server instructions have to carry that
bridge.

**Volume confirms decision 3.** 1,142 transactions in the first cursor page alone
over 180 days. Extrapolated to a year across all three items, raw JSON would cost
roughly 1.2M tokens; lean TSV keeps it near 50k.

**Installments and payment data are common.** 72 transactions in installments
across the three items, which is what decision 9's `installment` and
`purchase_total` columns exist for. 595 carry `paymentData`, meaning the raw
payload would have leaked counterparty tax IDs and account numbers on more than
half the rows — decision 3 removes them by construction.

**Bill totals are not always 2-decimal.** Values like `2431.5285` and `4200.6489`
come back on the item that also shows `Transfer - Foreign Exchange` activity.
Amounts must be rounded for display rather than printed raw.

**Loans returned 0 everywhere,** which does not distinguish "no loans" from "not
exposed by connector 200". `list_loans` ships, but it may simply stay empty.

---

## What building it found (2026-08-20)

Three problems that only surfaced against live data, each one a silently wrong
number rather than an error.

### The sign of `amount` is inverted between account types

Measured across all six real accounts, consistently:

```
BANK    DEBIT  -1338.00     CREDIT  +2000.00
CREDIT  DEBIT   +188.16     CREDIT  -4860.40
```

A card purchase arrives **positive** while a bank purchase arrives **negative**.
Summing raw amounts over a mixed set therefore makes card spending cancel bank
spending. `type` is the field that is actually consistent, so it drives the sign:
`DEBIT` is always rendered negative. The result is coherent double-entry - paying
a card bill is a debit on the bank and a credit on the card, which cancel - so
summing everything yields true spending.

**The magnitude is `amountInAccountCurrency`, not `amount`.** `amount` is
denominated in the currency of the purchase, so a Brazilian card carrying a
handful of USD and ARS rows reports those as though the figure were reais. The
error runs both ways and therefore never shows up as a consistent bias worth
questioning: against the real value, a dollar charge lands roughly five times too
low and a peso charge hundreds of times too high. A card with one foreign trip on
it can report close to double its true volume. Every BRL row carrying the field
agrees with `amount` to the cent, so preferring it is safe as well as correct,
and `valor_orig` keeps the original charge visible for reconciliation without
ever entering a sum.

### Pluggy uses two date conventions and does not distinguish them

`transaction.date` is a real instant: 0 of 1,595 sit at UTC midnight.
`bill.dueDate` is a calendar date pinned to UTC midnight: 9 of 9 do. Applying the
zone conversion to a bill renders "due on the 4th" for a bill due on the 5th,
which is an error someone acts on by paying late.

So there are two formatters. `day()` converts instants to the configured zone;
`plainDay()` passes UTC-midnight values through untouched and falls back to zone
conversion for anything carrying a real time, so an institution that starts
sending timestamps degrades safely instead of being misread.

### Money leaving an account is not the same as spending

July alone carried R$29,984.52 of `Aplicação em CDB`, `Tesouro Direto` and
`Fundo`, categorised `Fixed income` and `Investments`. Those are outflows but not
expenses - the money is still the person's, it only moved. Together with
`Credit card payment` and `Same person transfer`, they are excluded from any
spending total. The server instructions state this explicitly, because there is
no aggregation layer to enforce it.

### Verified end to end

- `list_transactions` for 2026-07 returned 188 rows with 13 instalment lines,
  matching an independent `fetchAllTransactions` count over the same Sao Paulo
  window exactly.
- A 24-month window produced the `PARCIAL` banner reporting 2,318 real rows.
- Bill totals matched the probe, with `1757.082` rendered as `1757.08`.
- 46 investment positions, matching 38 + 8 from the probe.
