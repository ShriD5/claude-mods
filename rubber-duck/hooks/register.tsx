import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DuckConcern } from '../types'
import { basename, changeOf, concernOf, isSkippable, MAX_FILE_BYTES, promptOf, SYSTEM, type Change } from './duck'

const PANE = 'rubber-duck'
const KEEP = 20
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

const concerns = atom({ plugin: 'rubber-duck', key: 'concerns' } as const, [] as DuckConcern[])
const unsent = atom({ plugin: 'rubber-duck', key: 'unsent' } as const, [] as DuckConcern[])

type Settings = { model: string; tellClaude: boolean }

// At most one review in flight per file: a newer edit made meanwhile waits,
// and only the latest one waiting is reviewed next.
const inFlight = new Set<string>()
const waiting = new Map<string, Change>()

const review = async ($: EngineInterface, change: Change, settings: Settings) => {
  try {
    const stat = await $.fs.stat(change.file).catch(() => undefined)
    if (stat !== undefined && stat.size > MAX_FILE_BYTES) return
    const reply = await $.model.complete({
      model: settings.model,
      system: SYSTEM,
      prompt: promptOf(change),
      maxTokens: 60,
      effort: 'low',
      timeoutMs: 20_000,
    })
    if (!reply.isAnswered) return $.ui.log(`rubber-duck: no review (${reply.reason})`, { to: 'debug' })
    const concern = concernOf(reply.text)
    if (concern === undefined) return

    const flagged: DuckConcern = { file: change.file, concern, at: await $.clock.now() }
    await update($, concerns, list => [...list, flagged].slice(-KEEP))
    if (settings.tellClaude) await update($, unsent, list => [...list, flagged].slice(-KEEP))
    $.ui.toast(`🦆 ${concern} (${basename(change.file)})`, { timeoutMs: 8000 })
  } catch (error) {
    $.ui.log(`rubber-duck: review failed: ${String(error)}`, { to: 'debug' })
  }
}

const reviewFile = async ($: EngineInterface, first: Change, settings: Settings) => {
  let change: Change | undefined = first
  while (change !== undefined) {
    await review($, change, settings)
    change = waiting.get(first.file)
    waiting.delete(first.file)
  }
  inFlight.delete(first.file)
}

const timeOf = (at: number) => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    model: String(options.model || 'haiku'),
    tellClaude: options.tellClaude === true,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'duck', description: "Show the rubber duck's recent concerns" })
    return next(e)
  })

  // React after a successful edit; the review runs on a timer so the tool
  // call returns at once and a slow or failed review never touches it.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!EDIT_TOOLS.has(String(e.tool)) || ran.deny !== undefined || ran.isError) return ran
    const change = changeOf(e as unknown as Record<string, unknown>, ran.result)
    if (change === undefined || isSkippable(change.file)) return ran

    if (inFlight.has(change.file)) {
      waiting.set(change.file, change)
    } else {
      inFlight.add(change.file)
      $.clock.after(0, () => void reviewFile($, change, settings))
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (!settings.tellClaude) return next(e)
    const pending = await read($, unsent)
    if (pending.length === 0) return next(e)

    await update($, unsent, () => [])
    const note = [
      'rubber-duck (a quick second-opinion reviewer on a small model) flagged these in your recent edits.',
      "Check each one: fix it if it's real, and say so briefly if it's a false alarm.",
      ...pending.map(one => `- ${one.file}: ${one.concern}`),
    ].join('\n')

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('command.run', { command: 'duck' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Rubber duck' })
    const count = (await read($, concerns)).length

    return { text: `🦆 ${count} concern${count === 1 ? '' : 's'} in the duck pane.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, concerns)

    return (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 && <Text dimColor>No concerns yet. Quack.</Text>}
        {[...list].reverse().map(one => (
          <Box flexDirection="column">
            <Text>
              <Text dimColor>{timeOf(one.at)}</Text> <Text bold>{basename(one.file)}</Text>
            </Text>
            <Text>{one.concern}</Text>
          </Box>
        ))}
        {list.length > 0 && (
          <Box>
            <Button key="clear" label="Clear" hotkey="c" onPress={() => update($, concerns, () => [])} />
          </Box>
        )}
      </Box>
    )
  })
}
