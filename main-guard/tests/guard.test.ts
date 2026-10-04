import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, RenderInput } from 'claude-code'

import { decide, gitCalls, isProtected, readPush } from '../hooks/guard'

const PATTERNS = ['main', 'master', 'production', 'release*']
const SESSION = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 115, scroll: { offset: 0, bodyRows: 9 }, view: {} },
}

/** The decision for a command run on `branch`, every git call in it, first non-pass wins. */
function judge(command: string, branch: string | null = 'feature/x') {
  for (const call of gitCalls(command)) {
    const decision = decide(call, branch, PATTERNS)

    if (decision.kind !== 'pass') {
      return decision.kind === 'confirm' ? `confirm ${decision.branch}` : 'deny'
    }
  }

  return 'pass'
}

describe('reading commands', () => {
  test('protected branch globs', () => {
    expect(isProtected('main', PATTERNS)).toBe(true)
    expect(isProtected('release/2.1', PATTERNS)).toBe(true)
    expect(isProtected('mainline', PATTERNS)).toBe(false)
    expect(isProtected(null, PATTERNS)).toBe(false)
  })

  test('finds git calls behind &&, pipes, env vars, -C and bash -c', () => {
    expect(gitCalls('npm test && git push origin main | tee log').map(call => call.sub)).toEqual(['push'])
    expect(gitCalls('GIT_TRACE=1 git -C ../api -c core.x=y push')).toEqual([{ dir: '../api', sub: 'push', args: [] }])
    expect(gitCalls(`bash -c "git push -f origin main"`)[0]?.args).toEqual(['-f', 'origin', 'main'])
    expect(gitCalls("echo 'git push -f'")).toEqual([])
    expect(gitCalls('ls # git push -f')).toEqual([])
  })

  test('reads push targets and force', () => {
    expect(readPush(['origin', 'HEAD:main'])).toMatchObject({ isForce: false, targets: ['main'] })
    expect(readPush(['origin', '+feature:refs/heads/main'])).toMatchObject({ isForce: true, targets: ['main'] })
    expect(readPush(['origin', ':main'])).toMatchObject({ isDelete: true, targets: ['main'] })
    expect(readPush(['-uf', 'origin', 'x'])).toMatchObject({ isForce: true, targets: ['x'] })
    expect(readPush(['-o', 'ci.skip', 'origin', 'main'])).toMatchObject({ targets: ['main'] })
    expect(readPush(['origin', 'v1.0', 'refs/tags/v1.1'])).toMatchObject({ targets: ['v1.0'] })
    expect(readPush(['--tags'])).toMatchObject({ targets: [] })
    expect(readPush([])).toMatchObject({ targets: [null] })
  })
})

describe('decisions', () => {
  test('force pushes to a protected branch are denied, every spelling', () => {
    for (const command of [
      'git push --force origin main',
      'git push -f origin main',
      'git push --force-with-lease origin main',
      'git push --force-with-lease=main:abc123 origin main',
      'git push origin +main',
      'git push -uf origin release/2.1',
      'git push --delete origin master',
      'git push --mirror',
    ]) {
      expect(judge(command), command).toBe('deny')
    }

    expect(judge('git push -f', 'main'), 'bare force push while on main').toBe('deny')
  })

  test('force pushes to feature branches pass', () => {
    expect(judge('git push --force-with-lease origin feature/x')).toBe('pass')
    expect(judge('git push -f', 'feature/x')).toBe('pass')
  })

  test('plain pushes to a protected branch need a confirm', () => {
    expect(judge('git push origin main')).toBe('confirm main')
    expect(judge('git push', 'main')).toBe('confirm main')
    expect(judge('git push -u origin HEAD', 'master')).toBe('confirm master')
    expect(judge('git push origin feature/x:production')).toBe('confirm production')
    expect(judge('git push origin feature/x')).toBe('pass')
  })

  test('reset --hard is denied on a protected branch only', () => {
    expect(judge('git reset --hard origin/main', 'main')).toBe('deny')
    expect(judge('git reset --hard HEAD~1', 'feature/x')).toBe('pass')
    expect(judge('git reset --soft HEAD~1', 'main')).toBe('pass')
  })
})

type World = { branch: string | null; ran: string[]; asked: string[]; answer: string | undefined; clock?: MockClock }

