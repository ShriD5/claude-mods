export type ShipPlatform = 'x' | 'linkedin'

/** Where the session started: the HEAD it started on (null in a repo with no commits yet) and when. */
export type ShipStart = { sha: string | null; at: number }

/** The last draft /ship wrote, so `/ship again` knows what to move away from. */
export type ShipDraft = { platform: ShipPlatform; text: string }

declare module 'claude-code' {
  interface PluginState {
    'ship-log': {
      start: ShipStart | null
      prompts: string[]
      last: ShipDraft | null
    }
  }
}
