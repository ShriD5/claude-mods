import type { EngineInterface, Register } from 'claude-code'

import type { ChaiMeterState } from '../types'
import {
  addStep,
  breakdown,
  type ChaiPrice,
  closeTurn,
  emptyMeter,
  measure,
  openTurn,
  statusText,
  streamingUsd,
  totalUsd,
  turnLabel,
} from './meter'
import { costOf, parseOverrides, ratesFor } from './prices'

const METER = { plugin: 'chai-meter', key: 'meter' } as const
const ALL_TIME = 'allTimeUsd'

// The session's meter, mirrored from $.state (which outlives a hot reload).
let meter: ChaiMeterState | undefined
// What responses still streaming will roughly add, by step.
const streaming = new Map<string, number>()
// The input side of each loop's last response: the meter's flag drop for the next one.
const lastInputUsd = new Map<string, number>()
let shown = ''

async function ensureLoaded($: EngineInterface) {
  const sessionId = await $.session.id()
  if (meter?.sessionId === sessionId) return
  const { value } = await $.state.get(METER)
  meter = value?.sessionId === sessionId ? value : emptyMeter(sessionId)
}

function show($: EngineInterface, price: ChaiPrice) {
  if (!meter) return
  let usd = totalUsd(meter)
  for (const estimate of streaming.values()) usd += estimate
  const text = statusText(usd, price)
  if (text !== shown) $.ui.status((shown = text))
}

/** Applies a change to the meter, saves it, adds what it cost to all time. */
async function change($: EngineInterface, price: ChaiPrice, apply: (meter: ChaiMeterState) => ChaiMeterState) {
  await ensureLoaded($)
  meter = apply(meter!)
  const total = totalUsd(meter)
  const added = total - meter.banked
  if (added > 0) meter = { ...meter, banked: total }
  await $.state.set(METER, meter)
  show($, price)
  if (added > 0) await $.store.set(ALL_TIME, Number((await $.store.get(ALL_TIME)) ?? 0) + added)
}

export const register: Register = (on, options) => {
  const price: ChaiPrice = {
    chaiInr: Number(options.chaiPriceInr) > 0 ? Number(options.chaiPriceInr) : 20,
    usdToInr: Number(options.usdToInr) > 0 ? Number(options.usdToInr) : 84,
  }
  const { overrides, error } = parseOverrides(String(options.priceOverrides ?? ''))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'chai', description: "This session's cost in tokens, dollars and cups of chai" })
    if (error) $.ui.toast(`☕ ${error}`)
    const { cost } = await $.session.usage().catch(() => ({ cost: undefined }))
    await change($, price, m => (cost && m.ledgerUsd === null ? measure(m, cost.usd) : m))
    return next(e)
  })

  on('command.run', { command: 'chai' }, async $ => {
    await ensureLoaded($)
    const allTime = Number((await $.store.get(ALL_TIME)) ?? 0)
    return { text: breakdown(meter!, allTime, price) }
  })

  on('turn.start', async ($, e, next) => {
    await change($, price, m => openTurn(m, e.turnId, turnLabel(e.text)))
    return next(e)
  })

  // Ticks while the response streams: the input side of the loop's last
  // response the moment the request goes, then the output as it arrives.
  // The response's real usage replaces the estimate when it ends.
  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId ?? 'main'
    const step = `${loop}:${e.turnId}:${e.index}`
    const flagDrop = lastInputUsd.get(loop) ?? 0
    let characters = 0
    streaming.set(step, flagDrop)
    show($, price)

    const stream = next(e)
    try {
      for await (const chunk of stream) {
        if (chunk.kind === 'text' || chunk.kind === 'thinking') characters += chunk.text.length
        if (chunk.kind === 'input') characters += chunk.json.length
        streaming.set(step, flagDrop + streamingUsd(e.model, characters, overrides))
        show($, price)
        yield chunk
      }
    } finally {
      streaming.delete(step)
    }

    const result = await stream.result
    const usage = result.usage
    if (usage) {
      const cost = costOf(usage, ratesFor(usage.model, overrides).rates)
      lastInputUsd.set(loop, cost.input + cost.cacheWrite + cost.cacheRead)
      await change($, price, m => addStep(openTurn(m, e.turnId, e.agentId ? 'a subagent turn' : 'a turn'), e.turnId, usage, overrides))
    } else {
      show($, price)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await change($, price, m => closeTurn(m, e.turnId))
    return next(e)
  })

  // Claude Code's own ledger, after each turn: it corrects the table's estimate.
  on('session.measure', async ($, e, next) => {
    const cost = e.cost
    if (cost) await change($, price, m => measure(m, cost.usd))
    return next(e)
  })
}
