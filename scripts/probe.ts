/**
 * Sonda de capacidades do Conector 200 (MeuPluggy).
 *
 * Responde empiricamente as três incógnitas que travam o desenho das tools:
 *   1. Quais produtos o Conector 200 realmente entrega (investimentos? faturas? empréstimos?)
 *   2. As datas de transação vêm à meia-noite UTC, ou com hora real?
 *   3. As categorias vêm em inglês ou em português?
 *
 * Não imprime dado sensível: sem número de conta, sem CPF, sem descrição de
 * transação. Só contagens, presença de campos e nomes de categoria.
 *
 * Uso:  PLUGGY_CLIENT_ID=... PLUGGY_CLIENT_SECRET=... PLUGGY_ITEM_IDS=... npm run probe
 */
import { PluggyClient } from 'pluggy-sdk'

const { PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, PLUGGY_ITEM_IDS } = process.env

if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET || !PLUGGY_ITEM_IDS) {
  console.error('Faltam PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e/ou PLUGGY_ITEM_IDS.')
  console.error('Copie .env.example para .env e preencha, ou passe por variável de ambiente.')
  process.exit(1)
}

const itemIds = PLUGGY_ITEM_IDS.split(',').map((s) => s.trim()).filter(Boolean)
const client = new PluggyClient({ clientId: PLUGGY_CLIENT_ID, clientSecret: PLUGGY_CLIENT_SECRET })

const h = (t: string) => console.log(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}`)
const ok = (b: boolean) => (b ? 'SIM' : 'nao')

/** Trata a data como calendário: parte UTC, sem conversão de fuso. */
const calDate = (d: Date) => d.toISOString().slice(0, 10)
/** Detecta se o instante carrega hora real (≠ meia-noite UTC). */
const hasTime = (d: Date) => d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0

async function tryFetch<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    console.log(`  ${label}: ERRO -> ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

for (const itemId of itemIds) {
  h(`ITEM ${itemId.slice(0, 8)}...`)

  const item = await tryFetch('fetchItem', () => client.fetchItem(itemId))
  if (!item) continue

  console.log(`  conector       : ${item.connector?.name} (id ${item.connector?.id})`)
  console.log(`  status         : ${item.status} / execution ${item.executionStatus}`)
  console.log(`  lastUpdatedAt  : ${item.lastUpdatedAt ? new Date(item.lastUpdatedAt).toISOString() : 'nunca'}`)
  if (item.error) console.log(`  error          : ${item.error.code} - ${item.error.message}`)

  // --- Incógnita 1: quais produtos existem, via statusDetail -------------
  console.log('\n  PRODUTOS (statusDetail):')
  const detail = item.statusDetail as Record<string, { isUpdated: boolean; lastUpdatedAt: string | null } | null> | null
  if (!detail) {
    console.log('    statusDetail ausente — vou inferir pelas chamadas abaixo.')
  } else {
    for (const [produto, info] of Object.entries(detail)) {
      if (!info) { console.log(`    ${produto.padEnd(18)} -> nao disponivel`); continue }
      console.log(`    ${produto.padEnd(18)} -> isUpdated=${ok(info.isUpdated)}  lastUpdatedAt=${info.lastUpdatedAt ?? '-'}`)
    }
  }

  // --- Contas -------------------------------------------------------------
  const accounts = await tryFetch('fetchAccounts', () => client.fetchAccounts(itemId))
  const accList = accounts?.results ?? []
  console.log(`\n  CONTAS: ${accList.length}`)
  for (const a of accList) console.log(`    ${a.type}/${a.subtype ?? '-'}  saldo=${a.balance} ${a.currencyCode}`)

  // --- Incógnitas 2 e 3: datas e categorias -------------------------------
  const dtFrom = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10)
  let comHora = 0
  let total = 0
  let comCartaoMeta = 0
  let comParcela = 0
  let comPaymentData = 0
  let comMerchant = 0
  let semCategoria = 0
  const categorias = new Set<string>()
  let exemploDatas: string[] = []

  for (const a of accList) {
    const page = await tryFetch(`fetchTransactions(${a.type})`, () =>
      client.fetchTransactions(a.id, { from: dtFrom, pageSize: 200 }),
    )
    for (const t of page?.results ?? []) {
      total++
      const d = new Date(t.date)
      if (hasTime(d)) { comHora++; if (exemploDatas.length < 3) exemploDatas.push(d.toISOString()) }
      if (t.category) categorias.add(t.category); else semCategoria++
      if (t.creditCardMetadata) {
        comCartaoMeta++
        if (t.creditCardMetadata.totalInstallments && t.creditCardMetadata.totalInstallments > 1) comParcela++
      }
      if (t.paymentData) comPaymentData++
      if (t.merchant) comMerchant++
    }
  }

  console.log(`\n  TRANSACOES (ultimos 180d, ate 200/conta): ${total}`)
  console.log(`    com hora != meia-noite UTC : ${comHora}/${total}  ${comHora ? '<<< ATENCAO' : '(ok, sao datas de calendario)'}`)
  if (exemploDatas.length) console.log(`      exemplos: ${exemploDatas.join(', ')}`)
  console.log(`    com creditCardMetadata     : ${comCartaoMeta}`)
  console.log(`    parceladas (>1 parcela)    : ${comParcela}`)
  console.log(`    com paymentData (PIX/TED)  : ${comPaymentData}`)
  console.log(`    com merchant               : ${comMerchant}`)
  console.log(`    sem categoria              : ${semCategoria}`)
  console.log(`    categorias distintas (${categorias.size}):`)
  console.log(`      ${[...categorias].slice(0, 25).join(' | ') || '(nenhuma)'}`)

  // --- Produtos extras ----------------------------------------------------
  const inv = await tryFetch('fetchInvestments', () => client.fetchInvestments(itemId))
  console.log(`\n  INVESTIMENTOS: ${inv ? inv.results.length : 'indisponivel'}`)
  if (inv?.results.length) {
    const tipos = new Set(inv.results.map((i) => `${i.type}/${i.subtype ?? '-'}`))
    console.log(`    tipos: ${[...tipos].join(', ')}`)
    const first = inv.results[0]
    if (first) {
      const it = await tryFetch('fetchInvestmentTransactions', () => client.fetchInvestmentTransactions(first.id))
      console.log(`    movimentacoes no 1o investimento: ${it ? it.results.length : 'indisponivel'}`)
    }
  }

  const loans = await tryFetch('fetchLoans', () => client.fetchLoans(itemId))
  console.log(`  EMPRESTIMOS: ${loans ? loans.results.length : 'indisponivel'}`)

  const creditAccounts = accList.filter((a) => a.type === 'CREDIT')
  console.log(`  FATURAS DE CARTAO: ${creditAccounts.length} conta(s) de credito`)
  for (const a of creditAccounts) {
    const bills = await tryFetch('fetchCreditCardBills', () => client.fetchCreditCardBills(a.id))
    if (!bills) continue
    console.log(`    ${bills.results.length} fatura(s)`)
    for (const b of bills.results.slice(0, 3)) {
      console.log(`      venc ${calDate(new Date(b.dueDate))}  fech ${b.billClosingDate ? calDate(new Date(b.billClosingDate)) : '-'}  total ${b.totalAmount}  pagamentos ${b.payments?.length ?? 0}`)
    }
  }
}

h('FIM')
console.log('Cole esta saida na conversa. Ela nao contem numero de conta, CPF nem descricao de transacao.')
