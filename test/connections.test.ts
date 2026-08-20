import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { explainRefreshFailure } from '../src/tools/connections.ts'

/**
 * Every connection in the setup this server documents belongs to the MeuPluggy
 * connector, and Pluggy refuses to update those. Passing the raw 400 through
 * reads as a transient failure worth retrying, which it is not: it invites the
 * model to keep offering a refresh, and to present a missing window of history
 * as something a retry could fill.
 */
describe('refresh failures explain themselves', () => {
  const MEUPLUGGY = { code: 400, message: 'MeuPluggy item cant be updated' }

  it('turns the MeuPluggy refusal into where the sync actually lives', () => {
    const out = explainRefreshFailure('XP', MEUPLUGGY)

    assert.match(out, /^XP: /)
    assert.match(out, /nao pode ser sincronizada por aqui/)
    assert.match(out, /meu\.pluggy\.ai/)
    assert.match(out, /repetir este comando nao vai ajudar/)
    assert.doesNotMatch(out, /400/, 'the raw status code is noise once the cause is named')
  })

  it('says a missing window is not fixable from here', () => {
    assert.match(explainRefreshFailure('Banco Inter', MEUPLUGGY), /historico tambem nao se resolve por aqui/)
  })

  it('leaves a genuine failure reported as a failure', () => {
    const out = explainRefreshFailure('XP', { code: 503, message: 'upstream unavailable' })

    assert.match(out, /falha ao iniciar sincronizacao/)
    assert.match(out, /upstream unavailable/)
    assert.doesNotMatch(out, /meu\.pluggy\.ai/, 'a real outage is not a MeuPluggy limitation')
  })

  it('matches the refusal however Pluggy words the apostrophe', () => {
    for (const message of ["MeuPluggy item can't be updated", 'item cant be updated']) {
      assert.match(explainRefreshFailure('XP', { code: 400, message }), /nao pode ser sincronizada por aqui/)
    }
  })
})
