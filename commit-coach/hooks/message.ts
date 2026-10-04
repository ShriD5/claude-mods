// What makes a commit message lazy, stripping attribution, and the model's part.

export const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^()\n]+\))?!?: \S/

const LAZY = new Set([
  'fix', 'fixes', 'fixed', 'wip', 'update', 'updates', 'updated', 'change', 'changes', 'stuff', 'asdf',
  'misc', 'tmp', 'temp', 'test', 'tests', 'cleanup', 'minor', 'edit', 'edits', 'commit', 'save', 'done',
  'progress', 'more', 'things', 'work', 'tweak', 'tweaks', 'oops', 'typo', '.',
])

/** Subjects git or a person wrote on purpose: merges, reverts and autosquash markers. */
const LEAVE_ALONE = /^(Merge |Revert "|fixup! |squash! |amend! )/

const ATTRIBUTION = [/^\s*co-authored-by:/i, /^\W*generated (with|by) /i]

/** Drops `Co-Authored-By:` trailers and "Generated with ..." lines. */
export function stripAttribution(message: string): { message: string; removed: number } {
  const lines = message.split('\n')
  const kept = lines.filter(line => !ATTRIBUTION.some(pattern => pattern.test(line)))
  const cleaned = kept
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { message: cleaned, removed: lines.length - kept.length }
}

export function split(message: string): { subject: string; body: string } {
  const [subject = '', ...rest] = message.trim().split('\n')

  return { subject: subject.trim(), body: rest.join('\n').trim() }
}

/** Why a subject needs rewriting, or undefined when it is fine (or not ours to touch). */
export function laziness(subject: string): string | undefined {
  const bare = subject.trim()

  if (bare === '' || LEAVE_ALONE.test(bare)) {
    return undefined
  }

  if (LAZY.has(bare.toLowerCase().replace(/[.!]+$/, ''))) {
    return 'lazy'
  }

  if (!/\s/.test(bare)) {
    return 'one word'
  }

  if (bare.length > 72) {
    return 'over 72 characters'
  }

  if (!CONVENTIONAL.test(bare)) {
    return 'no conventional prefix'
  }

  return undefined
}

export function buildPrompt(original: string, diff: string): string {
  return [
    'Write a git commit message in the Conventional Commits format for the change below.',
    '',
    'Line 1: type(optional-scope): subject',
    '- type is one of feat, fix, chore, docs, refactor, test, perf, build, ci, style',
    '- imperative mood, lowercase after the colon, no trailing period, 72 characters at most, specific to this diff',
    'Then, only if the why is not obvious from the subject: a blank line and a body of one to three short lines.',
    'No Co-Authored-By lines, no "Generated with" lines, no quotes, no code fences. Reply with the message only.',
    '',
    `The author's own message, as a hint at intent: ${JSON.stringify(original)}`,
    '',
    '<diff>',
    diff,
    '</diff>',
  ].join('\n')
}

/** The model's reply as a subject and body, or undefined when the subject does not pass. */
export function readReply(reply: string): { subject: string; body: string } | undefined {
  const bare = reply
    .trim()
    .replace(/^```[a-z]*\n?|```$/g, '')
    .trim()
  const { message } = stripAttribution(bare)
  const { subject, body } = split(message)
  const clean = subject.replace(/^["'`]+|["'`]+$/g, '').replace(/\.$/, '').trim()

  if (!CONVENTIONAL.test(clean) || clean.length > 72) {
    return undefined
  }

  return { subject: clean, body: wrap(body, 72) }
}

/** Wraps each paragraph of a body at `width` columns, as git log reads best. */
export function wrap(text: string, width: number): string {
  return text
    .split('\n')
    .map(line => {
      const out: string[] = []
      let current = ''

      for (const word of line.split(' ')) {
        if (current !== '' && current.length + 1 + word.length > width) {
          out.push(current)
          current = word
        } else {
          current = current === '' ? word : `${current} ${word}`
        }
      }

      return [...out, current].join('\n')
    })
    .join('\n')
}

/** Cuts a diff to what a fast model needs: the stat whole, the patch up to `max` characters. */
export function trimDiff(stat: string, patch: string, max = 8000): string {
  const cut = patch.length > max ? `${patch.slice(0, max)}\n... (diff cut at ${max} characters)` : patch

  return [stat.trim(), cut.trim()].filter(Boolean).join('\n\n')
}
