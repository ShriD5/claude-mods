import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isBetween, localTime, minutesOf, spoken } from '../hooks/clock'

const UTC = { options: { timezone: 'UTC' } }
const at = (hour: number, minute = 0) => Date.UTC(2026, 9, 5, hour, minute)

type World = {
  answer: string | undefined // what the person picks in the dialog; undefined: dismissed
  questions: string[]
  ran: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  context: readonly string[]
}

const world = (on: On): World => {
  const w: World = { answer: 'Run it', questions: [], ran: [], toasts: [], statuses: [], context: [] }
  mock.env(on, {})
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.status', ($, e) => (w.statuses.push(e.text), { value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    w.questions.push(question)
    if (w.answer === undefined) return { deny: 'The user dismissed the question' }
    return { result: { questions: e.questions, answers: { [question]: w.answer } } } as never
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    w.ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  on('prompt.submit', ($, e) => ((w.context = e.context ?? []), { text: e.text, context: e.context }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  return w
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const night = ($: Engine, args: string) =>
  $.command.run({ command: 'night', args, origin: { kind: 'composer' } } as never)
const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
const FACTS = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: ['Bash'],
  outputStyle: null,
  traits: [],
} as const
const sectionIds = async ($: Engine) => (await $.prompt.compose(FACTS)).sections.map(s => s.id)

describe('clock', () => {
  test('windows wrap past midnight', () => {
    expect(isBetween({ hour: 2, minute: 41 }, 60, 300)).toBe(true)
    expect(isBetween({ hour: 5, minute: 0 }, 60, 300)).toBe(false)
    expect(isBetween({ hour: 0, minute: 59 }, 60, 300)).toBe(false)
    expect(isBetween({ hour: 23, minute: 30 }, 23 * 60, 6 * 60)).toBe(true)
    expect(isBetween({ hour: 3, minute: 0 }, 23 * 60, 6 * 60)).toBe(true)
    expect(isBetween({ hour: 12, minute: 0 }, 23 * 60, 6 * 60)).toBe(false)
  })

  test('reads times and speaks them', () => {
    expect(minutesOf('01:00')).toBe(60)
    expect(minutesOf('5')).toBe(300)
    expect(minutesOf('23:30')).toBe(1410)
    expect(minutesOf('25:00')).toBeUndefined()
    expect(minutesOf('late')).toBeUndefined()
    expect(spoken({ hour: 2, minute: 41 })).toBe('2:41am')
    expect(spoken({ hour: 0, minute: 5 })).toBe('12:05am')
    expect(spoken({ hour: 13, minute: 0 })).toBe('1:00pm')
    expect(localTime(at(20, 30), 'Asia/Kolkata')).toEqual({ hour: 2, minute: 0 })
  })
})

describe('risky commands at night', () => {
  test('asks first, and runs when the person says so', UTC, async ($, on) => {
    mock.clock(on, { now: at(2, 41) })
    const w = world(on)
    await bash($, 'npx wrangler deploy')

    expect(w.questions).toEqual(["It's 2:41am. Run this prod deploy (npx wrangler deploy)?"])
    expect(w.ran).toEqual(['npx wrangler deploy'])
  })

  test('"Not tonight" holds it with the 2:41am message', UTC, async ($, on) => {
    mock.clock(on, { now: at(2, 41) })
    const w = world(on)
    w.answer = 'Not tonight'
    const held = await bash($, 'git push --force origin main')

    expect(held.deny).toContain("it's 2:41am. if you're sure, run it yourself or reply 'yes, ship it'")
    expect(held.deny).toContain('force push')
    expect(w.ran).toHaveLength(0)
  })

  test('with nobody to ask, it is held too', UTC, async ($, on) => {
    mock.clock(on, { now: at(3, 5) })
    const w = world(on)
    w.answer = undefined
    const held = await bash($, 'rm -rf ./data')

    expect(held.deny).toContain("it's 3:05am")
    expect(w.ran).toHaveLength(0)
  })

  test('safe commands and daytime deploys never ask', UTC, async ($, on) => {
    const clock = mock.clock(on, { now: at(2, 41) })
    const w = world(on)
    await bash($, 'npm test')
    await clock.set(at(14, 0))
    await bash($, 'vercel --prod')

    expect(w.questions).toHaveLength(0)
    expect(w.ran).toEqual(['npm test', 'vercel --prod'])
  })

  test('"yes, ship it" clears risky commands for 10 minutes', UTC, async ($, on) => {
    const clock = mock.clock(on, { now: at(2, 41) })
    const w = world(on)
    await say($, 'yes, ship it')
    expect(w.context.join('\n')).toContain('the person confirmed')
    expect(w.toasts).toHaveLength(1)

    await bash($, 'npm publish')
    expect(w.questions).toHaveLength(0)
    expect(w.ran).toEqual(['npm publish'])

    await clock.advance(11 * 60_000)
    await bash($, 'npm publish')
    expect(w.questions).toHaveLength(1)
  })

  test('"yes, ship it" in the daytime is just a prompt', UTC, async ($, on) => {
    mock.clock(on, { now: at(15, 0) })
    const w = world(on)
    await say($, 'yes, ship it')

    expect(w.context).toHaveLength(0)
    expect(w.toasts).toHaveLength(0)
  })

  test('a custom window and time zone', { options: { start: '23:00', end: '06:00', timezone: 'Asia/Kolkata' } }, async ($, on) => {
    mock.clock(on, { now: at(18, 0) }) // 23:30 in Kolkata
    const w = world(on)
    await bash($, 'terraform apply')

    expect(w.questions).toEqual(["It's 11:30pm. Run this infra change (terraform apply)?"])
  })
})

describe('prompt, status line and /night', () => {
  test('adds a careful section to the system prompt at night only', UTC, async ($, on) => {
    const clock = mock.clock(on, { now: at(1, 30) })
    world(on)
    const composed = await $.prompt.compose(FACTS)
    const section = composed.sections.at(-1)

    expect(section?.id).toBe('night-mode:late')
    expect(section?.scope).toBe('session')
    expect(section?.text).toContain('Prefer reversible steps')

    await clock.set(at(9, 0))
    expect(await sectionIds($)).toEqual(['intro'])
  })

  test('shows a moon until 05:00, then clears it', UTC, async ($, on) => {
    const clock = mock.clock(on, { now: at(4, 59) })
    const w = world(on)
    on('session.start', () => ({ cwd: '/repo' }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(w.statuses.at(-1)).toBe('🌙 night mode until 05:00')

    await clock.advance(60_000)
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  test('/night off turns it off for the session, /night on brings it back', UTC, async ($, on) => {
    mock.clock(on, { now: at(2, 0) })
    const w = world(on)
    const off = await night($, 'off')
    expect(off.text).toContain('off for the rest of this session')
    expect(w.statuses.at(-1)).toBeUndefined()

    await bash($, 'wrangler deploy')
    expect(w.questions).toHaveLength(0)
    expect(await sectionIds($)).toEqual(['intro'])

    const back = await night($, 'on')
    expect(back.text).toContain("it's 2:00am")
    expect(w.statuses.at(-1)).toBe('🌙 night mode until 05:00')
    expect(await sectionIds($)).toContain('night-mode:late')
  })
})
