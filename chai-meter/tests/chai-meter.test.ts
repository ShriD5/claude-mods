import type { On, TurnStepChunk, TurnUsage } from 'claude-code'
import { describe, type Engine, expect, mock, test } from 'claude-code/testing'

import { cups, statusText, turnLabel } from '../hooks/meter'
import { costOf, normalizeModel, parseOverrides, ratesFor } from '../hooks/prices'

const OPUS = 'claude-opus-5-5'
const usage = (input: number, output: number, cacheWrite = 0, cacheRead = 0, model = OPUS): TurnUsage => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
})

// The world beneath the plugin: the session, its ledger, the store, the status line.
function world(on: On, store: Record<string, unknown> = {}, ledgerUsd?: number) {
  const status: (string | undefined)[] = []
  mock.store(on, store)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], ...(ledgerUsd === undefined ? {} : { cost: { usd: ledgerUsd } }) },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { status }
}

// One model response: the text streams in pieces, then the stop with its usage.
function respond(on: On, pieces: string[], spent: TurnUsage) {
  on('turn.step', async function* (_$, e) {
    for (const text of pieces) yield { kind: 'text', index: 0, text } satisfies TurnStepChunk
    yield { kind: 'stop', stopReason: 'end_turn', usage: spent } satisfies TurnStepChunk
    return { turnId: e.turnId, index: e.index, answer: pieces.join(''), toolUses: [], stopReason: 'end_turn', usage: spent }
  })
}

async function turn($: Engine, turnId: string, prompt: string) {
  await $.turn.start({ turnId, text: prompt })
  for await (const _ of $.turn.step({ turnId, index: 0, model: OPUS, messageCount: 1 })) {
    // read the stream to its end, as the engine does
  }
  await $.turn.complete({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
}

const chai = ($: Engine) =>
  $.command.run({ command: 'chai', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

describe('the meter', () => {
  test('ticks while the response streams, then settles on the real usage', async ($, on) => {
    const { status } = world(on)
    respond(on, ['x'.repeat(40_000), 'y'.repeat(40_000)], usage(10_000, 25_000))

    await turn($, 't1', 'write the report')

    // 40k characters ≈ 10k tokens ≈ $0.20, then 80k ≈ $0.40, then the real $0.04 + $0.50
    expect(status).toEqual([
      '☕ $0.00 · ≈ 0.0 chai',
      '☕ $0.20 · ≈ 0.8 chai',
      '☕ $0.40 · ≈ 1.7 chai',
      '☕ $0.54 · ≈ 2.3 chai',
    ])
  })

  test('starts the next request at the last one’s input cost (the flag drop)', async ($, on) => {
    const { status } = world(on)
    respond(on, [], usage(0, 0, 0, 1_000_000)) // a million cache-read tokens: $0.20

    await turn($, 't1', 'one')
    await turn($, 't2', 'two')

    expect(status).toEqual(['☕ $0.00 · ≈ 0.0 chai', '☕ $0.20 · ≈ 0.8 chai', '☕ $0.40 · ≈ 1.7 chai'])
  })

  test("builds on Claude Code's own ledger when the session has one", async ($, on) => {
    const { status } = world(on, {}, 1)
    respond(on, [], usage(100_000, 0)) // $0.40 by the table

    await $.session.start({ cwd: '/app', surface: 'terminal', isInteractive: true })
    await turn($, 't1', 'one')
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 1.5 }, changed: ['cost'] })

    expect(status).toEqual(['☕ $1.00 · ≈ 4.2 chai', '☕ $1.40 · ≈ 5.9 chai', '☕ $1.50 · ≈ 6.3 chai'])
  })

  test('/chai breaks the session down and names the priciest turn', async ($, on) => {
    world(on, { allTimeUsd: 10 })
    let calls = 0
    on('turn.step', async function* (_$, e) {
      const spent = ++calls === 1 ? usage(1_000, 2_000, 10_000, 0) : usage(500, 30_000, 0, 200_000)
      yield { kind: 'stop', stopReason: 'end_turn', usage: spent } satisfies TurnStepChunk
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: spent }
    })

    await turn($, 't1', 'fix the flaky login test')
    await turn($, 't2', 'now   rewrite the whole\nbilling module in Rust please, carefully and with tests')

    expect((await chai($)).text).toBe(
      [
        '☕ This session: $0.74 ≈ 3.1 chai (₹62 at ₹20 a cup, $1 = ₹84)',
        '  input              1,500 tokens     $0.01',
        '  output            32,000 tokens     $0.64',
        '  cache write       10,000 tokens     $0.05',
        '  cache read       200,000 tokens     $0.04',
        '  Priced with the table in hooks/prices.ts.',
        'Priciest turn: $0.64, "now rewrite the whole billing module in Rust ple…"',
        'All time: $10.74 ≈ 45 chai',
      ].join('\n'),
    )
  })

  test('uses the configured chai price and exchange rate', { options: { chaiPriceInr: 10, usdToInr: 90 } }, async ($, on) => {
    const { status } = world(on)
    respond(on, [], usage(250_000, 0)) // $1.00

    await turn($, 't1', 'one')

    expect(status.at(-1)).toBe('☕ $1.00 · ≈ 9.0 chai')
  })
})

describe('prices', () => {
  test('normalizes provider spellings of a model id', () => {
    expect(normalizeModel('us.anthropic.claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(normalizeModel('claude-opus-4-6@20260101')).toBe('claude-opus-4-6')
    expect(ratesFor('claude-opus-5-5-20261001').rates).toEqual([4, 20, 5, 0.2])
    expect(ratesFor('claude-opus-5').rates).toEqual([5, 25, 6.25, 0.5])
    expect(ratesFor('claude-sonnet-5-5').rates).toEqual([2, 10, 2.5, 0.2])
    expect(ratesFor('anthropic.claude-haiku-4-5-v1:0').rates).toEqual([1, 5, 1.25, 0.1])
  })

  test('falls back to the default rates for an unknown model, and says so', () => {
    expect(ratesFor('claude-unknown-9')).toEqual({ rates: [4, 20, 5, 0.2], isKnown: false })
  })

  test('prices each kind of token', () => {
    expect(costOf(usage(1e6, 1e6, 1e6, 1e6), [4, 20, 5, 0.2])).toEqual({ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 })
  })

  test('takes overrides as JSON, dropping malformed rows', () => {
    const { overrides } = parseOverrides('{"claude-opus-5-5": [1, 2, 3, 4], "bad": [1, 2]}')
    expect(overrides).toEqual({ 'claude-opus-5-5': [1, 2, 3, 4] })
    expect(ratesFor(OPUS, overrides).rates).toEqual([1, 2, 3, 4])
    expect(parseOverrides('not json').error).toContain('not JSON')
    expect(parseOverrides('')).toEqual({ overrides: {} })
  })
})

describe('wording', () => {
  test('cups and the status line', () => {
    expect(cups(1, { chaiInr: 20, usdToInr: 84 })).toBe(4.2)
    expect(statusText(0.42, { chaiInr: 20, usdToInr: 84 })).toBe('☕ $0.42 · ≈ 1.8 chai')
    expect(statusText(12, { chaiInr: 20, usdToInr: 84 })).toBe('☕ $12.00 · ≈ 50 chai')
  })

  test('turn labels', () => {
    expect(turnLabel('  fix\nthe bug ')).toBe('"fix the bug"')
    expect(turnLabel('')).toBe('a turn with no prompt')
  })
})
