/** Token counts or dollars, by kind. */
export type ChaiMeterKinds = { input: number; output: number; cacheWrite: number; cacheRead: number }

export type ChaiMeterTurn = { usd: number; label: string }

/** The running meter of one session, kept in `$.state` so a reload keeps it. */
export type ChaiMeterState = {
  sessionId: string
  tokens: ChaiMeterKinds
  /** Dollars by kind, from the price table. */
  priced: ChaiMeterKinds
  /** Claude Code's own cost total when last measured, or null where it keeps none. */
  ledgerUsd: number | null
  /** The table's total at that measurement: what was priced since is added on top. */
  pricedAtLedger: number
  /** How much of the total has been added to the all-time figure. */
  banked: number
  /** Turns still running, by turn id. */
  open: Record<string, ChaiMeterTurn>
  priciest: ChaiMeterTurn | null
  /** Models no price-table row matched (priced at the default rates). */
  unknownModels: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'chai-meter': { meter: ChaiMeterState }
  }
}
