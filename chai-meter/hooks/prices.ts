import type { ModelUsage } from 'claude-code'

/** US dollars per million tokens: [input, output, cache write (5 min), cache read]. */
export type Rates = readonly [input: number, output: number, cacheWrite: number, cacheRead: number]

// UPDATE ME when prices change: Anthropic API list prices as of 2026-09-25.
// Cache writes are the 5-minute rate (1.25x input). Claude Code's own cost
// ledger wins whenever the session has one; this table prices the live tick
// and the per-turn breakdown. Override any row with the `priceOverrides`
// option instead of editing this file.
export const PRICES: Record<string, Rates> = {
  'claude-fable-5-1': [10, 50, 12.5, 0.25],
  'claude-mythos-5-1': [10, 50, 12.5, 0.25],
  'claude-fable-5': [10, 50, 12.5, 1],
  'claude-mythos-5': [10, 50, 12.5, 1],
  'claude-opus-5-5': [4, 20, 5, 0.2],
  'claude-opus-5': [5, 25, 6.25, 0.5],
  'claude-opus-4-8': [5, 25, 6.25, 0.5],
  'claude-opus-4-7': [5, 25, 6.25, 0.5],
  'claude-opus-4-6': [5, 25, 6.25, 0.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2],
  'claude-sonnet-5': [2, 10, 2.5, 0.2],
  'claude-sonnet-4-6': [3, 15, 3.75, 0.3],
  'claude-haiku-4-5': [1, 5, 1.25, 0.1],
}

/** What a model no row matches is priced at. */
export const DEFAULT_RATES: Rates = PRICES['claude-opus-5-5']!

/** `us.anthropic.claude-opus-5-5-20260101[1m]` -> `claude-opus-5-5-20260101`. */
export const normalizeModel = (model: string) =>
  model
    .toLowerCase()
    .replace(/\[.*\]$/, '')
    .replace(/@.*$/, '')
    .replace(/^(?:[a-z]+\.)*(?=claude-)/, '')

/** The rates for a model id: the longest table key it starts with. */
export function ratesFor(model: string, overrides: Record<string, Rates> = {}): { rates: Rates; isKnown: boolean } {
  const id = normalizeModel(model)
  const table = { ...PRICES, ...overrides }
  const key = Object.keys(table)
    .filter(prefix => id === prefix || id.startsWith(`${prefix}-`))
    .sort((a, b) => b.length - a.length)[0]
  return key ? { rates: table[key]!, isKnown: true } : { rates: DEFAULT_RATES, isKnown: false }
}

/** Dollars by kind for one response's usage. */
export function costOf(usage: ModelUsage, rates: Rates) {
  const [input, output, cacheWrite, cacheRead] = rates
  return {
    input: (usage.input_tokens * input) / 1e6,
    output: (usage.output_tokens * output) / 1e6,
    cacheWrite: (usage.cache_creation_input_tokens * cacheWrite) / 1e6,
    cacheRead: (usage.cache_read_input_tokens * cacheRead) / 1e6,
  }
}

/** `{"claude-opus-5-5": [4, 20, 5, 0.2]}` from the option; bad rows dropped. */
export function parseOverrides(json: string): { overrides: Record<string, Rates>; error?: string } {
  if (json.trim() === '') return { overrides: {} }
  try {
    const parsed: unknown = JSON.parse(json)
    const overrides: Record<string, Rates> = {}
    for (const [model, rates] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(rates) && rates.length === 4 && rates.every(n => typeof n === 'number' && n >= 0)) {
        overrides[normalizeModel(model)] = rates as unknown as Rates
      }
    }
    return { overrides }
  } catch {
    return { overrides: {}, error: 'priceOverrides is not JSON; using the built-in prices' }
  }
}
