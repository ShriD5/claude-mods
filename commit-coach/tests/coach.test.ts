import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CLAUDE_STYLE = `git add -A && git commit -m "$(cat <<'EOF'
fix

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"`

const DIFF = 'diff --git a/src/scheduler.ts b/src/scheduler.ts\n-  const first = slots[0].start\n+  if (slots.length === 0) return []\n'

type World = {
  ran: string[]
  toasts: string[]
  prompts: string[]
  gitCalls: string[]
  reply: string
  isMerging: boolean
  files: Record<string, string>
}

/** The engine beneath commit-coach: git from a fixed diff, the model's reply canned, Bash recorded. */
function worldOf(on: On, patch: Partial<World> = {}): World {
  const world: World = { ran: [], toasts: [], prompts: [], gitCalls: [], reply: 'fix(scheduler): handle empty slot list', isMerging: false, files: {}, ...patch }

  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    world.gitCalls.push(args)
    const isMergeCheck = args.endsWith('--verify MERGE_HEAD')
    const stdout = isMergeCheck ? 'abc123' : args.includes('--stat') ? ' src/scheduler.ts | 2 +-\n 1 file changed' : args.startsWith('diff') ? DIFF : ''
    const exitCode = isMergeCheck && !world.isMerging ? 1 : 0

    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    world.prompts.push(e.prompt)

    return { value: { isAnswered: true, text: world.reply, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as never
  })
  on('fs.read', ($, e) => {
    const text = world.files[e.path]

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    world.ran.push(e.command)

    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })

  return world
}

describe('commit-coach on a real Bash call', () => {
  test('a lazy subject with an attribution trailer becomes a conventional commit', async ($, on) => {
    const world = worldOf(on)
    await $.tool.call({ tool: 'Bash', command: CLAUDE_STYLE })

    expect(world.ran).toEqual(["git add -A && git commit -m 'fix(scheduler): handle empty slot list'"])
    expect(world.toasts).toEqual(["commit-coach: 'fix' → 'fix(scheduler): handle empty slot list' · dropped 1 attribution line"])
    expect(world.prompts[0]).toContain('slots.length === 0')
    expect(world.prompts[0], 'the trailer is not shown to the model').toContain('as a hint at intent: "fix"\n')
    expect(world.gitCalls, 'a git add earlier in the command: the work tree is read').toContain('diff HEAD')
  })

  test('the model is told the message was rewritten, so it does not amend it back', async ($, on) => {
    worldOf(on)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m fix' })

    expect(ran.context?.at(-1)).toContain("rewrote the subject 'fix' to 'fix(scheduler): handle empty slot list'")
    expect(ran.context?.at(-1)).toContain("don't amend")
  })

  test('a commit left alone gets no note', async ($, on) => {
    worldOf(on)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: handle empty slot list"' })

    expect(ran.context ?? []).toEqual([])
  })

  test('the staged diff is read for a plain commit', async ($, on) => {
    const world = worldOf(on)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m wip' })

    expect(world.gitCalls).toContain('diff --cached')
    expect(world.ran).toEqual(["git commit -m 'fix(scheduler): handle empty slot list'"])
  })

  test('a good subject with a trailer is only stripped, no model call', async ($, on) => {
    const world = worldOf(on)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: add slot grid" -m "Co-Authored-By: Claude <noreply@anthropic.com>"' })

    expect(world.ran).toEqual(["git commit -m 'feat: add slot grid'"])
    expect(world.prompts).toEqual([])
    expect(world.toasts).toEqual(['commit-coach: dropped 1 attribution line'])
  })

  test('a good commit passes through untouched and quietly', async ($, on) => {
    const world = worldOf(on)
    const command = 'git commit -m "fix: handle empty slot list" && git push'
    await $.tool.call({ tool: 'Bash', command })

    expect(world.ran).toEqual([command])
    expect(world.prompts).toEqual([])
    expect(world.toasts).toEqual([])
  })

  test('the author body is kept when the subject is rewritten', async ($, on) => {
    const world = worldOf(on, { reply: 'fix: guard empty slot list\n\nModel body that should lose.' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "wip" -m "The scheduler assumed one slot."' })

    expect(world.ran).toEqual(["git commit -m 'fix: guard empty slot list' -m 'The scheduler assumed one slot.'"])
  })

  test('the model body is used when the author gave none', async ($, on) => {
    const world = worldOf(on, { reply: 'fix: guard empty slot list\n\nThe scheduler assumed one slot.' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "wip"' })

    expect(world.ran).toEqual(["git commit -m 'fix: guard empty slot list' -m 'The scheduler assumed one slot.'"])
  })

  test('-F reads the file and replaces it with -m', async ($, on) => {
    const world = worldOf(on, { files: { '/tmp/msg.txt': 'update\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' } })
    await $.tool.call({ tool: 'Bash', command: 'git commit -F /tmp/msg.txt' })

    expect(world.ran).toEqual(["git commit -m 'fix(scheduler): handle empty slot list'"])
  })

  test('a reply that is not a conventional subject keeps the original, and says so', async ($, on) => {
    const world = worldOf(on, { reply: 'Sure! Here is a better message for you' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m fix' })

    expect(world.ran).toEqual(['git commit -m fix'])
    expect(world.toasts[0]).toContain("kept 'fix'")
  })

  test('never touches a merge commit', async ($, on) => {
    const world = worldOf(on, { isMerging: true })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "wip" -m "Co-Authored-By: Claude <noreply@anthropic.com>"' })

    expect(world.ran).toEqual(['git commit -m "wip" -m "Co-Authored-By: Claude <noreply@anthropic.com>"'])
    expect(world.prompts).toEqual([])
  })

  test('never touches an amend that keeps its message', async ($, on) => {
    const world = worldOf(on)
    await $.tool.call({ tool: 'Bash', command: 'git commit --amend --no-edit' })

    expect(world.ran).toEqual(['git commit --amend --no-edit'])
    expect(world.gitCalls).toEqual([])
  })

  test('an amend with a lazy message diffs against the parent', async ($, on) => {
    const world = worldOf(on)
    await $.tool.call({ tool: 'Bash', command: 'git commit --amend -m wip' })

    expect(world.gitCalls).toContain('diff --cached HEAD~1')
    expect(world.ran).toEqual(["git commit -m 'fix(scheduler): handle empty slot list' --amend"])
  })

  test('stripAttribution off keeps the trailer', { options: { stripAttribution: false } }, async ($, on) => {
    const world = worldOf(on)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: add grid" -m "Co-Authored-By: Claude <noreply@anthropic.com>"' })

    expect(world.ran).toEqual(['git commit -m "feat: add grid" -m "Co-Authored-By: Claude <noreply@anthropic.com>"'])
  })

  test('rewriteSubjects off strips but never calls the model', { options: { rewriteSubjects: false } }, async ($, on) => {
    const world = worldOf(on)
    await $.tool.call({ tool: 'Bash', command: CLAUDE_STYLE })

    expect(world.ran).toEqual(["git add -A && git commit -m 'fix'"])
    expect(world.prompts).toEqual([])
  })

  test('the commit attribution text the model reads is emptied', async $ => {
    const answer = await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: Claude <noreply@anthropic.com>' })

    expect(answer).toEqual({ text: '' })
  })
})
