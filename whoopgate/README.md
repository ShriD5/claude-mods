# whoopgate

Claude Code won't touch prod while your heart is racing.

This mod puts your live WHOOP heart rate in the status line (`♥ 87`) and blocks risky Bash commands while it is at or over your limit (`❤️ 112 · deploys locked`). Deploys, force pushes, `rm -rf`, publishes, PR merges, `terraform apply`, destructive SQL: the same list as the whoopgate CLI. To unlock, run `whoopgate breathe` and stay under 92 bpm for 20 seconds. That opens a 2 minute window.

It is the in-process version of whoopgate's settings hooks and status line. You still run the whoopgate daemon, which reads the band over Bluetooth.

## Install

```sh
whoopgate daemon                                  # WHOOP app > Heart Rate Broadcast on
claude --plugin-dir /path/to/claude-mods/whoopgate
```

Or add the repo as a marketplace and install it with `/plugin`. Use the mod or `whoopgate install`, not both, or every risky command is checked twice.

- Status line: `♥ 87`, `❤️ 112 · deploys locked`, `♥ 112 · unlocked 1:43`, `♡ whoop offline`. Refreshed every 2 s.
- `/pulse` shows the current bpm, the threshold and the unlock state.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `threshold` | `100` | bpm at or above which risky commands are blocked |

The mod also follows `~/.whoopgate/config.json` for `calmBpm` and `unlockSeconds` (what the deny message tells you) and `extraPatterns` (your own risky regexes), and honours `whoopgate pause`.

## Demo without a band

`sim.sh` writes a **simulated** heart rate to `~/.whoopgate/hr.json` (with `"device": "SIMULATED"`). Stop the real daemon first.

```sh
./sim.sh 120        # hold around 120 bpm
./sim.sh ramp       # climb from 80 to 125
./sim.sh unlock 60  # act as if `whoopgate breathe` worked
```

## How it works

A `$.clock.every` timer reads `~/.whoopgate/hr.json` for the status line, and a `tool.call` hook on Bash reads it again and returns `{ deny }` for a risky command while the reading is over the limit. A reading older than 30 s counts as unknown and never blocks.
