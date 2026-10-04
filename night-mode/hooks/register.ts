import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptComposeSection, Register } from 'claude-code'

import { clockText, isBetween, localTime, minutesOf, spoken, type LocalTime } from './clock'
import { classify, shorten } from './risky'

const isOff = atom({ plugin: 'night-mode', key: 'isOff' } as const, false)
const shipUntil = atom({ plugin: 'night-mode', key: 'shipUntil' } as const, 0)

const SHIP_MINUTES = 10
const YES_SHIP_IT = /^\W*yes,?\s+ship\s+it\b/i
const RUN_IT = 'Run it'

type Night = { start: number; end: number; timeZone: string }

const sectionOf = (night: Night): PromptComposeSection => ({
  id: 'night-mode:late',
  scope: 'session',
  text: [
    '# Night mode',
    `It is late at night for the person you are working with (between ${clockText(night.start)} and ${clockText(night.end)} their time), when tired mistakes are easy to make. Be more careful than usual:`,
    '- Double-check anything destructive or hard to undo (deletes, force pushes, migrations, deploys, publishes) before you run it, and say what it will do.',
    '- Prefer reversible steps: a branch over main, a preview deploy over production, a backup or dry run before the real thing.',
    '- Before risky work, summarise the risks in a sentence or two and let the person decide.',
    '- Keep replies short and clear. If something can safely wait until morning, say so.',
  ].join('\n'),
})

/** The local time when night mode is on and it is night, else undefined. */
const nightTime = async ($: EngineInterface, night: Night): Promise<LocalTime | undefined> => {
  if (await read($, isOff)) return undefined
  const zone = night.timeZone || (await $.env.get('TZ'))
  const time = localTime(await $.clock.now(), zone)

  return isBetween(time, night.start, night.end) ? time : undefined
}

const showStatus = async ($: EngineInterface, night: Night) => {
  const time = await nightTime($, night)
  const isCleared = (await read($, shipUntil)) > (await $.clock.now())
  const status = `🌙 night mode until ${clockText(night.end)}${isCleared ? ' · cleared to ship' : ''}`

  $.ui.status(time ? status : undefined)
}

const nightCommand = async ($: EngineInterface, night: Night, args: string): Promise<string> => {
  const hours = `${clockText(night.start)}–${clockText(night.end)}`
  if (args === 'off') {
    await update($, isOff, () => true)
    return 'Night mode is off for the rest of this session. `/night on` brings it back.'
  }
  if (args === 'on') await update($, isOff, () => false)
  if (await read($, isOff)) return `Night mode is off for this session (\`/night on\` to resume; hours ${hours}).`
  const time = await nightTime($, night)

  return time
    ? `Night mode is on: it's ${spoken(time)}, careful until ${clockText(night.end)}. \`/night off\` to stop.`
    : `Night mode is on and wakes up between ${hours} local time.`
}

export const register: Register = (on, options) => {
  const night: Night = {
    start: minutesOf(String(options.start)) ?? 60,
    end: minutesOf(String(options.end)) ?? 300,
    timeZone: String(options.timezone ?? '').trim(),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'night',
      description: 'Night mode: show it, or turn it off or on for this session',
      argumentHint: 'off | on',
    })
    await showStatus($, night)
    $.clock.every(30_000, () => void showStatus($, night).catch(() => undefined))

    return next(e)
  })

  on('command.run', { command: 'night' }, async ($, e) => {
    const text = await nightCommand($, night, e.args.trim().toLowerCase())
    await showStatus($, night)

    return { text }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await nightTime($, night))) return composed

    return { sections: [...composed.sections, sectionOf(night)] }
  })

  // "yes, ship it" from the person clears risky commands for a few minutes.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isPerson || !YES_SHIP_IT.test(e.text) || !(await nightTime($, night))) return next(e)

    const until = (await $.clock.now()) + SHIP_MINUTES * 60_000
    await update($, shipUntil, () => until)
    $.ui.toast(`🌙 ok: risky commands run without asking for ${SHIP_MINUTES} minutes`)
    await showStatus($, night)
    const note = `night-mode: the person confirmed ("yes, ship it"). Risky commands run without asking for the next ${SHIP_MINUTES} minutes; you may retry the one that was held.`

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const label = classify(e.command)
    if (label === undefined) return next(e)
    const time = await nightTime($, night)
    if (!time || (await read($, shipUntil)) > (await $.clock.now())) return next(e)

    const when = spoken(time)
    const command = shorten(e.command, 60)
    const answer = await $.ui
      .ask(`It's ${when}. Run this ${label} (${command})?`, {
        header: 'Night mode',
        options: [RUN_IT, 'Not tonight'],
      })
      .catch(() => undefined) // dismissed, or nobody to ask (claude -p)
    if (answer === RUN_IT || (answer !== undefined && YES_SHIP_IT.test(answer))) return next(e)

    return {
      deny: [
        `night mode held this ${label} (\`${shorten(e.command)}\`): it's ${when}. if you're sure, run it yourself or reply 'yes, ship it'.`,
        "Tell the person exactly that. Don't retry it or work around it with another command; carry on with anything that doesn't need it.",
      ].join('\n'),
    }
  })
}
