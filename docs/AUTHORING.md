# Writing a Claude Code mod (notes for builders in this repo)

Written against Claude Code 2.1.289. The authoritative API is the TypeScript declaration file Claude Code writes beside a mod once it loads it (`<mod>/.claude-plugin/types/claude-code/index.d.ts`). Grep it for event names like 'tool.call', 'tool.check', 'turn.complete', 'session.start', `$.http.fetch`, `$.model.complete`, `$.ui.status`, `$.ui.toast`, `$.command.register`, `Pane: {`, `AbovePrompt`). Ask Claude Code to "make a mod" and it loads the official authoring guide and examples.

Each mod is its own folder `<repo>/<mod-name>/` with:
- `.claude-plugin/plugin.json`: `{ "name": "<mod-name>", "version": "0.1.0", "description": "<one line>" }` (+ `"types": "./types/index.d.ts"` if it uses `$.state`, + `userConfig` for options like tokens)
- `hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`
- `hooks/register.tsx` (or .ts): `export const register: Register = (on, options) => { ... }` with `import type { Register } from 'claude-code'`
- optional `types/index.d.ts` declaring `interface PluginState` values under the mod's name
- at least one `*.test.ts` for the core behaviour

A hook is `($, e, next)`. Return without `next` to answer for yourself (`{ deny: '...' }` on tool.call), `next({ ...e, ... })` to rewrite, `await next(e)` to react. No DOM, no Node: everything via `$` (`$.fs`, `$.process.run`, `$.http.fetch`, `$.model.complete`, `$.clock`, `$.store`, `$.state`). JSX uses the global `h`; elements come from `$.ui.resolve(e)`.

Check every mod with:
- `claude plugin validate <mod folder>`
- type-check: once Claude Code has loaded the mod, `npx tsc -p <mod folder>`
- `claude plugin test <mod folder>`

Run a mod for real: `claude --plugin-dir <mod folder>` (one flag per folder).
