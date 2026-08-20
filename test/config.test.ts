import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadConfig } from '../src/config.ts'

const ID_A = '11111111-1111-1111-1111-111111111111'
const ID_B = '22222222-2222-2222-2222-222222222222'

/** The minimum that satisfies every other rule, so a case tests only its own subject. */
function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PLUGGY_CLIENT_ID: '33333333-3333-3333-3333-333333333333',
    PLUGGY_CLIENT_SECRET: 'secret',
    PLUGGY_ITEM_IDS: `${ID_A},${ID_B}`,
    MCP_BEARER_TOKEN: 'x'.repeat(32),
    ...over,
  }
}

/**
 * Label derivation reads the institution off account names, which fails for an
 * item whose accounts are all called "Conta Corrente". This is the override for
 * those, and a typo in it must not be the kind of mistake you discover by
 * noticing a connection is still called the wrong thing.
 */
describe('PLUGGY_ITEM_LABELS', () => {
  it('is optional', () => {
    assert.equal(loadConfig(env()).itemLabels.size, 0)
  })

  it('maps item ids to names', () => {
    const { itemLabels } = loadConfig(env({ PLUGGY_ITEM_LABELS: `${ID_A}=Banco X,${ID_B}=Banco Y` }))

    assert.equal(itemLabels.get(ID_A), 'Banco X')
    assert.equal(itemLabels.get(ID_B), 'Banco Y')
  })

  it('tolerates spacing around entries', () => {
    const { itemLabels } = loadConfig(env({ PLUGGY_ITEM_LABELS: ` ${ID_A} = Banco X ` }))

    assert.equal(itemLabels.get(ID_A), 'Banco X')
  })

  it('keeps an = inside the name, since only the first one separates', () => {
    const { itemLabels } = loadConfig(env({ PLUGGY_ITEM_LABELS: `${ID_A}=A=B` }))

    assert.equal(itemLabels.get(ID_A), 'A=B')
  })

  it('refuses an id that is not configured, rather than ignoring the line', () => {
    const unknown = '44444444-4444-4444-4444-444444444444'

    assert.throws(() => loadConfig(env({ PLUGGY_ITEM_LABELS: `${unknown}=Banco X` })), /not in PLUGGY_ITEM_IDS/)
  })

  it('refuses a malformed entry', () => {
    assert.throws(() => loadConfig(env({ PLUGGY_ITEM_LABELS: 'Banco X' })), /is not <item id>=<name>/)
    assert.throws(() => loadConfig(env({ PLUGGY_ITEM_LABELS: 'not-a-uuid=Banco X' })), /non-UUID item id/)
    assert.throws(() => loadConfig(env({ PLUGGY_ITEM_LABELS: `${ID_A}=` })), /empty name/)
  })

  it('reports every problem at once, like the rest of the config', () => {
    try {
      loadConfig(env({ PLUGGY_ITEM_LABELS: `not-a-uuid=X,${ID_A}=` }))
      assert.fail('expected a throw')
    } catch (error) {
      assert.match((error as Error).message, /non-UUID item id/)
      assert.match((error as Error).message, /empty name/)
    }
  })
})
