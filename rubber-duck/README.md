# rubber-duck

A fast second opinion on every edit Claude makes.

After each successful Edit, MultiEdit or Write, the change goes to a small, fast model (Haiku by default) with one question: is there a real problem here? It looks for removed error handling, a deleted or disabled test, a swallowed exception, a hardcoded secret or URL, an off-by-one, a changed public signature, or a TODO left in. If it finds one you get a toast:

```
🦆 Removed error handling around fetch (api.ts)
```

Otherwise it stays quiet. `/duck` opens a pane with the last 20 concerns (time, file, concern) and a Clear button.

It never blocks or slows the edit: the review runs after the tool call has returned, and if it fails, nothing happens (details go to the debug log). At most one review per file runs at a time; if Claude edits a file again meanwhile, only the latest edit gets reviewed next. Lockfiles, build output (`dist/`, `node_modules/`, ...), minified or generated files, and files over 200 KB are skipped.

## Install

```sh
claude --plugin-dir /path/to/claude-mods/rubber-duck
```

Or add the repo as a marketplace and install it with `/plugin`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `model` | `haiku` | the review model: an alias or a full model id |
| `tellClaude` | `false` | also pass new concerns to Claude with your next prompt, so it can fix them or call them false alarms |

## How it works

A `tool.call` hook awaits `next(e)`, takes the diff from the tool's own patch, and starts the review on a `$.clock.after` timer, which calls `$.model.complete`. Concerns live in `$.state`, which the `/duck` pane reads, and with `tellClaude` on a `prompt.submit` hook adds them to your next prompt as context.
