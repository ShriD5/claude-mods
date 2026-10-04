// Finding the first `git commit` in a Bash command, reading its message, and
// writing the command back with a new one.
import { lex, quote, simpleCommands } from './shell'
import type { Heredoc, Word } from './shell'

export type Edit = { start: number; end: number; text: string }

export type CommitCall = {
  /** The `-C <dir>` git was given, if any. */
  dir: string | undefined
  /** The message as git will read it, when the command says it outright. */
  message: string | undefined
  /** `-F <path>`: the message is that file's text (read by the caller). */
  file: string | undefined
  /** Why this commit is left alone, when it is. */
  skip: string | undefined
  isAmend: boolean
  isAll: boolean
  /** A `git add` runs earlier in the same command, so the index is not final yet. */
  isAddedFirst: boolean
  /** The edits that take the old message out; the new one goes in at `insertAt`. */
  edits: Edit[]
  insertAt: number
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'time', 'nohup', 'exec'])
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const REUSE = new Set(['-C', '-c', '--reuse-message', '--reedit-message', '--fixup', '--squash'])
const VALUE_OPTIONS = new Set(['--author', '--date', '--template', '-t', '--trailer', '--cleanup', '--pathspec-from-file'])

/** Where git's subcommand sits in a simple command's words, and the -C dir. */
function gitSub(words: readonly Word[]): { at: number; dir: string | undefined } | undefined {
  let at = 0

  while (at < words.length && (WRAPPERS.has(words[at]?.value ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]?.value ?? ''))) {
    at += 1
  }

  if ((words[at]?.value ?? '').split('/').pop() !== 'git') {
    return undefined
  }

  let dir: string | undefined
  at += 1

  while (at < words.length && (words[at]?.value ?? '').startsWith('-')) {
    const option = words[at]?.value ?? ''
    dir = option === '-C' ? words[at + 1]?.value : dir
    at += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
  }

  return { at, dir }
}

/** Removes a run of tokens and the blanks before it. */
function cut(src: string, first: { start: number }, last: { end: number }, text = ''): Edit {
  let start = first.start

  while (start > 0 && (src[start - 1] === ' ' || src[start - 1] === '\t')) {
    start -= 1
  }

  return { start, end: last.end, text: text === '' ? '' : ` ${text}` }
}

export function findCommit(src: string): CommitCall | undefined {
  const commands = simpleCommands(lex(src))
  let isAddedFirst = false

  for (const { words, heredocs } of commands) {
    const sub = gitSub(words)
    const name = sub === undefined ? undefined : words[sub.at]?.value

    if (name === 'add') {
      isAddedFirst = true
    }

    if (sub === undefined || name !== 'commit') {
      continue
    }

    const commitWord = words[sub.at] as Word

    return { ...readArgs(src, words.slice(sub.at + 1), heredocs), dir: sub.dir, isAddedFirst, insertAt: commitWord.end }
  }

  return undefined
}

function readArgs(src: string, args: readonly Word[], heredocs: readonly Heredoc[]) {
  const messages: string[] = []
  const edits: Edit[] = []
  let file: string | undefined
  let skip: string | undefined
  let isAmend = false
  let isAll = false

  /** One -m / -F occurrence: its value, and the tokens it spans (a cluster's other flags kept). */
  const take = (option: string, value: Word | undefined, tokens: Word[], residue: string) => {
    const first = tokens[0] as Word
    const last = tokens.at(-1) as Word

    if (value === undefined) {
      skip = `${option} has no value`

      return
    }

    edits.push(residue === '-' || residue === '' ? cut(src, first, last) : cut(src, first, last, residue))

    if (value.isDynamic) {
      skip = 'the message is built by the shell'
    } else if (option === 'F') {
      if (value.value === '-') {
        const stdin = heredocs[0]

        if (stdin === undefined || stdin.isDynamic) {
          skip = 'the message comes from stdin'
        } else {
          messages.push(stdin.body)
          edits.push(cut(src, stdin, stdin), { start: stdin.bodyStart, end: stdin.bodyEnd, text: '' })
        }
      } else {
        file = value.value
      }
    } else {
      messages.push(value.value)
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word
    const arg = word.value

    if (arg === '--') {
      break
    } else if (arg === '-m' || arg === '--message' || arg === '-F' || arg === '--file') {
      take(arg === '-F' || arg === '--file' ? 'F' : 'm', args[i + 1], [word, ...(args[i + 1] === undefined ? [] : [args[i + 1] as Word])], '')
      i += 1
    } else if (arg.startsWith('--message=') || arg.startsWith('--file=')) {
      const isFile = arg.startsWith('--file=')
      take(isFile ? 'F' : 'm', { ...word, value: arg.slice(arg.indexOf('=') + 1) }, [word], '')
    } else if (REUSE.has(arg) || [...REUSE].some(option => option.startsWith('--') && arg.startsWith(`${option}=`))) {
      skip = `${arg.split('=')[0]} reuses another commit's message`
      i += arg.includes('=') ? 0 : 1
    } else if (arg === '--amend') {
      isAmend = true
    } else if (arg === '--all') {
      isAll = true
    } else if (VALUE_OPTIONS.has(arg)) {
      i += 1
    } else if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      // A cluster of short flags: -am "msg", -m"msg", -aF msg.txt
      for (let at = 1; at < arg.length; at += 1) {
        const flag = arg[at] ?? ''

        if (flag === 'a') {
          isAll = true
        } else if (flag === 'm' || flag === 'F') {
          const rest = arg.slice(at + 1)
          const residue = arg.slice(0, at)

          if (rest === '') {
            take(flag, args[i + 1], [word, ...(args[i + 1] === undefined ? [] : [args[i + 1] as Word])], residue)
            i += 1
          } else {
            take(flag, { ...word, value: rest }, [word], residue)
          }

          break
        } else if (flag === 'C' || flag === 'c') {
          skip = `-${flag} reuses another commit's message`
          i += at === arg.length - 1 ? 1 : 0

          break
        } else if (flag === 't') {
          i += at === arg.length - 1 ? 1 : 0

          break
        } else if (flag === 'S' || flag === 'u') {
          break
        }
      }
    }
  }

  if (skip === undefined && messages.length === 0 && file === undefined) {
    skip = isAmend ? 'an amend that keeps its message' : 'no message given'
  }

  return { message: messages.length === 0 ? undefined : messages.join('\n\n'), file, skip, isAmend, isAll, edits }
}

/** The command with the old message taken out and `-m subject [-m body]` put right after `commit`. */
export function rewrite(src: string, call: CommitCall, subject: string, body: string): string {
  const message = ` -m ${quote(subject)}${body.trim() === '' ? '' : ` -m ${quote(body.trim())}`}`
  const edits = [...call.edits].sort((a, b) => b.start - a.start)
  let out = src

  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }

  return out.slice(0, call.insertAt) + message + out.slice(call.insertAt)
}
