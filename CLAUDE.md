# CLAUDE.md — pluggy-mcp-server

Guidance for any agent working in this repo. Read [DESIGN.md](./DESIGN.md) first — every decision
and its reasoning lives there, and [README.md](./README.md) covers setup and deployment.

## What this is

A read-only MCP server over one person's real bank, credit card and investment data (Brazilian Open
Finance, via Pluggy). It cannot move money, and a test fails if anyone imports Pluggy's
`PaymentsClient`. Keep it that way.

## Hard conventions

- **English only** in repo artifacts: code, comments, docs, commit messages. (Conversations with
  the owner happen in Portuguese; nothing Portuguese lands in the repo.)
- **Never sum rows mentally.** Write and run code. A month is hundreds of rows and a quietly wrong
  total is worse than no answer — the same rule the server injects into its own handshake.
- Amounts are normalised so **negative always means money leaving the account**, on bank accounts
  and cards alike, and always in the account's own currency. `valor_orig` is for reconciliation
  only: never sum it, never read it as reais.

## Two MCP registrations, and which one to use

Once the server is deployed (README) you have two of it: the one on the VM, and whatever
`npm run dev` is serving out of your working tree. Register them as separate entries — the
deployed one globally, the local one scoped to this directory — so the split is decided by where
you are rather than by guesswork:

| server | points at | use it for |
|---|---|---|
| `pluggy` | the VM, running `origin/main` | **any real question about the owner's finances** |
| `pluggy-dev` | `127.0.0.1:8787`, this working tree | exercising a change you are making right now |

`pluggy-dev` only answers while `npm run dev` is running, so a `ConnectionRefused` from it means
the dev server is down, not that anything is broken.

**They read the same account with the same credentials**, so the numbers are not "test data" — they
are the real numbers, computed by whichever code you happen to be pointing at. Picking `pluggy-dev`
by accident does not produce an obvious error; it produces a plausible figure from a half-finished
edit. So: `pluggy-dev` only to verify your own change behaves, `pluggy` for anything whose answer
the owner might act on.

## Toolchain

Node 22.6+ (the dev and test scripts rely on `--experimental-strip-types`). No build step for
development; `npm start` runs the compiled output.

```
npm run dev        # watch mode against .env, serves on 127.0.0.1:8787
npm test           # node --test over test/*.test.ts
npm run typecheck  # tsc --noEmit
npm run build      # tsc -p tsconfig.build.json
npm run probe      # what Connector 200 actually returns, without printing PII
```

Quality gate before considering work done: `npm run typecheck` and `npm test` green.

## Deployment

The VM can keep itself on `origin/main` — a systemd timer rebuilds and restarts when main moves,
and rolls back if the new commit does not come back healthy. See
[deploy/README.md](./deploy/README.md). Where that timer is enabled, anything merged to `main`
reaches a live server within minutes: `main` is not a staging area.

## Git

- Commit only when the owner asks. Small, logical commits, branch naming `feat/…`, `fix/…`,
  `docs/…`.
- Use `gh` for PRs (repo: `brunopedrazza/pluggy-mcp-server`, public).
