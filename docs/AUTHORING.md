# Writing a Claude Code mod (notes for builders in this repo)

Claude Code 2.1.289. Authoritative API: docs/claude-code.d.ts (grep it for event names like 'tool.call', 'tool.check', 'turn.complete', 'session.start', `$.http.fetch`, `$.model.complete`, `$.ui.status`, `$.ui.toast`, `$.command.register`, `Pane: {`, `AbovePrompt`). Long form: docs/mods-reference.md. Examples: docs/examples/ (band.tsx, pane.tsx, tool-call.ts and their *-state.d.ts contracts).

Each mod is its own folder `<repo>/<mod-name>/` with:
- `.claude-plugin/plugin.json`: `{ "name": "<mod-name>", "version": "0.1.0", "description": "<one line>" }` (+ `"types": "./types/index.d.ts"` if it uses `$.state`, + `userConfig` for options like tokens)
- `hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`
- `hooks/register.tsx` (or .ts): `export const register: Register = (on, options) => { ... }` with `import type { Register } from 'claude-code'`
- optional `types/index.d.ts` declaring `interface PluginState` values under the mod's name
- at least one `*.test.ts` for the core behaviour

A hook is `($, e, next)`. Return without `next` to answer for yourself (`{ deny: '...' }` on tool.call), `next({ ...e, ... })` to rewrite, `await next(e)` to react. No DOM, no Node: everything via `$` (`$.fs`, `$.process.run`, `$.http.fetch`, `$.model.complete`, `$.clock`, `$.store`, `$.state`). JSX uses the global `h`; elements come from `$.ui.resolve(e)`.

Check every mod with:
- `claude plugin validate <mod folder>`
- type-check: write a tsconfig OUTSIDE the mod folder using the tsconfig from the header of docs/claude-code.d.ts, `include` naming docs/claude-code.d.ts and the mod's hooks dir, then `npx tsc -p <that tsconfig>`
- `claude plugin test <mod folder>`

Run a mod for real: `claude --plugin-dir <mod folder>` (one flag per folder).
