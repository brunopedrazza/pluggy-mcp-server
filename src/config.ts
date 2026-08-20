/**
 * Environment parsing and validation.
 *
 * Everything is read once, at boot, and a missing or malformed value stops the
 * process with a single message listing every problem. A financial server that
 * starts half-configured and fails on the first tool call is worse than one
 * that refuses to start.
 */
export type Config = {
  clientId: string
  clientSecret: string
  itemIds: string[]
  bearerToken: string
  bindHost: string
  bindPort: number
  /** Row ceiling per response before truncating with a warning (decision 4). */
  maxRows: number
  /** Calendar days are resolved in this zone; see DESIGN.md on dates. */
  timeZone: string
  /** How far back the transaction store sweeps on each sync. */
  historyMonths: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readInt(raw: string | undefined, fallback: number, name: string, errors: string[]): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
    return fallback
  }
  return n
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const errors: string[] = []

  const clientId = env['PLUGGY_CLIENT_ID']?.trim() ?? ''
  const clientSecret = env['PLUGGY_CLIENT_SECRET']?.trim() ?? ''
  const bearerToken = env['MCP_BEARER_TOKEN']?.trim() ?? ''

  if (!clientId) errors.push('PLUGGY_CLIENT_ID is required')
  else if (!UUID.test(clientId)) errors.push('PLUGGY_CLIENT_ID must be a UUID')
  if (!clientSecret) errors.push('PLUGGY_CLIENT_SECRET is required')

  // The bearer token is the only thing standing between the tailnet and every
  // statement, so a weak one is refused rather than warned about.
  if (!bearerToken) errors.push('MCP_BEARER_TOKEN is required (generate with: openssl rand -base64 48)')
  else if (bearerToken.length < 32) errors.push('MCP_BEARER_TOKEN must be at least 32 characters')

  const itemIds = (env['PLUGGY_ITEM_IDS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (itemIds.length === 0) errors.push('PLUGGY_ITEM_IDS is required (one item id per connected bank)')
  for (const id of itemIds) {
    if (!UUID.test(id)) errors.push(`PLUGGY_ITEM_IDS contains a non-UUID value: ${id}`)
  }

  const timeZone = env['MCP_TIMEZONE']?.trim() || 'America/Sao_Paulo'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })
  } catch {
    errors.push(`MCP_TIMEZONE is not a valid IANA zone: ${timeZone}`)
  }

  const bindPort = readInt(env['MCP_BIND_PORT'], 8787, 'MCP_BIND_PORT', errors)
  const maxRows = readInt(env['MCP_MAX_ROWS'], 800, 'MCP_MAX_ROWS', errors)
  const historyMonths = readInt(env['PLUGGY_HISTORY_MONTHS'], 24, 'PLUGGY_HISTORY_MONTHS', errors)

  if (errors.length > 0) {
    throw new Error(
      `Invalid configuration:\n  - ${errors.join('\n  - ')}\n\nRun \`npm run setup\` to generate a valid .env.`,
    )
  }

  return {
    clientId,
    clientSecret,
    itemIds,
    bearerToken,
    bindHost: env['MCP_BIND_HOST']?.trim() || '127.0.0.1',
    bindPort,
    maxRows,
    timeZone,
    historyMonths,
  }
}
