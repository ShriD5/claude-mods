/** Milliseconds since the epoch. */
export type EpochMs = number

// Night mode's session values: whether `/night off` switched it off, and
// until when "yes, ship it" lets risky commands run without asking.
declare module 'claude-code' {
  interface PluginState {
    'night-mode': { isOff: boolean; shipUntil: EpochMs }
  }
}
