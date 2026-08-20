/**
 * MCP server assembly.
 *
 * `createMcpHandler` calls this factory per connection, so the McpServer itself
 * is cheap and disposable. The store is not: it holds the cached statement
 * sweep, so it is created once and shared across every connection.
 */
import { McpServer } from '@modelcontextprotocol/server'

import type { Config } from './config.ts'
import { calendarDateFormatter, plainDateFormatter } from './dates.ts'
import { INSTRUCTIONS } from './instructions.ts'
import { PluggyStore } from './pluggy/store.ts'
import { registerPrompts } from './prompts.ts'
import type { ToolContext } from './tools/common.ts'
import { registerConnectionTools } from './tools/connections.ts'
import { registerHoldingTools } from './tools/holdings.ts'
import { registerTransactionTools } from './tools/transactions.ts'

export const SERVER_NAME = 'pluggy'
export const SERVER_VERSION = '0.1.0'

export function createToolContext(config: Config, store?: PluggyStore): ToolContext {
  return {
    config,
    store: store ?? new PluggyStore(config),
    day: calendarDateFormatter(config.timeZone),
    plainDay: plainDateFormatter(config.timeZone),
  }
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: INSTRUCTIONS,
    },
  )

  registerConnectionTools(server, ctx)
  registerTransactionTools(server, ctx)
  registerHoldingTools(server, ctx)
  registerPrompts(server)

  return server
}
