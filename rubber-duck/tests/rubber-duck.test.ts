import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { changeOf, concernOf, isSkippable } from '../hooks/duck'

const REMOVED_TRY = {
  oldStart: 10,
  oldLines: 5,
  newStart: 10,
  newLines: 1,
  lines: [
    '-  try {',
    '-    return await fetch(url)',
    '-  } catch (error) {',
    '-    log(error)',
    '-  }',
    '+  return await fetch(url)',
  ],
}

type World = {
  clock: MockClock
  replies: string[] // what the review model answers, in order; then OK
  isDown: boolean // the review model is unreachable
  prompts: string[]
  toasts: string[]
  sizes: Record<string, number>
  context: readonly string[]
  opened: string[]
}

const world = (on: On): World => {
  const w: World = {
    clock: mock.clock(on, { now: Date.UTC(2026, 9, 4, 18, 30) }),
    replies: [],
    isDown: false,
    prompts: [],
    toasts: [],
    sizes: {},
    context: [],
    opened: [],
  }
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.complete', ($, e) => {
    w.prompts.push(e.prompt)
    if (w.isDown) return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } }
    return { value: { isAnswered: true, text: w.replies.shift() ?? 'OK', usage } }
  })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: w.sizes[e.path] ?? 2048, mtimeMs: 0, isLink: false } }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($, e) => (w.opened.push(e.id), { value: { isPlaced: true } }))
  on('prompt.submit', ($, e) => ((w.context = e.context ?? []), { text: e.text, context: e.context }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Edit' && e.file_path.endsWith('broken.ts')) {
      return { isError: true, result: 'old_string not found', text: 'old_string not found' }
    }
    if (e.tool === 'Edit') {
      const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${e.old_string}`, `+${e.new_string}`] }
      return { result: { filePath: e.file_path, structuredPatch: [e.old_string === 'a' ? REMOVED_TRY : hunk] } } as never
    }
    return { result: { type: 'create', filePath: 'x', structuredPatch: [] } } as never
  })
  return w
}

const edit = ($: Engine, file_path: string, old_string = 'a', new_string = 'b') =>
  $.tool.call({ tool: 'Edit', file_path, old_string, new_string })
const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

describe('what the duck reads', () => {
  test('skips lockfiles, build output and minified files', () => {
    const skipped = ['package-lock.json', 'yarn.lock', 'Cargo.lock', 'pnpm-lock.yaml', 'dist/app.js', 'node_modules/x/i.js', 'web/app.min.js', 'api.generated.ts']
    for (const file of skipped.map(name => `/r/${name}`)) {
      expect(isSkippable(file), file).toBe(true)
    }
    for (const file of ['/r/src/api.ts', '/r/README.md', '/r/src/distance.ts', '/r/lib/builder.py']) {
      expect(isSkippable(file), file).toBe(false)
    }
  })

  test('builds the diff from the tool patch, else from the input', () => {
    const fromPatch = changeOf({ file_path: '/r/api.ts' }, { structuredPatch: [REMOVED_TRY] })
    expect(fromPatch?.diff).toContain('@@ -10,5 +10,1 @@')
    expect(fromPatch?.diff).toContain('-  } catch (error) {')

    const fromInput = changeOf({ file_path: '/r/a.ts', old_string: 'x <= n', new_string: 'x < n' }, {})
    expect(fromInput?.diff).toBe('-x <= n\n+x < n')

    expect(changeOf({ file_path: '/r/a.ts', content: 'hi' }, { staged: true })).toBeUndefined()
    expect(changeOf({ file_path: '/r/a.ts', content: 'x'.repeat(300_000) }, {})).toBeUndefined()
    expect(changeOf({ file_path: '/r/a.ts', old_string: '', new_string: '' }, {})).toBeUndefined()
  })

  test('reads OK as nothing and keeps one short concern', () => {
    expect(concernOf('OK')).toBeUndefined()
    expect(concernOf(' ok. ')).toBeUndefined()
    expect(concernOf('')).toBeUndefined()
    expect(concernOf('"Removed error handling around fetch"\nMore words.')).toBe('Removed error handling around fetch')
    expect(concernOf('Okay-ish: hardcoded API key')).toBe('Okay-ish: hardcoded API key')
    expect(concernOf('x'.repeat(300))?.length).toBe(140)
  })
})

describe('reviews after each edit', () => {
  test('a real concern becomes a toast and a pane entry', async ($, on) => {
    const w = world(on)
    w.replies = ['Removed error handling around fetch']
    const ran = await edit($, '/repo/src/api.ts')
    expect(ran.isError).toBeUndefined()
    expect(w.prompts).toHaveLength(0) // the tool call returned before the review ran

    await w.clock.settle()
    expect(w.prompts[0]).toContain('File: /repo/src/api.ts')
    expect(w.prompts[0]).toContain('-  } catch (error) {')
    expect(w.toasts).toEqual(['🦆 Removed error handling around fetch (api.ts)'])

    const pane = await $.ui.mount({ plugin: 'rubber-duck', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Text', text: 'Removed error handling around fetch' })).toBeDefined()
  })

  test('OK stays quiet', async ($, on) => {
    const w = world(on)
    await edit($, '/repo/src/api.ts')
    await w.clock.settle()

    expect(w.prompts).toHaveLength(1)
    expect(w.toasts).toHaveLength(0)
  })

  test('skips lockfiles, failed edits and files over 200 KB', async ($, on) => {
    const w = world(on)
    w.sizes['/repo/src/huge.ts'] = 300 * 1024
    await edit($, '/repo/package-lock.json')
    await edit($, '/repo/src/broken.ts')
    await edit($, '/repo/src/huge.ts')
    await w.clock.settle()

    expect(w.prompts).toHaveLength(0)
  })

  test('one review in flight per file; the latest waiting edit goes next', async ($, on) => {
    const w = world(on)
    await edit($, '/repo/a.ts', 'one', 'ONE')
    await edit($, '/repo/a.ts', 'two', 'TWO')
    await edit($, '/repo/a.ts', 'three', 'THREE')
    await edit($, '/repo/b.ts', 'bee', 'BEE')
    await w.clock.settle()

    const forA = w.prompts.filter(p => p.includes('/repo/a.ts'))
    expect(forA).toHaveLength(2)
    expect(forA[0]).toContain('+ONE')
    expect(forA[1]).toContain('+THREE')
    expect(w.prompts.filter(p => p.includes('/repo/b.ts'))).toHaveLength(1)
  })

  test('a failed model call is silent', async ($, on) => {
    const w = world(on)
    w.isDown = true
    await edit($, '/repo/src/api.ts')
    await w.clock.settle()

    expect(w.prompts).toHaveLength(1)
    expect(w.toasts).toHaveLength(0)
  })
})

describe('telling Claude', () => {
  test('off by default', async ($, on) => {
    const w = world(on)
    w.replies = ['Deleted the only test for parse()']
    await edit($, '/repo/src/parse.test.ts')
    await w.clock.settle()
    await say($, 'next step')

    expect(w.context).toHaveLength(0)
  })

  test('when on, new concerns ride along with the next prompt, once', { options: { tellClaude: true } }, async ($, on) => {
    const w = world(on)
    w.replies = ['Deleted the only test for parse()']
    await edit($, '/repo/src/parse.test.ts')
    await w.clock.settle()

    await say($, 'next step')
    expect(w.context.join('\n')).toContain('- /repo/src/parse.test.ts: Deleted the only test for parse()')
    await say($, 'and the next')
    expect(w.context).toHaveLength(0)
  })
})

const PANE = {
  component: 'Pane',
  requestId: 'rubber-duck',
  props: {
    title: 'Rubber duck',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

describe('/duck pane', () => {
  test('/duck opens the pane', async ($, on) => {
    const w = world(on)
    const out = await $.command.run({ command: 'duck', args: '', origin: { kind: 'composer' } } as never)

    expect(w.opened).toEqual(['rubber-duck'])
    expect(out.text).toContain('0 concerns')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`lists concerns and clears them (${surface})`, async ($, on) => {
      const w = world(on)
      w.replies = ['Hardcoded API key', 'TODO left in handler']
      await edit($, '/repo/src/keys.ts')
      await edit($, '/repo/src/handler.ts')
      await w.clock.settle()

      const pane = await $.ui.mount({ plugin: 'rubber-duck', surface, ...PANE })
      expect(await pane.find({ type: 'Text', text: 'Hardcoded API key' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'handler.ts' })).toBeDefined()

      await pane.press({ key: 'clear' })
      expect(await pane.find({ type: 'Text', text: 'No concerns yet' })).toBeDefined()
      expect(await pane.find({ key: 'clear' })).toBeUndefined()
    })
  }
})
