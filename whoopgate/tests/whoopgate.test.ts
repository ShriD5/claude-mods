import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classify } from '../hooks/risky'

const NOW = Date.UTC(2026, 9, 4, 21, 0, 0)
const DIR = '/home/dev/.whoopgate'

type World = {
  files: Record<string, string>
  branch: string
  toasts: string[]
  statuses: (string | undefined)[]
  ran: string[]
}

// Everything beneath the plugin: a fake ~/.whoopgate, a fake shell, and a
// record of what the plugin showed.
const world = (on: On, files: Record<string, string> = {}): World => {
  const w: World = { files, branch: 'feature/login', toasts: [], statuses: [], ran: [] }
  mock.env(on, { HOME: '/home/dev' })
  on('fs.read', ($, e) => (e.path in w.files ? { value: w.files[e.path] ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.status', ($, e) => (w.statuses.push(e.text), { value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${w.branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    w.ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  return w
}

const heart = (bpm: number, secondsAgo = 1) => ({
  [`${DIR}/hr.json`]: JSON.stringify({ bpm, ts: NOW / 1000 - secondsAgo, recent: [bpm], device: 'WHOOP 4.0' }),
})

const unlocked = (secondsLeft: number) => ({
  [`${DIR}/unlock.json`]: JSON.stringify({ until: NOW / 1000 + secondsLeft }),
})

describe('classifier (ported from whoopgate)', () => {
  test('flags the risky commands', () => {
    expect(classify('npx wrangler deploy')).toBe('prod deploy')
    expect(classify('vercel --prod --yes')).toBe('prod deploy')
    expect(classify('fly deploy -a api')).toBe('prod deploy')
    expect(classify('git push --force origin feature')).toBe('force push')
    expect(classify('git push -f')).toBe('force push')
    expect(classify('git push origin main')).toBe('push to main')
    expect(classify('rm -rf ./dist')).toBe('rm -rf')
    expect(classify('rm -fr node_modules')).toBe('rm -rf')
    expect(classify('npm publish --access public')).toBe('publish')
    expect(classify('terraform apply -auto-approve')).toBe('infra change')
    expect(classify('kubectl apply -f prod.yaml')).toBe('infra change')
    expect(classify('psql $DB -c "DROP TABLE users;"')).toBe('destructive SQL')
    expect(classify('mysql -e "truncate sessions"')).toBe('destructive SQL')
    expect(classify('gh pr merge 42 --squash')).toBe('PR merge')
  })

  test('leaves everyday commands alone', () => {
    for (const command of ['ls -la', 'git push origin feature', 'npm test', 'rm notes.txt', 'wrangler dev', 'vercel', 'git status']) {
      expect(classify(command), command).toBeUndefined()
    }
  })

  test('a bare git push counts only on main, and custom rules apply', () => {
    expect(classify('git push', [], 'main')).toBe('push to main')
    expect(classify('git push', [], 'feature/x')).toBeUndefined()
    expect(classify('make release', [/make\s+release/])).toBe('custom rule')
  })
})

describe('gate', () => {
  test('blocks a deploy at 112 bpm and says how to unlock', async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, heart(112))
    const ran = await $.tool.call({ tool: 'Bash', command: 'npx wrangler deploy' })

    expect(ran.deny).toContain('112 bpm')
    expect(ran.deny).toContain('whoopgate breathe')
    expect(ran.deny).toContain('prod deploy')
    expect(w.ran).toHaveLength(0)
    expect(w.toasts).toEqual(['❤️ 112 bpm · blocked prod deploy'])
  })

  test('lets safe commands through even at 140 bpm', async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, heart(140))
    await $.tool.call({ tool: 'Bash', command: 'npm test' })

    expect(w.ran).toEqual(['npm test'])
  })

  test('lets risky commands through when calm', async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, heart(87))
    await $.tool.call({ tool: 'Bash', command: 'git push --force' })

    expect(w.ran).toEqual(['git push --force'])
  })

  test('an unlock window from `whoopgate breathe` lets it through', async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { ...heart(115), ...unlocked(90) })
    await $.tool.call({ tool: 'Bash', command: 'npm publish' })

    expect(w.ran).toEqual(['npm publish'])
  })

  test('an expired unlock window does not', async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, { ...heart(115), ...unlocked(-5) })
    const ran = await $.tool.call({ tool: 'Bash', command: 'npm publish' })

    expect(ran.deny).toContain('whoopgate blocked')
    expect(w.ran).toHaveLength(0)
  })

  test('fails open on a stale or missing heart rate', async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, heart(130, 45))
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    w.files = {}
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    w.files = { [`${DIR}/hr.json`]: 'not json' }
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

    expect(w.ran).toHaveLength(3)
  })

  test('a bare git push is blocked only on main', async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, heart(120))
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(w.ran).toEqual(['git push'])

    w.branch = 'main'
    const ran = await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(ran.deny).toContain('whoopgate blocked')
  })

  test('the threshold option moves the limit', { options: { threshold: 120 } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const w = world(on, heart(112))
    await $.tool.call({ tool: 'Bash', command: 'wrangler deploy' })

    expect(w.ran).toEqual(['wrangler deploy'])
  })
})

describe('status line and /pulse', () => {
  test('a live heart that turns into a lock, refreshed every 2 s', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = world(on, heart(87))
    on('session.start', () => ({ cwd: '/repo' }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(w.statuses.at(-1)).toBe('♥ 87')

    w.files = heart(112)
    await clock.advance(2000)
    expect(w.statuses.at(-1)).toBe('❤️ 112 · deploys locked')

    w.files = { ...heart(112), ...unlocked(100) }
    await clock.advance(2000)
    expect(w.statuses.at(-1)).toBe('♥ 112 · unlocked 1:36')

    w.files = {}
    await clock.advance(2000)
    expect(w.statuses.at(-1)).toBe('♡ whoop offline')
  })

  test('/pulse reports bpm, threshold and unlock state', async ($, on) => {
    mock.clock(on, { now: NOW })
    world(on, heart(112, 2))
    const locked = await $.command.run({ command: 'pulse', args: '', origin: { kind: 'composer' } } as never)
    expect(locked.text).toContain('112 bpm from WHOOP 4.0 (2 s ago)')
    expect(locked.text).toContain('threshold 100 bpm · risky commands BLOCKED')
    expect(locked.text).toContain('whoopgate breathe')
  })

  test('/pulse explains an offline band', async ($, on) => {
    mock.clock(on, { now: NOW })
    world(on)
    const offline = await $.command.run({ command: 'pulse', args: '', origin: { kind: 'composer' } } as never)
    expect(offline.text).toContain('No live heart rate')
    expect(offline.text).toContain('allowed')
  })
})
