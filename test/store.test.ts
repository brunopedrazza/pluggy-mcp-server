import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Account, Item } from 'pluggy-sdk'
import type { PluggyClient } from 'pluggy-sdk'

import type { Config } from '../src/config.ts'
import { PluggyStore } from '../src/pluggy/store.ts'

const ITEM_ID = '11111111-1111-1111-1111-111111111111'

const CONFIG: Config = {
  clientId: '22222222-2222-2222-2222-222222222222',
  clientSecret: 'secret',
  itemIds: [ITEM_ID],
  bearerToken: 'x'.repeat(32),
  bindHost: '127.0.0.1',
  bindPort: 8787,
  maxRows: 800,
  timeZone: 'America/Sao_Paulo',
  historyMonths: 24,
}

function item(partial: Partial<Item>): Item {
  return { id: ITEM_ID, status: 'UPDATED', lastUpdatedAt: new Date('2026-08-20'), ...partial } as unknown as Item
}

function account(partial: Partial<Account> & { id: string }): Account {
  return partial as unknown as Account
}

/** Only the two calls `#resolveOne` makes need to exist. */
function client(over: { fetchItem?: () => Promise<Item>; fetchAccounts?: () => Promise<{ results: Account[] }> }) {
  return {
    fetchItem: over.fetchItem ?? (async () => item({})),
    fetchAccounts: over.fetchAccounts ?? (async () => ({ results: [] })),
  } as unknown as PluggyClient
}

/**
 * Every tool maps over `accounts`. If a failed account fetch were swallowed
 * into an empty list, an UPDATED connection would answer with an empty
 * statement and the bank would drop out of every total at full confidence —
 * a smaller number that looks exactly like a correct one.
 */
describe('a connection whose accounts cannot be read is not healthy', () => {
  it('reports the failure as missing rather than as an empty statement', async () => {
    const store = new PluggyStore(
      CONFIG,
      client({
        fetchAccounts: async () => {
          throw { code: 503, message: 'upstream unavailable' }
        },
      }),
    )

    const { healthy, missing } = await store.resolve()

    assert.equal(healthy.length, 0, 'a connection with unreadable accounts must not be reported as healthy')
    assert.equal(missing.length, 1)
    assert.match(missing[0]!.status, /accounts unavailable/)
    assert.match(missing[0]!.status, /upstream unavailable/)
  })

  it('still treats an item that genuinely has no accounts as healthy', async () => {
    const store = new PluggyStore(CONFIG, client({ fetchAccounts: async () => ({ results: [] }) }))

    const { healthy, missing } = await store.resolve()

    assert.equal(healthy.length, 1, 'an empty result is not a failure')
    assert.equal(missing.length, 0)
  })

  it('keeps reporting accounts it could read', async () => {
    const store = new PluggyStore(
      CONFIG,
      client({
        fetchAccounts: async () => ({
          results: [account({ id: 'a', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'XP' })],
        }),
      }),
    )

    const { healthy } = await store.resolve()

    assert.equal(healthy.length, 1)
    assert.equal(healthy[0]!.accounts.length, 1)
    assert.equal(healthy[0]!.label, 'XP')
  })
})
