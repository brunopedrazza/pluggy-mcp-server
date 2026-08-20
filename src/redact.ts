/**
 * Sanitising for untrusted text.
 *
 * Transaction descriptions are written by whoever sent the money. Anyone can
 * transfer R$0.01 with a description crafted to look like an instruction, and
 * that text flows straight into the context of an agent that may hold bash and
 * file-write tools. Stripping control characters also keeps the TSV grid intact.
 */

/** C0 and C1 control characters, including the tabs and newlines that break TSV. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * Bidirectional overrides. These can visually reorder a description so it reads
 * differently to a human than it parses, which is a cheap way to disguise text.
 */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * Collapses whitespace, removes control and bidirectional-override characters,
 * and caps length.
 */
export function sanitize(text: string | null | undefined, maxLength = 80): string {
  if (!text) return ''
  const cleaned = text.replace(CONTROL, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`
}
