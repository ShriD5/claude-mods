/** Why the band is up: the protected branch, a production env var, a .prod marker. Empty: no band. */
export type GuardState = { branch: string | null; reasons: string[] }

declare module 'claude-code' {
  interface PluginState {
    'main-guard': { guard: GuardState | null }
  }
}
