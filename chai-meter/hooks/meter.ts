import type { TurnUsage } from 'claude-code'

import type { ChaiMeterKinds, ChaiMeterState } from '../types'
import { costOf, type Rates, ratesFor } from './prices'

// The meter's arithmetic and wording, kept pure so the tests can drive it.

export type ChaiPrice = { chaiInr: number; usdToInr: number }

const zero = (): ChaiMeterKinds => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
const sum = (kinds: ChaiMeterKinds) => kinds.input + kinds.output + kinds.cacheWrite + kinds.cacheRead

export const emptyMeter = (sessionId: string): ChaiMeterState => ({
  sessionId,
  tokens: zero(),
  priced: zero(),
  ledgerUsd: null,
  pricedAtLedger: 0,
  banked: 0,
  open: {},
  priciest: null,
  unknownModels: [],
})

/** The session's cost: Claude Code's ledger plus what the table priced since it last spoke. */
export const totalUsd = (meter: ChaiMeterState) =>
  meter.ledgerUsd === null ? sum(meter.priced) : meter.ledgerUsd + sum(meter.priced) - meter.pricedAtLedger

export function openTurn(meter: ChaiMeterState, turnId: string, label: string): ChaiMeterState {
  if (meter.open[turnId]) return meter
  return { ...meter, open: { ...meter.open, [turnId]: { usd: 0, label } } }
}

/** One model response's usage, priced and added to its turn. */
export function addStep(meter: ChaiMeterState, turnId: string, usage: TurnUsage, overrides?: Record<string, Rates>): ChaiMeterState {
  const { rates, isKnown } = ratesFor(usage.model, overrides)
  const cost = costOf(usage, rates)
  const turn = meter.open[turnId] ?? { usd: 0, label: 'a subagent turn' }
  return {
    ...meter,
    tokens: {
      input: meter.tokens.input + usage.input_tokens,
      output: meter.tokens.output + usage.output_tokens,
      cacheWrite: meter.tokens.cacheWrite + usage.cache_creation_input_tokens,
      cacheRead: meter.tokens.cacheRead + usage.cache_read_input_tokens,
    },
    priced: {
      input: meter.priced.input + cost.input,
      output: meter.priced.output + cost.output,
      cacheWrite: meter.priced.cacheWrite + cost.cacheWrite,
      cacheRead: meter.priced.cacheRead + cost.cacheRead,
    },
    open: { ...meter.open, [turnId]: { ...turn, usd: turn.usd + sum(cost) } },
    unknownModels: isKnown || meter.unknownModels.includes(usage.model) ? meter.unknownModels : [...meter.unknownModels, usage.model],
  }
}

/** A turn ended: it may be the priciest yet. */
export function closeTurn(meter: ChaiMeterState, turnId: string): ChaiMeterState {
  const turn = meter.open[turnId]
  if (!turn) return meter
  const { [turnId]: _, ...open } = meter.open
  const priciest = meter.priciest === null || turn.usd > meter.priciest.usd ? turn : meter.priciest
  return { ...meter, open, priciest }
}

/** Claude Code reported the session's cost: it becomes the base of the total. */
export const measure = (meter: ChaiMeterState, usd: number): ChaiMeterState => ({
  ...meter,
  ledgerUsd: usd,
  pricedAtLedger: sum(meter.priced),
})

/** What the output streamed so far will roughly cost (about four characters a token). */
export function streamingUsd(model: string, characters: number, overrides?: Record<string, Rates>) {
  return ((characters / 4) * ratesFor(model, overrides).rates[1]) / 1e6
}

export const cups = (usd: number, price: ChaiPrice) => (usd * price.usdToInr) / price.chaiInr

const cupsText = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)))
const usdText = (usd: number) => `$${usd.toFixed(2)}`
const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** `☕ $0.42 · ≈ 1.8 chai` */
export const statusText = (usd: number, price: ChaiPrice) => `☕ ${usdText(usd)} · ≈ ${cupsText(cups(usd, price))} chai`

/** What /chai prints. */
export function breakdown(meter: ChaiMeterState, allTimeUsd: number, price: ChaiPrice): string {
  const total = totalUsd(meter)
  const rupees = Math.round(total * price.usdToInr)
  const row = (label: string, kind: keyof ChaiMeterKinds) =>
    `  ${label.padEnd(12)}${grouped(meter.tokens[kind]).padStart(12)} tokens  ${usdText(meter.priced[kind]).padStart(8)}`
  const lines = [
    `☕ This session: ${usdText(total)} ≈ ${cupsText(cups(total, price))} chai (₹${rupees} at ₹${price.chaiInr} a cup, $1 = ₹${price.usdToInr})`,
    row('input', 'input'),
    row('output', 'output'),
    row('cache write', 'cacheWrite'),
    row('cache read', 'cacheRead'),
    meter.ledgerUsd === null
      ? '  Priced with the table in hooks/prices.ts.'
      : "  Total from Claude Code's own cost ledger; the rows above use the table in hooks/prices.ts.",
  ]
  if (meter.unknownModels.length > 0) lines.push(`  No price row for ${meter.unknownModels.join(', ')}: priced at the default rates.`)
  if (meter.priciest) lines.push(`Priciest turn: ${usdText(meter.priciest.usd)}, ${meter.priciest.label}`)
  lines.push(`All time: ${usdText(allTimeUsd)} ≈ ${cupsText(cups(allTimeUsd, price))} chai`)
  return lines.join('\n')
}

/** `"refactor the auth middleware…"`: a turn named by its prompt. */
export function turnLabel(prompt: string) {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  if (oneLine === '') return 'a turn with no prompt'
  return `"${oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine}"`
}
