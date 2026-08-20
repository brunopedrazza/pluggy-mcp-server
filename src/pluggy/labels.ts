/**
 * Human-readable account labels.
 *
 * Pluggy's own names are not usable as-is. Every item created through Meu Pluggy
 * reports `connector.name = "MeuPluggy"`, so the connector never identifies the
 * bank. And the account names measured on real data are ambiguous or useless:
 *
 *   two checking accounts both named "XP"
 *   a credit card named "platinum"
 *   another named "BLACK"
 *   a checking account named "Nu Pagamentos S.A. - Instituição de Pagamento"
 *
 * So the bank name is taken from the item's own bank account, cleaned up, and
 * composed with the card's brand and level. Labels are derived rather than
 * configured, so a newly connected bank shows up without editing any env.
 */
import type { Account } from 'pluggy-sdk'

/** Legal-entity boilerplate that costs tokens on every row and identifies nothing. */
const BOILERPLATE = [
  /\s*-\s*institui[çc][ãa]o de pagamento\b.*$/i,
  /\s*\(conta pr[ée]-paga\)\s*$/i,
  /\s+s[./]?a\.?\s*$/i,
  /\s+ltda\.?\s*$/i,
]

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function cleanBankName(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim()
  for (const pattern of BOILERPLATE) name = name.replace(pattern, '')
  name = name.trim()
  if (!name) return raw.trim()
  // Names that arrive shouted ("BANCO INTER") read better cased; short names that
  // are genuinely acronyms ("XP", "BTG") are left alone.
  if (name === name.toUpperCase() && name.length > 4) return titleCase(name)
  return name
}

/**
 * Derives the bank name for an item from its accounts.
 *
 * Bank accounts are preferred because their name is the institution; card
 * accounts are named after the product ("BLACK") and say nothing about the bank.
 */
export function deriveBankName(accounts: Account[], fallback: string): string {
  const bank = accounts.find((a) => a.type === 'BANK' && a.name?.trim())
  if (bank?.name) return cleanBankName(bank.name)
  const anyNamed = accounts.find((a) => a.name?.trim())
  if (anyNamed?.name) return cleanBankName(anyNamed.name)
  return fallback
}

function describeAccount(account: Account, bank: string): string {
  if (account.type === 'CREDIT') {
    const brand = account.creditData?.brand ? titleCase(account.creditData.brand) : ''
    const level = account.creditData?.level ? titleCase(account.creditData.level) : ''
    const card = [brand, level].filter(Boolean).join(' ')
    return card ? `${bank} ${card}` : `${bank} Cartao`
  }
  if (account.subtype === 'SAVINGS_ACCOUNT') return `${bank} Poupanca`
  return `${bank} Conta`
}

/**
 * Builds a stable label per account id, numbering collisions.
 *
 * The numbering matters: one real item carries two checking accounts both named
 * "XP", and without a suffix the model cannot tell which balance belongs to which.
 */
export function buildAccountLabels(accounts: Account[], bank: string): Map<string, string> {
  const labels = new Map<string, string>()
  const used = new Map<string, number>()

  for (const account of accounts) {
    const base = describeAccount(account, bank)
    const seen = (used.get(base) ?? 0) + 1
    used.set(base, seen)
    labels.set(account.id, seen === 1 ? base : `${base} ${seen}`)
  }

  return labels
}
