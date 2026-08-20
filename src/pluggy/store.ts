/**
 * The Pluggy data layer.
 *
 * Everything the tools need comes from here, already cached, labelled and split
 * into healthy and unusable connections. Tools never talk to the SDK directly.
 *
 * The transaction sweep is the important design choice. Rather than querying
 * Pluggy per request, the store sweeps the whole configured window once per sync
 * and answers every later question from memory. That is what makes filtering,
 * searching and pagination exact instead of approximate: the tools operate on
 * the complete set, so a total is a real total. It costs one slow call after
 * each daily sync, which `warm()` moves off the critical path.
 */
import { PluggyClient } from 'pluggy-sdk'
import type { Account, CreditCardBills, Investment, Item, Loan, Transaction } from 'pluggy-sdk'

import type { Config } from '../config.ts'
import type { MissingConnection } from '../tsv.ts'
import { Cache } from './cache.ts'
import { buildAccountLabels, deriveBankName } from './labels.ts'

/** Statuses in which an item's data is trustworthy enough to report. */
const HEALTHY: ReadonlySet<string> = new Set(['UPDATED'])

export type Connection = {
  itemId: string
  label: string
  status: string
  executionStatus: string | null
  lastUpdatedAt: Date | null
  error: string | null
  healthy: boolean
  accounts: Account[]
  accountLabels: Map<string, string>
}

/** Pluggy throws plain objects, so `String(e)` yields "[object Object]". */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const o = error as Record<string, unknown>
    const parts = [o['code'], o['codeDescription'], o['message']].filter(Boolean)
    if (parts.length > 0) return parts.join(' ')
    return JSON.stringify(error)
  }
  return String(error)
}

export class PluggyStore {
  #config: Config
  #client: PluggyClient
  #cache = new Cache()

  constructor(config: Config, client?: PluggyClient) {
    this.#config = config
    this.#client = client ?? new PluggyClient({ clientId: config.clientId, clientSecret: config.clientSecret })
  }

