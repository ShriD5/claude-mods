// What the duck looks at, what it asks the model, and how it reads the answer.

export type Change = { file: string; diff: string }

export const MAX_FILE_BYTES = 200 * 1024
const MAX_DIFF_CHARS = 6000
const MAX_CONCERN_CHARS = 140

const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|bun\.lockb|go\.sum|[^/]+\.lock)$/
const GENERATED_DIR =
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|target|generated|__generated__|\.next|\.nuxt|\.svelte-kit|\.output|\.turbo|\.vercel|\.wrangler)\//
const GENERATED_FILE = /(\.min\.(js|mjs|css)|\.map|\.snap|\.pb\.go|_pb2\.py|\.g\.dart)$|\.generated\./

/** Lockfiles, build output and minified or generated files are not worth a review. */
export const isSkippable = (file: string): boolean =>
  LOCKFILE.test(file) || GENERATED_DIR.test(file) || GENERATED_FILE.test(file)

export const basename = (file: string): string => file.split(/[\\/]/).pop() || file

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

const isHunk = (value: unknown): value is Hunk =>
  typeof value === 'object' && value !== null && Array.isArray((value as Hunk).lines)

const prefixed = (sign: '-' | '+', text: unknown): string[] =>
  typeof text === 'string' && text !== '' ? text.split('\n').map(line => `${sign}${line}`) : []

/**
 * The change an Edit, MultiEdit or Write made, as a unified diff cut to fit a
 * small prompt: from the tool's own patch when it has one, else its input.
 */
export const changeOf = (input: Record<string, unknown>, result: unknown): Change | undefined => {
  const file = input.file_path
  const output = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  if (typeof file !== 'string' || output.staged === true) return undefined
  if (typeof input.content === 'string' && input.content.length > MAX_FILE_BYTES) return undefined

  const hunks = Array.isArray(output.structuredPatch) ? output.structuredPatch.filter(isHunk) : []
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input]
  const lines = hunks.length
    ? hunks.flatMap(h => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines])
    : [
        ...edits.flatMap(edit => [...prefixed('-', edit.old_string), ...prefixed('+', edit.new_string)]),
        ...prefixed('+', input.content),
      ]
  if (!lines.some(line => /^[-+]/.test(line))) return undefined
  const diff = lines.join('\n')

  return { file, diff: diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[... cut]` : diff }
}

export const SYSTEM = [
  'You are a rubber duck reviewing one code change for a busy developer.',
  'Reply with ONE short concern, under 15 words, only if the change clearly introduces one of these:',
  'removed error handling, a deleted or disabled test, a swallowed exception, a hardcoded secret, token or URL,',
  'an off-by-one, a changed public signature, or a TODO or FIXME left in.',
  'Ignore style, naming, formatting and missing comments.',
  'If nothing is clearly wrong, reply with exactly: OK',
].join(' ')

export const promptOf = (change: Change): string =>
  `File: ${change.file}\n\nDiff (- removed, + added):\n${change.diff}`

/** The concern in the model's reply, or undefined for OK (or nothing). */
export const concernOf = (reply: string): string | undefined => {
  const line = (reply.trim().split('\n')[0] ?? '').replace(/^[\s"'`*-]+|[\s"'`*]+$/g, '')
  if (line === '' || /^ok\b/i.test(line)) return undefined

  return line.length > MAX_CONCERN_CHARS ? `${line.slice(0, MAX_CONCERN_CHARS - 3)}...` : line
}
