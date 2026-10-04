# night-mode

Between 01:00 and 05:00, Claude Code gets more careful.

- Claude's system prompt gets a short section: it's late, double-check anything destructive, prefer reversible steps, summarise the risks before acting.
- Risky Bash commands stop and ask you first: `It's 2:41am. Run this prod deploy (wrangler deploy)?` That covers deploys (`wrangler deploy`, `vercel --prod`, `fly deploy`), `kubectl apply`, `terraform apply`, `git push --force`, `rm -rf`, `npm publish` and `DROP`/`TRUNCATE` in SQL. If nobody can answer (`claude -p`) or you pick "Not tonight", the command is held with: `it's 2:41am. if you're sure, run it yourself or reply 'yes, ship it'`.
- Reply `yes, ship it` and risky commands run without asking for 10 minutes.
- The status line shows `🌙 night mode until 05:00` while it's on.
- `/night off` turns it off for the rest of the session. `/night on` brings it back, and `/night` says where things stand.

## Install

```sh
claude --plugin-dir /path/to/claude-mods/night-mode
```

Or add the repo as a marketplace and install it with `/plugin`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `start` | `01:00` | local time night mode turns on |
| `end` | `05:00` | local time it turns off (a window can wrap past midnight, e.g. `23:00` to `06:00`) |
| `timezone` | empty | an IANA zone like `Asia/Kolkata`; empty uses `$TZ`, then the machine's clock |

## How it works

A `prompt.compose` hook appends a `session`-scoped section at night, a `tool.call` hook on Bash classifies the command and confirms it through `$.ui.ask`, which works in every permission mode, and a `$.clock.every` timer keeps the status line current.