  /** Stamp that changes whenever Pluggy syncs, forming the versioned cache key. */
  #stamp(connection: Connection): string {
    return connection.lastUpdatedAt ? connection.lastUpdatedAt.toISOString() : 'never'
  }

  /**
   * Resolves every configured item, healthy or not.
   *
   * A short TTL applies here rather than a versioned key, because this is the
   * call that discovers the version in the first place.
   */
  async connections(): Promise<Connection[]> {
    return this.#cache.through(
      'connections',
      async () => {
        const resolved = await Promise.all(this.#config.itemIds.map((id) => this.#resolveOne(id)))
        return resolved
      },
      { ttlMs: 60_000 },
    )
  }

  async #resolveOne(itemId: string): Promise<Connection> {
    const short = itemId.slice(0, 8)
    let item: Item | null = null
    let error: string | null = null

    try {
      item = await this.#client.fetchItem(itemId)
    } catch (e) {
      error = describeError(e)
    }

    // Accounts are attempted even for a degraded item: Pluggy usually still
    // serves the last successful snapshot, which is what gives the banner a
    // recognisable bank name instead of a bare uuid.
    let accounts: Account[] = []
    let accountsError: string | null = null
    try {
      accounts = (await this.#client.fetchAccounts(itemId)).results
    } catch (e) {
      accountsError = `accounts unavailable: ${describeError(e)}`
    }

    // A configured name wins: derivation cannot identify an institution whose
    // accounts are all called "Conta Corrente".
    const label = this.#config.itemLabels.get(itemId) ?? deriveBankName(accounts, `Conexao ${short}`)
    const status = item?.status ?? 'UNREACHABLE'

    // A failed account fetch cannot be swallowed. Every tool maps over
    // `accounts`, so a transient failure here would otherwise return an empty
    // statement under an UPDATED banner: the bank silently drops out of every
    // total, at full confidence, which is the exact failure decision 14 exists
    // to prevent. An item that genuinely has no accounts is a different thing
    // and stays healthy.
    return {
      itemId,
      label,
      status,
      executionStatus: item?.executionStatus ?? null,
      lastUpdatedAt: item?.lastUpdatedAt ? new Date(item.lastUpdatedAt) : null,
      error: error ?? (item?.error ? `${item.error.code}: ${item.error.message}` : null) ?? accountsError,
      healthy: HEALTHY.has(status) && accountsError === null,
      accounts,
      accountLabels: buildAccountLabels(accounts, label),
    }
  }

  /**
   * Splits connections into the ones worth reading and the ones to warn about.
   *
   * With several banks connected, one being broken is the normal state. Callers
   * report the healthy rows and surface `missing` as a banner, so a smaller
   * total is never presented as a complete one.
   */
  async resolve(filter?: string): Promise<{ healthy: Connection[]; missing: MissingConnection[] }> {
    const all = await this.connections()
    const matched = filter
      ? all.filter((c) => c.label.toLowerCase().includes(filter.toLowerCase()) || c.itemId === filter)
      : all

    const healthy = matched.filter((c) => c.healthy)
    const missing = matched
      .filter((c) => !c.healthy)
      .map((c) => ({
        label: c.label,
        status: c.error ? `${c.status} (${c.error})` : c.status,
        since: c.lastUpdatedAt ? c.lastUpdatedAt.toISOString().slice(0, 10) : undefined,
      }))

    return { healthy, missing }
  }

  /**
   * Every transaction in the configured history window, newest first.
   *
   * `fetchAllTransactions` is used deliberately: it wraps the cursor-based
   * v2 endpoint. The v1 endpoint the SDK still exposes as `fetchTransactions`
   * returns 410 Gone.
   */
  async transactions(connection: Connection): Promise<Transaction[]> {
    const stamp = this.#stamp(connection)
    const from = new Date()
    from.setUTCMonth(from.getUTCMonth() - this.#config.historyMonths)
    const dateFrom = from.toISOString().slice(0, 10)

    return this.#cache.through(
      `${connection.itemId}:transactions:${stamp}`,
      async () => {
        const perAccount = await Promise.all(
          connection.accounts.map((account) => this.#client.fetchAllTransactions(account.id, { dateFrom })),
        )
        return perAccount.flat().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      },
      { versionPrefix: `${connection.itemId}:transactions:` },
    )
  }

  async bills(connection: Connection, accountId: string): Promise<CreditCardBills[]> {
    const stamp = this.#stamp(connection)
    return this.#cache.through(
      `${connection.itemId}:bills:${accountId}:${stamp}`,
      async () => (await this.#client.fetchCreditCardBills(accountId)).results,
      { versionPrefix: `${connection.itemId}:bills:${accountId}:` },
    )
  }

  async investments(connection: Connection): Promise<Investment[]> {
    const stamp = this.#stamp(connection)
    return this.#cache.through(
      `${connection.itemId}:investments:${stamp}`,
      async () => (await this.#client.fetchInvestments(connection.itemId)).results,
      { versionPrefix: `${connection.itemId}:investments:` },
    )
  }

  async investmentTransactions(connection: Connection, investmentId: string) {
    const stamp = this.#stamp(connection)
    return this.#cache.through(
      `${connection.itemId}:invtx:${investmentId}:${stamp}`,
      async () => (await this.#client.fetchInvestmentTransactions(investmentId)).results,
      { versionPrefix: `${connection.itemId}:invtx:${investmentId}:` },
    )
  }

  async loans(connection: Connection): Promise<Loan[]> {
    const stamp = this.#stamp(connection)
    return this.#cache.through(
      `${connection.itemId}:loans:${stamp}`,
      async () => (await this.#client.fetchLoans(connection.itemId)).results,
      { versionPrefix: `${connection.itemId}:loans:` },
    )
  }

  /**
   * Asks Pluggy to sync, without waiting for it.
   *
   * Blocking until the item reports UPDATED would take minutes and exceed MCP
   * client timeouts, so the caller gets the new status immediately and polls
   * through `list_connections`.
   */
  async refresh(itemId: string): Promise<Item> {
    const item = await this.#client.updateItem(itemId)
    this.#cache.clear()
    return item
  }

  /**
   * Pre-loads the transaction sweep so the first real question is not the one
   * that waits ~20-60s for it. Failures are ignored: this is an optimisation,
   * and a bank being down at boot must not stop the server.
   */
  async warm(): Promise<void> {
    const { healthy } = await this.resolve()
    await Promise.allSettled(healthy.map((connection) => this.transactions(connection)))
  }
}
