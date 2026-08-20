/**
 * `list_connections`, `list_accounts` and `refresh_connection`.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'

import { money } from '../money.ts'
import { describeError } from '../pluggy/store.ts'
import { renderTsv } from '../tsv.ts'
import { READ_ONLY, text, type ToolContext } from './common.ts'

/** What each item status means for the person, and what to do about it. */
const STATUS_HELP: Record<string, string> = {
  UPDATED: 'ok',
  UPDATING: 'sincronizando agora',
  LOGIN_ERROR: 'credenciais invalidas - reconecte em meu.pluggy.ai',
  OUTDATED: 'sincronizacao falhou - reconecte em meu.pluggy.ai',
  WAITING_USER_INPUT: 'aguardando MFA - resolva em meu.pluggy.ai',
  WAITING_USER_ACTION: 'aguardando acao sua em meu.pluggy.ai',
  MERGING: 'consolidando dados',
  UNREACHABLE: 'nao foi possivel consultar este item',
}

/**
 * Turns a failed sync into something the caller can act on.
 *
 * Items owned by the MeuPluggy connector cannot be refreshed through the API at
 * all: Pluggy answers `400 MeuPluggy item cant be updated`. They are a proxy
 * over connections Meu Pluggy owns and syncs itself, about once a day, so the
 * call is not failing — it is inapplicable, and retrying never changes that.
 * Passing the raw 400 through invites the model to offer a refresh that cannot
 * work and to treat a stale window as fixable from here.
 *
 * Matched on the message rather than on connector id 200, so a setup that also
 * has a directly connected bank keeps refreshing that one normally.
 */
export function explainRefreshFailure(label: string, error: unknown): string {
  const detail = describeError(error)
  if (/can'?t be updated/i.test(detail) || /meupluggy/i.test(detail)) {
    return (
      `${label}: esta conexao nao pode ser sincronizada por aqui. Ela pertence ao conector MeuPluggy, ` +
      `que atualiza as conexoes sozinho cerca de uma vez por dia. Forcar uma atualizacao agora significa ` +
      `reconectar o banco em https://meu.pluggy.ai - repetir este comando nao vai ajudar. ` +
      `Um intervalo faltando no historico tambem nao se resolve por aqui.`
    )
  }
  return `${label}: falha ao iniciar sincronizacao - ${detail}`
}

export function registerConnectionTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_connections',
    {
      title: 'List connections',
      description:
        'The connected banks, their sync status, and how fresh the data is. Call this first when a total looks wrong or lower than expected: a connection in LOGIN_ERROR or OUTDATED is silently absent from every other tool. Data refreshes roughly once a day, so `updated` shows how old the numbers are.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      const connections = await ctx.store.connections()
      const rows = connections.map((c) => [
        c.label,
        c.status,
        STATUS_HELP[c.status] ?? '',
        c.lastUpdatedAt ? ctx.day(c.lastUpdatedAt) : 'nunca',
        c.accounts.length,
        c.error ?? '',
      ])
      return text(renderTsv(['bank', 'status', 'meaning', 'updated', 'accounts', 'error'], rows))
    },
  )

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'Every account across every connected bank, with balances. For credit cards, `balance` is the amount currently owed, and `limit` / `available` describe the credit line. Use the `account` label from here to filter other tools.',
      inputSchema: z.object({
        connection: z.string().optional().describe('Restrict to one bank, matched on the connection label.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ connection }) => {
      const { healthy, missing } = await ctx.store.resolve(connection)
      const rows = healthy.flatMap((c) =>
        c.accounts.map((account) => [
          c.accountLabels.get(account.id) ?? c.label,
          account.type === 'CREDIT' ? 'cartao' : 'conta',
          money(account.balance),
          account.currencyCode ?? 'BRL',
          money(account.creditData?.creditLimit),
          money(account.creditData?.availableCreditLimit),
          ctx.plainDay(account.creditData?.balanceDueDate),
        ]),
      )
      return text(
        renderTsv(['account', 'kind', 'balance', 'currency', 'limit', 'available', 'due'], rows, { missing }),
      )
    },
  )

  server.registerTool(
    'refresh_connection',
    {
      title: 'Refresh a connection',
      description:
        'Asks Pluggy to re-sync a bank. Returns immediately without waiting - a sync takes minutes. Poll list_connections to see when the status returns to UPDATED. Only worth calling when list_connections shows the data is older than the answer needs; connections refresh on their own about once a day. Connections owned by the MeuPluggy connector cannot be refreshed this way at all - Pluggy refuses them - so do not offer a refresh as a way to fill a gap in history without checking that it is accepted.',
      inputSchema: z.object({
        connection: z.string().describe('The bank to refresh, matched on its connection label or item id.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ connection }) => {
      const all = await ctx.store.connections()
      const needle = connection.toLowerCase()
      const target = all.find((c) => c.label.toLowerCase().includes(needle) || c.itemId === connection)
      if (!target) {
        const names = all.map((c) => c.label).join(', ')
        return text(`Nenhuma conexao corresponde a ${JSON.stringify(connection)}. Disponiveis: ${names}`)
      }

      try {
        const item = await ctx.store.refresh(target.itemId)
        if (item.status === 'WAITING_USER_INPUT' || item.status === 'WAITING_USER_ACTION') {
          // The server has no way to answer an MFA challenge, so say so plainly
          // rather than leaving the model to poll a status that will never move.
          return text(
            `${target.label}: ${item.status}. O banco pediu autenticacao adicional e este servidor nao pode responder por voce. Resolva em https://meu.pluggy.ai e chame list_connections depois.`,
          )
        }
        return text(
          `${target.label}: sincronizacao iniciada (status ${item.status}). Isso leva alguns minutos. Chame list_connections para acompanhar; nao repita este comando enquanto estiver UPDATING.`,
        )
      } catch (error) {
        return text(explainRefreshFailure(target.label, error))
      }
    },
  )
}
