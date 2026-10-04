import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fit, parseArgs, problemsOf, tidy } from '../hooks/post'

const SESSION = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const ship = (args = '') => ({ command: 'ship', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })
const prompt = (text: string, kind: 'composer' | 'task-notification' = 'composer') => ({ text, wait: false, origin: { kind } })

type World = {
  git: Record<string, string>
  asked: string[]
  replies: string[]
  copied: string[]
  posted: { url: string; body: string; auth: string | undefined }[]
}

/** The engine beneath ship-log: git answers from a table, the model from a queue. */
function worldOf(on: On, git: Record<string, string>, replies: string[]): World {
  const world: World = { git, asked: [], replies, copied: [], posted: [] }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const key = e.argv.slice(1).join(' ')
    const stdout = world.git[key]

    return { value: { exitCode: stdout === undefined ? 128 : 0, stdout: stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    world.asked.push(e.prompt)
    const text = world.replies.shift() ?? 'built a thing'

    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as never
  })
  on('ui.copy', ($, e) => {
    world.copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('http.fetch', ($, e) => {
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    world.posted.push({ url: e.url, body: e.init?.body ?? '', auth: headers.authorization })

    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } } as never
  })

  return world
}

const GIT = {
  'rev-parse --verify -q HEAD': 'aaa111',
  'log --oneline --no-merges aaa111..HEAD': 'bbb222 feat: snap rickshaw slots to the grid\nccc333 fix: empty slot list crashed the scheduler',
  'diff --stat aaa111': ' src/slots.ts | 42 ++++++++++++++------\n src/scheduler.ts | 7 ++--\n 2 files changed, 37 insertions(+), 12 deletions(-)',
}

describe('/ship', () => {
  test('drafts an X post from the session commits, diffstat and prompts, and copies it', async ($, on) => {
    const world = worldOf(on, GIT, ['Shipped the slot grid today — 2 files, 37 lines. #buildinpublic'])
    mock.clock(on, { now: 0 })

    await $.session.start(SESSION)
    await $.prompt.submit(prompt('make the slots snap to a grid'))
    await $.prompt.submit(prompt('a background task finished', 'task-notification'))
    const ran = await $.command.run(ship())

    const asked = world.asked[0] ?? ''
    expect(asked).toContain('feat: snap rickshaw slots to the grid')
    expect(asked).toContain('2 files changed, 37 insertions(+), 12 deletions(-)')
    expect(asked).toContain('- make the slots snap to a grid')
    expect(asked).not.toContain('a background task finished')

    expect(world.copied).toEqual(['shipped the slot grid today, 2 files, 37 lines.'])
    expect(ran.text).toContain('shipped the slot grid today, 2 files, 37 lines.')
    expect(ran.text).toContain('copied to clipboard')
    expect(ran.text).toContain('/ship linkedin')
    expect(world.posted).toEqual([])
  })

  test('/ship again asks for a different angle than the last draft', async ($, on) => {
    const world = worldOf(on, GIT, ['first take on the grid', 'second take on the grid'])
    mock.clock(on)

    await $.session.start(SESSION)
    await $.command.run(ship())
    const again = await $.command.run(ship('again'))

    expect(world.asked[1]).toContain('different angle')
    expect(world.asked[1]).toContain('first take on the grid')
    expect(again.text).toContain('second take on the grid')
  })

  test('/ship linkedin asks for the LinkedIn voice and keeps sentence case', async ($, on) => {
    const world = worldOf(on, GIT, ['I rebuilt the slot grid today.\n\nIt took 37 lines.'])
    mock.clock(on)

    await $.session.start(SESSION)
    const ran = await $.command.run(ship('linkedin'))

    expect(world.asked[0]).toContain('LinkedIn post')
    expect(world.copied[0]).toBe('I rebuilt the slot grid today.\n\nIt took 37 lines.')
    expect(ran.text).toContain('/1300 chars')
  })

  test('a draft that breaks the rules is retried once with the problems named', async ($, on) => {
    const world = worldOf(on, GIT, ['officially shipped the grid', 'shipped the grid, 37 lines'])
    mock.clock(on)

    await $.session.start(SESSION)
    const ran = await $.command.run(ship())

    expect(world.asked.length).toBe(2)
    expect(world.asked[1]).toContain('"officially"')
    expect(ran.text).toContain('shipped the grid, 37 lines')
  })

  test('nothing built yet: says so without calling the model', async ($, on) => {
    const world = worldOf(on, { 'rev-parse --verify -q HEAD': 'aaa111', 'log --oneline --no-merges aaa111..HEAD': '', 'diff --stat aaa111': '' }, [])
    mock.clock(on)

    await $.session.start(SESSION)
    const ran = await $.command.run(ship())

    expect(ran.text).toContain('Nothing to ship yet')
    expect(world.asked).toEqual([])
  })

  test('a repo with no commits at the start falls back to recent history', async ($, on) => {
    const world = worldOf(on, { 'log --oneline --no-merges -n 15': 'ddd444 feat: first commit', 'diff --stat HEAD': '' }, ['made the first commit'])
    mock.clock(on)

    await $.session.start(SESSION)
    await $.command.run(ship())

    expect(world.asked[0]).toContain('feat: first commit')
  })

  test('posts the draft to the webhook when one is set', { options: { webhookUrl: 'https://calendar.example/hook', webhookToken: 'tok' } }, async ($, on) => {
    const world = worldOf(on, GIT, ['shipped the grid'])
    mock.clock(on)

    await $.session.start(SESSION)
    const ran = await $.command.run(ship())

    expect(world.posted).toEqual([{ url: 'https://calendar.example/hook', body: JSON.stringify({ platform: 'x', text: 'shipped the grid', source: 'ship-log' }), auth: 'Bearer tok' }])
    expect(ran.text).toContain('sent to webhook (200)')
  })
})

describe('post helpers', () => {
  test('parseArgs reads the platform and again', () => {
    expect(parseArgs('', undefined)).toEqual({ platform: 'x', isAgain: false })
    expect(parseArgs('linkedin', undefined)).toEqual({ platform: 'linkedin', isAgain: false })
    expect(parseArgs('again', 'linkedin')).toEqual({ platform: 'linkedin', isAgain: true })
    expect(parseArgs('again x', 'linkedin')).toEqual({ platform: 'x', isAgain: true })
  })

  test('tidy strips prefaces, quotes, hashtags and dashes, and lowercases X posts', () => {
    expect(tidy('Here is a post:\n"Built the GRID — finally. #dev #buildinpublic"', 'x')).toBe('built the grid, finally.')
    expect(tidy('Built the grid.\n\n\n\nIt works.', 'linkedin')).toBe('Built the grid.\n\nIt works.')
  })

  test('problemsOf flags length, banned phrases and emoji spam', () => {
    expect(problemsOf('a'.repeat(281), 'x')[0]).toContain('281 characters')
    expect(problemsOf('this is a game-changer', 'x')).toEqual(['it uses "game-changer"'])
    expect(problemsOf('done 🚀🔥', 'x')).toEqual(['it has more than one emoji'])
    expect(problemsOf('done 🚀', 'x')).toEqual([])
  })

  test('fit cuts at a sentence when it can', () => {
    expect(fit('one two three four. five six seven eight', 25)).toBe('one two three four.')
    expect(fit('one two three four five six', 12)).toBe('one two')
    expect(fit('short', 20)).toBe('short')
  })
})
