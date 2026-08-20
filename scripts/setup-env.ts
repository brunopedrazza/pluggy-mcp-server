/**
 * Interactive .env generator.
 *
 * Prompts for the Pluggy credentials, generates the MCP bearer token, verifies
 * the credentials against the Pluggy API, and writes .env with mode 0600.
 *
 * The client secret is never echoed to the terminal and never printed back.
 *
 * Usage:  npm run setup
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = join(ROOT, '.env')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ETX = '\u0003' // Ctrl-C
const DEL = '\u007f' // backspace on most terminals

const rl = createInterface({ input: stdin, output: stdout })

// Pull lines from an async iterator rather than rl.question(). With piped stdin
// the stream delivers everything at once and closes; a question() issued after
// that close never settles, which silently hangs the script.
const lines = rl[Symbol.asyncIterator]()

async function readLine(prompt: string): Promise<string> {
  stdout.write(prompt)
  const next = await lines.next()
  if (next.done) {
    console.log('\nInput ended before all answers were given. Nothing was written.')
    process.exit(1)
  }
  return next.value
}

/** Reads an existing .env so re-running the script keeps previous answers as defaults. */
function readExisting(): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(ENV_PATH)) return out
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    const key = m?.[1]
    const value = m?.[2]
    if (key !== undefined && value !== undefined) out.set(key, value)
  }
  return out
}

/** Reads a line without echoing it, so secrets never land in the scrollback. */
function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) return readLine(prompt)
  stdout.write(prompt)
  rl.pause() // readline must not consume bytes while raw mode owns stdin
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let buffer = ''
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      rl.resume()
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup()
          stdout.write('\n')
          resolve(buffer)
          return
        }
        if (ch === ETX) {
          cleanup()
          stdout.write('\n')
          reject(new Error('cancelled'))
          return
        }
        if (ch === DEL || ch === '\b') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1)
            stdout.write('\b \b')
          }
          continue
        }
        buffer += ch
        stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

/** Keeps asking until the answer validates. Empty input keeps the current value. */
async function ask(
  label: string,
  opts: { current?: string; secret?: boolean; validate?: (v: string) => string | null },
): Promise<string> {
  const hint = opts.current ? ' [keep current]' : ''
  for (;;) {
    const raw = opts.secret
      ? await readSecret(`${label}${hint}: `)
      : await readLine(`${label}${hint}: `)
    const value = raw.trim() || opts.current || ''
    if (!value) {
      console.log('  -> required')
      continue
    }
    const error = opts.validate?.(value)
    if (error) {
      console.log(`  -> ${error}`)
      continue
    }
    return value
  }
}

/** Builds the optional `current` property without tripping exactOptionalPropertyTypes. */
function current(existing: Map<string, string>, key: string): { current?: string } {
  const value = existing.get(key)
  return value ? { current: value } : {}
}

console.log('\nPluggy MCP server - environment setup')
console.log('Credentials come from dashboard.pluggy.ai. See README step 1.\n')

const existing = readExisting()
if (existing.size > 0) {
  console.log('.env already exists. Press Enter on any prompt to keep the current value.\n')
}

const clientId = await ask('Pluggy Client ID', {
  ...current(existing, 'PLUGGY_CLIENT_ID'),
  validate: (v) => (UUID.test(v) ? null : 'expected a UUID'),
})

const clientSecret = await ask('Pluggy Client Secret', {
  secret: true,
  ...current(existing, 'PLUGGY_CLIENT_SECRET'),
  validate: (v) => (v.length >= 8 ? null : 'looks too short'),
})

console.log('\nItem IDs: one per connected bank, comma-separated.')
const itemIdsRaw = await ask('Pluggy Item IDs', {
  ...current(existing, 'PLUGGY_ITEM_IDS'),
  validate: (v) => {
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length === 0) return 'at least one item id'
    const bad = parts.find((p) => !UUID.test(p))
    return bad ? `not a UUID: ${bad}` : null
  },
})
const itemIds = itemIdsRaw.split(',').map((s) => s.trim()).filter(Boolean).join(',')

// The bearer token protects the MCP endpoint itself. There is no reason to make
// a human invent one, so it is generated unless the file already carries one.
const existingBearer = existing.get('MCP_BEARER_TOKEN')
const bearer = existingBearer || randomBytes(48).toString('base64url')
console.log(
  existingBearer
    ? '\nMCP bearer token: keeping the existing one.'
    : '\nMCP bearer token: generated (48 random bytes).',
)

// --- Verify before writing -------------------------------------------------
console.log('\nVerifying credentials against the Pluggy API...')
let verified = false
try {
  const { PluggyClient } = await import('pluggy-sdk')
  const client = new PluggyClient({ clientId, clientSecret })
  for (const id of itemIds.split(',')) {
    const item = await client.fetchItem(id)
    const connector = item.connector?.name ?? 'unknown connector'
    console.log(`  ok  ${id.slice(0, 8)}...  ${connector}  status=${item.status}`)
  }
  verified = true
} catch (e) {
  console.log(`  FAILED: ${e instanceof Error ? e.message : String(e)}`)
  console.log('  Check the client id/secret, and that every item id belongs to this application.')
}

if (!verified) {
  const answer = (await readLine('\nSave anyway? [y/N]: ')).trim().toLowerCase()
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Aborted. Nothing was written.')
    rl.close()
    process.exit(1)
  }
}

// --- Write -----------------------------------------------------------------
const contents = `# Generated by \`npm run setup\`. Contains secrets - never commit this file.
PLUGGY_CLIENT_ID=${clientId}
PLUGGY_CLIENT_SECRET=${clientSecret}
PLUGGY_ITEM_IDS=${itemIds}

# Token MCP clients must send in the Authorization: Bearer <token> header.
MCP_BEARER_TOKEN=${bearer}

# The process listens on loopback ONLY. Tailnet exposure is handled by
# \`tailscale serve\`, never by binding to 0.0.0.0.
MCP_BIND_HOST=${existing.get('MCP_BIND_HOST') || '127.0.0.1'}
MCP_BIND_PORT=${existing.get('MCP_BIND_PORT') || '8787'}

# Row ceiling per response before truncating with a warning.
MCP_MAX_ROWS=${existing.get('MCP_MAX_ROWS') || '800'}
`

writeFileSync(ENV_PATH, contents, { mode: 0o600 })
chmodSync(ENV_PATH, 0o600) // enforced even if the file already existed with looser bits

console.log(`\nWrote ${ENV_PATH} (mode 0600).`)
console.log('Next: npm run probe')
rl.close()
