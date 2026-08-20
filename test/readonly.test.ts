import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/**
 * The Pluggy SDK ships PIX initiation, smart transfers and bulk payments. This
 * server promises it cannot move money, and a promise enforced only by everyone
 * remembering is not enforced at all. If someone imports the payments surface,
 * this fails.
 */
describe('read-only guarantee', () => {
  const forbidden = [
    { pattern: /\bPaymentsClient\b/, why: 'the payments surface of the Pluggy SDK' },
    { pattern: /pluggy-sdk\/.*payments/i, why: 'a payments submodule import' },
    { pattern: /\bcreatePaymentRequest\b|\bcreatePixQrCode\b|\bcreateSmartTransfer\b/, why: 'a payment-initiating call' },
    { pattern: /\bdeleteItem\b/, why: 'destructive item deletion' },
  ]

  for (const file of sourceFiles(SRC)) {
    it(`${file.slice(SRC.length + 1)} initiates no payments`, () => {
      const source = readFileSync(file, 'utf8')
      for (const { pattern, why } of forbidden) {
        assert.ok(!pattern.test(source), `${file} references ${why}; this server must stay read-only`)
      }
    })
  }

  it('declares every read tool as read-only', () => {
    const common = readFileSync(join(SRC, 'tools', 'common.ts'), 'utf8')
    assert.match(common, /readOnlyHint:\s*true/)
  })
})