function worldOf(on: On, world: World, env: Record<string, string> = {}, marker = false): World {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', ($, e) => ({ value: marker && e.path === '/work/.prod' }))
  on('process.run', ($, e) => {
    const args = e.argv.filter((arg, index) => index > 0 && arg !== '-C' && e.argv[index - 1] !== '-C').join(' ')
    const stdout = args === 'symbolic-ref --short -q HEAD' ? world.branch : args === 'rev-parse --show-toplevel' ? '/work' : null

    return { value: { exitCode: stdout === null ? 1 : 0, stdout: stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    world.ran.push(e.command)
    const checkout = /git (?:checkout|switch) (\S+)/.exec(e.command)

    if (checkout?.[1] !== undefined) {
      world.branch = checkout[1]
    }

    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    world.asked.push(question)

    if (world.answer === undefined) {
      throw new Error('nobody to ask')
    }

    return { result: { questions: e.questions, answers: { [question]: world.answer } }, text: world.answer }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }) as never)
  mock.env(on, env)
  world.clock = mock.clock(on)

  return world
}

const textOf = (node: unknown): string => {
  if (typeof node === 'string') {
    return node
  }

  const children = (node as { children?: unknown[] } | null)?.children ?? []

  return children.map(textOf).join('')
}

describe('the band', () => {
  test('shows the branch, a production env var and the .prod marker', async ($, on) => {
    worldOf(on, { branch: 'main', ran: [], asked: [], answer: undefined }, { NODE_ENV: 'production' }, true)
    await $.session.start(SESSION)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'main-guard', surface, component: 'AbovePrompt', props: BAND.props })
      expect((await ui.find({ type: 'Text', text: /on main · NODE_ENV=production · \.prod/ })) !== undefined).toBe(true)
      await ui.unmount()
    }
  })

  test('stays out of the way on a feature branch', async ($, on) => {
    worldOf(on, { branch: 'feature/x', ran: [], asked: [], answer: undefined })
    await $.session.start(SESSION)

    expect(textOf(await $.ui.render(BAND))).toBe('engine band')
  })

  test('comes up after a Bash call moves onto main', async ($, on) => {
    const world = worldOf(on, { branch: 'feature/x', ran: [], asked: [], answer: undefined })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'git checkout main' })
    await world.clock?.settle()

    expect(textOf(await $.ui.render(BAND))).toContain('⚠ on main')
  })
  test('notices a branch switch made outside Claude on the slow clock', async ($, on) => {
    const world = worldOf(on, { branch: 'feature/x', ran: [], asked: [], answer: undefined })
    await $.session.start(SESSION)
    world.branch = 'production'
    await world.clock?.advance(15_000)

    expect(textOf(await $.ui.render(BAND))).toContain('⚠ on production')
  })
})

describe('the Bash gate', () => {
  test('a force push to main never reaches the shell', async ($, on) => {
    const world = worldOf(on, { branch: 'feature/x', ran: [], asked: [], answer: undefined })
    await $.session.start(SESSION)
    const result = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })

    expect(JSON.stringify(result)).toContain('rewrites history')
    expect(world.ran).toEqual([])
  })

  test('a plain push to main runs once the user says yes', async ($, on) => {
    const world = worldOf(on, { branch: 'main', ran: [], asked: [], answer: 'Push to main' })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'git push' })

    expect(world.asked).toEqual(['Push straight to main?'])
    expect(world.ran).toEqual(['git push'])
  })

  test('a cancelled push is denied', async ($, on) => {
    const world = worldOf(on, { branch: 'main', ran: [], asked: [], answer: 'Cancel' })
    await $.session.start(SESSION)
    const result = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })

    expect(JSON.stringify(result)).toContain('cancelled by the user')
    expect(world.ran).toEqual([])
  })

  test('with nobody to ask, the push is denied with what to do instead', async ($, on) => {
    const world = worldOf(on, { branch: 'main', ran: [], asked: [], answer: undefined })
    await $.session.start(SESSION)
    const result = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })

    expect(JSON.stringify(result)).toContain('open a PR')
    expect(world.ran).toEqual([])
  })

  test('confirmPushes off refuses without asking', { options: { confirmPushes: false } }, async ($, on) => {
    const world = worldOf(on, { branch: 'main', ran: [], asked: [], answer: 'Push to main' })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'git push' })

    expect(world.asked).toEqual([])
    expect(world.ran).toEqual([])
  })

  test('a custom protected list is honoured', { options: { protectedBranches: 'trunk, deploy/*' } }, async ($, on) => {
    const world = worldOf(on, { branch: 'main', ran: [], asked: [], answer: undefined })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'git push -f origin main' })
    const blocked = await $.tool.call({ tool: 'Bash', command: 'git push -f origin deploy/eu' })

    expect(world.ran).toEqual(['git push -f origin main'])
    expect(JSON.stringify(blocked)).toContain('deploy/eu')
  })
})
