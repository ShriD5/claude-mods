# standup

`/standup` writes yesterday's standup from your git commits, then copies it.

```
Yesterday
- Slots snap to the grid (app)
- Added the /slots endpoint (api)
Today
- Fix the empty slot crash
Blockers
- None
```

It reads every commit by your `git config user.email`, on all branches, since the start of yesterday, or since Friday morning when it is Saturday, Sunday or Monday. The current repo is always read; add others in the options and they are grouped by repo. A fast model turns the raw list into short bullets; commits made today count as work already under way.

```
/standup        the standup, copied to the clipboard
/standup raw    just the commit list, no model
```

Past Claude Code sessions are not part of it: the mod API has no way to read sessions other than the current one yet, so the standup is built from git alone.

## Install

```sh
claude --plugin-dir ./standup
```

or add this repo as a marketplace and install it with `/plugin`.

## Options

| option | default | what it does |
| --- | --- | --- |
| `repos` | empty | More repo paths to read, comma-separated, `~/` expanded: `~/code/api, ~/code/web`. A path that is not a repo is named and skipped. |
| `model` | `haiku` | The model that writes the standup: an alias or a full model id. |

## How it works

A `command.run` hook reads the date with `date +%Y-%m-%d %u` and the commits with `git log --all --author=<email> --since=<day> 00:00` through `$.process.run`, writes the bullets with `$.model.complete`, and copies them with `$.ui.copy`.
