# ship-log

`/ship` turns what you built in this Claude Code session into a build-in-public post.

It reads the commits and the diffstat since the session started, plus a short list of what you asked Claude for, and has a fast model write one X post: lowercase, first person, one concrete number, under 280 characters, no hashtags, no em dashes, none of the "officially / game-changer / excited to announce" voice. The draft shows up as the command's output and goes to your clipboard.

```
/ship            an X post
/ship again      another take, a different angle from the last one
/ship linkedin   a longer LinkedIn version (sentence case, short paragraphs, up to 1,300 chars)
```

A draft that still breaks a rule (too long, a banned phrase, emoji spam) is sent back once with the problems named. If it is still too long after that, it gets cut at the last sentence that fits.

## Install

```sh
claude --plugin-dir ./ship-log
```

or add this repo as a marketplace and install it with `/plugin`.

## Options

Set them in `/config` (or `pluginConfigs["ship-log"].options` in settings):

| option | default | what it does |
| --- | --- | --- |
| `model` | `haiku` | The model that writes the post: an alias (`haiku`, `sonnet`) or a full model id. |
| `webhookUrl` | empty | If set, every draft is POSTed here as `{ "platform": "x" \| "linkedin", "text": "...", "source": "ship-log" }`, so it can drop straight into a content calendar or a drafts queue. |
| `webhookToken` | empty | Sent as `Authorization: Bearer <token>` with that POST. Stored as a secret. |

## How it works

It saves `HEAD` in `$.state` on `session.start` and keeps every prompt you type (`prompt.submit`). `/ship` runs `git log <start>..HEAD` and `git diff --stat <start>` through `$.process.run`, so uncommitted work counts too, then writes the post with `$.model.complete` and copies it with `$.ui.copy`.
