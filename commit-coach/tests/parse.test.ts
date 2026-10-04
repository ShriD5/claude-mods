import { describe, expect, test } from 'claude-code/testing'

import { findCommit, rewrite } from '../hooks/commit'
import { laziness, readReply, stripAttribution, wrap } from '../hooks/message'
import { lex, quote, simpleCommands } from '../hooks/shell'

const CLAUDE_STYLE = `git add -A && git commit -m "$(cat <<'EOF'
fix

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"`

/** Rewrites with a fixed subject and body, then reads the result back the way git would. */
function roundTrip(command: string, subject = 'fix: handle empty slot list', body = '') {
  const call = findCommit(command)

  if (call === undefined || call.skip !== undefined) {
    throw new Error(`not rewritable: ${call?.skip ?? 'no commit'}`)
  }

  const out = rewrite(command, call, subject, body)
  const again = findCommit(out)

  return { out, message: again?.message }
}

describe('reading the message', () => {
  test('-m, repeated -m, attached and long forms', () => {
    expect(findCommit('git commit -m "fix"')?.message).toBe('fix')
    expect(findCommit(`git commit -m 'Subject' -m "Body line"`)?.message).toBe('Subject\n\nBody line')
    expect(findCommit('git commit -m"wip"')?.message).toBe('wip')
    expect(findCommit('git commit --message=wip')?.message).toBe('wip')
    expect(findCommit('git commit --message "two words"')?.message).toBe('two words')
  })

  test('the heredoc agents use, trailer and all', () => {
    const call = findCommit(CLAUDE_STYLE)

    expect(call?.message).toBe('fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>')
    expect(call?.isAddedFirst).toBe(true)
  })

  test('-F file and -F - fed by a heredoc', () => {
    expect(findCommit('git commit -F .git/MSG')).toMatchObject({ file: '.git/MSG', message: undefined, skip: undefined })
    expect(findCommit("git commit -F - <<'EOF'\nupdate\nEOF")?.message).toBe('update')
    expect(findCommit('echo hi | git commit -F -')?.skip).toBe('the message comes from stdin')
  })

  test('short flag clusters: -am, -aF', () => {
    expect(findCommit('git commit -am "wip"')).toMatchObject({ message: 'wip', isAll: true })
    expect(findCommit('git commit -aF msg.txt')).toMatchObject({ file: 'msg.txt', isAll: true })
  })

  test('shell quoting: concatenation, escapes, $\'...\'', () => {
    expect(findCommit(`git commit -m 'it'"'"'s done'`)?.message).toBe("it's done")
    expect(findCommit(`git commit -m "say \\"hi\\""`)?.message).toBe('say "hi"')
    expect(findCommit(`git commit -m $'line one\\nline two'`)?.message).toBe('line one\nline two')
    expect(findCommit('git commit -m fix\\ it')?.message).toBe('fix it')
  })

  test('finds the commit behind env vars, -C and other commands', () => {
    expect(findCommit('npm test && GIT_AUTHOR_NAME=x git -C ../api commit -m fix && git push')).toMatchObject({ dir: '../api', message: 'fix' })
    expect(findCommit('git commit -m fix 2>&1 | tail -5')?.message).toBe('fix')
  })

  test('leaves alone what it cannot or must not rewrite', () => {
    expect(findCommit('git commit --amend')?.skip).toBe('an amend that keeps its message')
    expect(findCommit('git commit --amend --no-edit')?.skip).toBe('an amend that keeps its message')
    expect(findCommit('git commit')?.skip).toBe('no message given')
    expect(findCommit('git commit -C HEAD')?.skip).toContain('reuses')
    expect(findCommit('git commit --fixup=abc123')?.skip).toContain('reuses')
    expect(findCommit('git commit -m "$MSG"')?.skip).toBe('the message is built by the shell')
    expect(findCommit('git commit -m "$(git log -1 --format=%s)"')?.skip).toBe('the message is built by the shell')
    expect(findCommit('git commit -m "$(cat <<EOF\nfix $THING\nEOF\n)"')?.skip).toBe('the message is built by the shell')
    expect(findCommit('git commit --amend -m "fix"')).toMatchObject({ isAmend: true, message: 'fix', skip: undefined })
  })

  test('only real git commit calls count', () => {
    expect(findCommit('echo "git commit -m fix"')).toBeUndefined()
    expect(findCommit('git commit-tree HEAD^{tree}')).toBeUndefined()
    expect(findCommit('git log --grep commit')).toBeUndefined()
    expect(findCommit('# git commit -m fix\nls')).toBeUndefined()
  })
})

