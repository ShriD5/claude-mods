# main-guard

Puts a red band above the prompt whenever you are somewhere you can hurt production, and stops Claude from doing the irreversible git things there.

```
 ⚠ on main · NODE_ENV=production   force-push and reset --hard are blocked
```

The band comes up when any of these is true:

- the current git branch is protected (`main`, `master`, `production`, `release*` by default)
- `NODE_ENV`, `RAILS_ENV`, `APP_ENV` or `ENVIRONMENT` is `prod` / `production`
- a `.prod` marker file sits in the working directory or the repo root

On every Bash call Claude makes, main-guard reads the git commands out of it (through `&&`, pipes, `git -C dir`, env prefixes and `bash -c "..."`) and:

| command | on a protected branch |
| --- | --- |
| `git push --force` / `-f` / `--force-with-lease` / `+refspec` | denied |
| `git push --delete` / `:branch`, `git push --mirror` | denied |
| `git reset --hard` | denied |
| plain `git push` (to `main`, `HEAD:main`, or while on `main`) | asks you first: "Push straight to main?" |

A denied call never reaches the shell; Claude gets the reason and a better route (push a branch, open a PR, `git switch -c rescue` before resetting). If there is nobody to ask (a `-p` run), the plain push is denied with the same advice.

## Install

```sh
claude --plugin-dir ./main-guard
```

or add this repo as a marketplace and install it with `/plugin`.

## Options

| option | default | what it does |
| --- | --- | --- |
| `protectedBranches` | `main, master, production, release*` | Comma-separated; `*` matches anything, so `release*` covers `release/2.1`. |
| `confirmPushes` | `true` | Off: plain pushes to a protected branch are refused outright instead of asking. |

## How it works

A `tool.call` hook on Bash parses the command and answers `{ deny }` or asks with `$.ui.ask` before calling `next`; the band is an `AbovePrompt` render of state refreshed on `session.start`, after every Bash call and every 15 s on `$.clock.every`.

This is a seatbelt for an agent, not a security boundary: a command that builds a git call at run time (`eval`, a script file) is not read.
