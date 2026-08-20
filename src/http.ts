/**
 * HTTP entrypoint.
 *
 * The process binds to loopback only. Exposure to the tailnet is `tailscale
 * serve`'s job, which removes an entire class of mistake: a cloud VM has a
 * public IP, and a server bound to 0.0.0.0 behind an open security list puts a
 * bank statement on the internet. Nothing here should ever bind more widely.
 *
 * Auth is a static shared token rather than OAuth. The SDK's `requireBearerAuth`
 * lives in the Express package and is built around OAuth verifiers and resource
 * metadata; this server has exactly one client, its owner.
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'

import { loadConfig } from './config.ts'
import { PluggyStore } from './pluggy/store.ts'
import { buildServer, createToolContext, SERVER_NAME, SERVER_VERSION } from './server.ts'

/** Constant-time comparison, length-padded so the length itself does not leak. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong length is not measurably faster.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * Node types `method` and `url` as optional because IncomingMessage is shared
 * with the client side, while the MCP handler requires both. On a server request
 * they are always present, so this narrows rather than asserts.
 */
function isServerRequest(req: IncomingMessage): req is IncomingMessage & { method: string; url: string } {
  return typeof req.method === 'string' && typeof req.url === 'string'
}

function unauthorized(res: ServerResponse): void {
  // No detail: a caller without the token learns nothing beyond "not allowed".
  res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
  res.end(JSON.stringify({ error: 'unauthorized' }))
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization
  if (!header) return false
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return false
  return tokenMatches(rest.join(' ').trim(), expected)
}

export async function main(): Promise<void> {
  const config = loadConfig()
  const store = new PluggyStore(config)
  const ctx = createToolContext(config, store)

  const handler = toNodeHandler(createMcpHandler(() => buildServer(ctx)))

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Unauthenticated on purpose: systemd and humans need to know the process is
    // alive, and it reveals nothing.
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION }))
      return
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    if (!isAuthorized(req, config.bearerToken)) {
      unauthorized(res)
      return
    }

    if (!isServerRequest(req)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }

    void handler(req, res)
  })

  server.listen(config.bindPort, config.bindHost, () => {
    console.error(
      `${SERVER_NAME} ${SERVER_VERSION} listening on http://${config.bindHost}:${config.bindPort}/mcp ` +
        `(${config.itemIds.length} connection(s), ${config.historyMonths}mo history, tz ${config.timeZone})`,
    )
    // Off the critical path: the first real question should not be the one that
    // pays for the initial statement sweep.
    void store
      .warm()
      .then(() => console.error('transaction cache warmed'))
      .catch((error: unknown) => console.error('cache warm failed (non-fatal):', error))
  })

  const shutdown = (signal: string) => {
    console.error(`${signal} received, shutting down`)
    server.close(() => process.exit(0))
    // systemd sends SIGKILL eventually; do not hang on a stuck connection.
    setTimeout(() => process.exit(0), 5_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

await main()