describe('writing the command back', () => {
  test('replaces -m in place and keeps the rest of the command', () => {
    expect(roundTrip('git add . && git commit -m "fix" && git push').out).toBe("git add . && git commit -m 'fix: handle empty slot list' && git push")
  })

  test('keeps the other flags of a cluster', () => {
    expect(roundTrip('git commit -am wip').out).toBe("git commit -m 'fix: handle empty slot list' -a")
    expect(roundTrip('git commit -vm"wip" --no-verify').out).toBe("git commit -m 'fix: handle empty slot list' -v --no-verify")
  })

  test('takes out every -m, and a body becomes a second -m', () => {
    const { out, message } = roundTrip('git commit -m "Subject" -m "Body" -- src/a.ts', 'feat: add slots', 'why it matters')

    expect(out).toBe("git commit -m 'feat: add slots' -m 'why it matters' -- src/a.ts")
    expect(message).toBe('feat: add slots\n\nwhy it matters')
  })

  test('the agent heredoc becomes plain -m arguments', () => {
    expect(roundTrip(CLAUDE_STYLE).out).toBe("git add -A && git commit -m 'fix: handle empty slot list'")
  })

  test('-F - and its heredoc body both go', () => {
    expect(roundTrip("git commit -F - <<'EOF'\nupdate\nEOF\necho done").out).toBe("git commit -m 'fix: handle empty slot list'\necho done")
  })

  test('-F file becomes -m', () => {
    expect(roundTrip('git commit -F /tmp/msg.txt --no-verify').out).toBe("git commit -m 'fix: handle empty slot list' --no-verify")
  })

  test('quotes survive the trip', () => {
    expect(roundTrip('git commit -m wip', "fix: don't drop the user's slot", "it's \"quoted\" and $NOT expanded").message).toBe(
      "fix: don't drop the user's slot\n\nit's \"quoted\" and $NOT expanded",
    )
  })

  test('quote() round-trips through the lexer', () => {
    for (const value of ["plain", "it's", "a\nb", "$(rm -rf /)", "back\\slash", "'"]) {
      expect(simpleCommands(lex(`echo ${quote(value)}`))[0]?.words[1]?.value).toBe(value)
    }
  })
})

describe('the message rules', () => {
  test('laziness', () => {
    expect(laziness('fix')).toBe('lazy')
    expect(laziness('WIP')).toBe('lazy')
    expect(laziness('update.')).toBe('lazy')
    expect(laziness('refactoring')).toBe('one word')
    expect(laziness(`feat: ${'x '.repeat(40)}`)).toBe('over 72 characters')
    expect(laziness('Add slot grid')).toBe('no conventional prefix')
    expect(laziness('fix:')).toBe('one word')
    expect(laziness('feat(api)!: drop v1 routes')).toBeUndefined()
    expect(laziness('fix: handle empty slot list')).toBeUndefined()
    expect(laziness('Merge branch main into feature')).toBeUndefined()
    expect(laziness('Revert "feat: add slots"')).toBeUndefined()
    expect(laziness('fixup! feat: add slots')).toBeUndefined()
  })

  test('strips trailers and generated-with lines, nothing else', () => {
    expect(
      stripAttribution('feat: add slots\n\nKeeps the grid.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nco-authored-by: Jane <j@x.dev>'),
    ).toEqual({ message: 'feat: add slots\n\nKeeps the grid.', removed: 3 })
    expect(stripAttribution('fix: the co-authored-by parser')).toEqual({ message: 'fix: the co-authored-by parser', removed: 0 })
  })

  test('wraps a body at 72 columns', () => {
    expect(wrap('aaa bbb ccc', 7)).toBe('aaa bbb\nccc')
    expect(wrap('one\n\ntwo', 72)).toBe('one\n\ntwo')
  })

  test('reads the model reply, and refuses a subject that does not pass', () => {
    expect(readReply('```\nfix(scheduler): handle empty slot list.\n\nThe loop assumed one slot.\n```')).toEqual({
      subject: 'fix(scheduler): handle empty slot list',
      body: 'The loop assumed one slot.',
    })
    expect(readReply('"feat: add grid"')).toEqual({ subject: 'feat: add grid', body: '' })
    expect(readReply('Here is a commit message')).toBeUndefined()
    expect(readReply(`fix: x\n\n${'word '.repeat(20).trim()}`)?.body).toBe(wrap('word '.repeat(20).trim(), 72))
    expect(readReply(`feat: ${'long '.repeat(20)}`)).toBeUndefined()
  })
})
