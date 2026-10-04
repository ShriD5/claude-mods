/** One thing the duck flagged: the file, the concern, and when (ms since the epoch). */
export type DuckConcern = { file: string; concern: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    // `concerns`: the last 20, for the /duck pane. `unsent`: not yet told to Claude.
    'rubber-duck': { concerns: DuckConcern[]; unsent: DuckConcern[] }
  }
}
