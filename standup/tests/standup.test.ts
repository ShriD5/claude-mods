import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { label, parseLog, rawList, repoPaths, sinceDay, tidy } from '../hooks/days'

const SESSION = { cwd: '/work/app', surface: 'terminal' as const, isInteractive: true }
const standup = (args = '') => ({ command: 'standup', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })

const APP_LOG = ['b2c3d4e\t2026-10-05 09:12\tfix: empty slot list crashed the scheduler', 'a1b2c3d\t2026-10-02 16:40\tfeat: snap slots to the grid'].join('\n')
const API_LOG = 'c3d4e5f\t2026-10-03 11:00\tfeat: add /slots endpoint'

type World = { argv: string[][]; prompts: string[]; copied: string[] }

/** The machine beneath standup: a Monday, two repos, one path that is no repo. */
function worldOf(on: On, logs: Record<string, string> = { '/work/app': APP_LOG, '/home/me/api': API_LOG }, email = 'me@example.com'): World {
  const world: World = { argv: [], prompts: [], copied: [] }
  const roots: Record<string, string> = { '/work/app': '/work/app', '/work/app/src': '/work/app', '/home/me/api': '/home/me/api' }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    world.argv.push([...e.argv])
    const [program, , dir = '', sub] = e.argv
    let stdout: string | undefined

    if (program === 'date') {
      stdout = '2026-10-05 1'
    } else if (e.argv[1] === 'config') {
      stdout = email
    } else if (sub === 'rev-parse') {
      stdout = roots[dir]
    } else if (sub === 'log') {
      stdout = logs[dir] ?? ''
    }

    return { value: { exitCode: stdout === undefined ? 128 : 0, stdout: stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    world.prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: 'Sure, here it is:\n\n**Yesterday**\n- Slots snap to the grid (app)\n- Added /slots endpoint (api)\nToday\n- Fix the empty slot crash\nBlockers\n- None',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    } as never
  })
  on('ui.copy', ($, e) => {
    world.copied.push(e.text)

    return { value: { isCopied: true } }
  })
  mock.env(on, { HOME: '/home/me' })

  return world
}

describe('/standup', () => {
  test('on a Monday it reads every repo since Friday and writes Yesterday / Today / Blockers', { options: { repos: '~/api' } }, async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const ran = await $.command.run(standup())

    const logs = world.argv.filter(argv => argv.includes('log'))
    expect(logs.map(argv => argv[2])).toEqual(['/work/app', '/home/me/api'])
    expect(logs[0]).toContain('--since=2026-10-02 00:00')
    expect(logs[0]).toContain('--author=me@example.com')

    expect(world.prompts[0]).toContain('since Fri 2 Oct (today is Mon 5 Oct)')
    expect(world.prompts[0]).toContain('app (2)')
    expect(world.prompts[0]).toContain('today 09:12  fix: empty slot list crashed the scheduler')
    expect(world.prompts[0]).toContain('api (1)')

    const expected = 'Yesterday\n- Slots snap to the grid (app)\n- Added /slots endpoint (api)\nToday\n- Fix the empty slot crash\nBlockers\n- None'
    expect(world.copied).toEqual([expected])
    expect(ran.text).toContain(expected)
    expect(ran.text).toContain('copied to clipboard · from 3 commits since Fri 2 Oct')
  })

  test('/standup raw lists the commits and skips the model', { options: { repos: '~/api' } }, async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const ran = await $.command.run(standup('raw'))

    expect(world.prompts).toEqual([])
    expect(ran.text).toBe(
      [
        '3 commits by me@example.com since Fri 2 Oct',
        '',
        'app (2)',
        '  a1b2c3d  Fri 16:40  feat: snap slots to the grid',
        '  b2c3d4e  today 09:12  fix: empty slot list crashed the scheduler',
        '',
        'api (1)',
        '  c3d4e5f  Sat 11:00  feat: add /slots endpoint',
      ].join('\n'),
    )
  })

  test('no commits: says so, no model call', { options: { repos: '~/api' } }, async ($, on) => {
    const world = worldOf(on, {})
    await $.session.start(SESSION)
    const ran = await $.command.run(standup())

    expect(ran.text).toBe('No commits by me@example.com since Fri 2 Oct in app, api.')
    expect(world.prompts).toEqual([])
  })

  test('without other repos configured, only the current one is read', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.command.run(standup('raw'))

    expect(world.argv.filter(argv => argv.includes('log')).map(argv => argv[2])).toEqual(['/work/app'])
  })

  test('no git email: explains instead of guessing', async ($, on) => {
    worldOf(on, undefined, '')
    await $.session.start(SESSION)
    const ran = await $.command.run(standup())

    expect(ran.text).toContain('git config --global user.email')
  })
})

describe('configured repos', () => {
  test('a path that is no repo is named and skipped; one repo twice is read once', { options: { repos: '~/api, /work/app/src, /nowhere' } }, async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const ran = await $.command.run(standup('raw'))

    expect(world.argv.filter(argv => argv.includes('log')).length).toBe(2)
    expect(ran.text).toContain('not a git repo, skipped: /nowhere')
  })
})

describe('helpers', () => {
  test('the window: yesterday, or Friday from Saturday to Monday', () => {
    expect(sinceDay('2026-10-05', 1)).toBe('2026-10-02')
    expect(sinceDay('2026-10-04', 7)).toBe('2026-10-02')
    expect(sinceDay('2026-10-03', 6)).toBe('2026-10-02')
    expect(sinceDay('2026-10-07', 3)).toBe('2026-10-06')
    expect(sinceDay('2026-03-02', 1)).toBe('2026-02-27')
    expect(sinceDay('2026-01-01', 4)).toBe('2025-12-31')
  })

  test('labels, log lines and paths', () => {
    expect(label('2026-10-02')).toBe('Fri 2 Oct')
    expect(parseLog('abc\t2026-10-02 16:40\tfeat: a\tb\n\n')).toEqual([{ sha: 'abc', day: '2026-10-02', time: '16:40', subject: 'feat: a\tb' }])
    expect(repoPaths('~/a, /b\n ~', '/home/me')).toEqual(['/home/me/a', '/b', '/home/me'])
    expect(rawList([{ repo: 'empty', commits: [] }], '2026-10-05')).toBe('')
  })

  test('tidy keeps the three sections only', () => {
    expect(tidy('Here you go!\n## Yesterday\n- **Shipped** it — finally\nToday\n- more')).toBe('Yesterday\n- Shipped it, finally\nToday\n- more')
  })
})
