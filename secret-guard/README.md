# secret-guard

Stops Claude from writing secrets into files. When a Write, Edit, MultiEdit or NotebookEdit would put a real-looking credential into a file, or a Bash command would `echo`, `printf`, `tee` or heredoc one into a file, the call is refused. Claude is told what it found and on which line, and to read the value from an environment variable instead, with the value kept in a gitignored `.env`. The secret itself is never repeated back.

```
🔒 secret-guard blocked a GitHub token in config.ts
```

It catches:

- AWS access keys (`AKIA…`, `ASIA…`)
- Anthropic keys (`sk-ant-…`), OpenAI keys (`sk-proj-…`, legacy `sk-…`), and other long `sk-…` keys
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`)
- Slack tokens (`xoxb-`, `xoxp-`, …) and Slack webhook URLs
- Stripe live keys (`sk_live_`, `rk_live_`)
- Google API keys (`AIza…`)
- private key blocks (`-----BEGIN … PRIVATE KEY-----` with a key body)
- database URLs with an inline password (`postgres://`, `mysql://`, `mongodb+srv://`, `redis://`, `amqp://`)

It lets these through:

- **Placeholders**: `xxxx`, `your-key-here`, `<api-key>`, `${VAR}`, `process.env.X`, `AKIA…EXAMPLE`, low-variety strings.
- **Dev defaults**: database URLs to `localhost` or a docker service name, documentation hosts like `example.com`, and default passwords like `postgres:postgres`.
- **Secrets the file already holds**: editing next to an existing key isn't blocked.
- **Env files**: `.env`, `.env.local`, `.env.production` and `.dev.vars`, which is where the deny message tells Claude to put secrets. `.env.example`, `.env.sample` and `.env.template` are still guarded, because those get committed.

**CLAUDE.md and AGENTS.md get extra-strict checks.** In those files any credential-named assignment with a random-looking value (`api_key: "q8Zr…"`) is blocked too. The deny reason also tells Claude why: these files are often committed and public, and in a public sample of 25,784 CLAUDE.md files, 275 contained real-looking secrets.

Run `/secret-guard` to see how many secrets it has blocked so far, broken down by type.

## Install

```sh
claude --plugin-dir ./secret-guard
```

or add this repo as a marketplace and install it with `/plugin`.

## Options

None. The rules live in `hooks/detect.ts`. Each one is a regex for a format a real service issues, followed by placeholder checks.

## How it works

A `tool.call` hook reads the text a file tool is about to write, or the files a Bash command redirects into, and runs the detector on it. If anything new turns up, it answers `{ deny }` so the tool never runs. The running count is kept in `$.store`.
