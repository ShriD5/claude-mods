# chai-meter

A taxi meter for your Claude Code session, in the status line:

```
☕ $0.42 · ≈ 1.8 chai
```

The meter jumps when a request goes out and ticks up while the response streams. When the response ends, it settles on the real usage. After each turn it lines up with Claude Code's own cost ledger.

`/chai` prints the breakdown:

```
☕ This session: $0.74 ≈ 3.1 chai (₹62 at ₹20 a cup, $1 = ₹84)
  input              1,500 tokens     $0.01
  output            32,000 tokens     $0.64
  cache write       10,000 tokens     $0.05
  cache read       200,000 tokens     $0.04
  Priced with the table in hooks/prices.ts.
Priciest turn: $0.64, "now rewrite the whole billing module in Rust ple…"
All time: $10.74 ≈ 45 chai
```

The session total is kept in `$.state`, so a reload doesn't reset it. The all-time total is kept in `$.store` and carries across sessions.

## Install

```sh
claude --plugin-dir ./chai-meter
```

or add this repo as a marketplace and install it with `/plugin`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `chaiPriceInr` | `20` | Rupees per cup of chai. |
| `usdToInr` | `84` | Rupees per US dollar. |
| `priceOverrides` | `""` | JSON of model id to `[input, output, cache write, cache read]` dollars per million tokens, e.g. `{"claude-opus-5-5": [4, 20, 5, 0.2]}`. Rows you leave out keep the built-in prices. |

The built-in prices live in `hooks/prices.ts`, one row per model. They are Anthropic API list prices as of 2026-09-25, so update them when prices change. Wherever Claude Code keeps a cost ledger, the session total comes from that ledger. The table only prices the live tick and the per-kind and per-turn rows. A model with no row is priced at Opus 5.5 rates, and `/chai` says so.

## How it works

A streaming `turn.step` hook estimates the response as it arrives: the previous request's input cost, plus about four characters per output token. It then adds the response's real `usage`, priced from the table. Each `session.measure` sets the base to Claude Code's own `cost.usd`. `turn.start` and `turn.complete` attribute cost to each turn so `/chai` can name the priciest one.
