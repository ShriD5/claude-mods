// Pure logic for main-guard: reading git calls out of a shell command and judging them.

export const DEFAULT_BRANCHES = 'main, master, production, release*'

/** "main, master release/*" -> ["main", "master", "release/*"] */
export function branchList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

/** Glob match with `*` as "anything", so `release*` covers `release/2.1` and `release-candidate`. */
export function isProtected(branch: string | null, patterns: readonly string[]): boolean {
  if (branch === null || branch === '') {
    return false
  }

  return patterns.some(pattern => {
    const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')

    return new RegExp(`^${source}$`).test(branch)
  })
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')', '|&'])

/** Splits a shell command into simple commands, each a list of words with quotes removed. */
export function simpleCommands(command: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let i = 0

  const endWord = () => {
    if (hasWord) {
      words.push(word)
    }

    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()

    if (words.length > 0) {
      commands.push(words)
    }

    words = []
  }

  while (i < command.length) {
    const char = command[i] ?? ''
    const pair = command.slice(i, i + 2)

    if (char === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') {
        word += command[i + 1]
        hasWord = true
      }

      i += 2
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      hasWord = true
      i = stop + 1
    } else if (char === '"') {
      i += 1

      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1] ?? '')) {
          i += 1
        }

        word += command[i]
        i += 1
      }

      hasWord = true
      i += 1
    } else if (char === '#' && !hasWord) {
      while (i < command.length && command[i] !== '\n') {
        i += 1
      }
    } else if (SEPARATORS.has(pair)) {
      endCommand()
      i += 2
    } else if (SEPARATORS.has(char)) {
      endCommand()
      i += 1
    } else if (char === ' ' || char === '\t') {
      endWord()
      i += 1
    } else {
      word += char
      hasWord = true
      i += 1
    }
  }

  endCommand()

  return commands
}

export type GitCall = {
  /** The `-C <dir>` the call runs in, when it names one. */
  dir: string | undefined
  sub: string
  args: string[]
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'time', 'nohup', 'exec', 'builtin'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** Every git call in a command, `bash -c "..."` bodies included. */
export function gitCalls(command: string, depth = 0): GitCall[] {
  const calls: GitCall[] = []

  for (const words of simpleCommands(command)) {
    let at = 0

    while (at < words.length && (WRAPPERS.has(words[at] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '') || (words[at - 1] === 'sudo' && words[at]?.startsWith('-')))) {
      at += 1
    }

    const program = (words[at] ?? '').split('/').pop() ?? ''

    if (SHELLS.has(program) && depth < 2) {
      const flag = words.findIndex((word, index) => index > at && /^-[a-z]*c[a-z]*$/.test(word))
      const body = flag === -1 ? undefined : words[flag + 1]

      if (body !== undefined) {
        calls.push(...gitCalls(body, depth + 1))
      }

      continue
    }

    if (program !== 'git') {
      continue
    }

    let dir: string | undefined
    at += 1

    while (at < words.length && (words[at] ?? '').startsWith('-')) {
      const option = words[at] ?? ''

      if (option === '-C') {
        dir = words[at + 1]
      }

      at += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
    }

    if (at < words.length) {
      calls.push({ dir, sub: words[at] ?? '', args: words.slice(at + 1) })
    }
  }

  return calls
}

export type Push = {
  isForce: boolean
  isDelete: boolean
  isMirror: boolean
  isAll: boolean
  /** Branch names the push writes; `null` stands for the current branch. */
  targets: (string | null)[]
}

const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

export function readPush(args: readonly string[]): Push {
  const push: Push = { isForce: false, isDelete: false, isMirror: false, isAll: false, targets: [] }
  const positional: string[] = []
  let isTagsOnly = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''

    if (arg === '--') {
      positional.push(...args.slice(i + 1))
      break
    } else if (arg === '--force' || arg === '--force-with-lease' || arg.startsWith('--force-with-lease=')) {
      push.isForce = true
    } else if (arg === '--delete') {
      push.isDelete = true
    } else if (arg === '--mirror') {
      push.isMirror = true
    } else if (arg === '--all' || arg === '--branches') {
      push.isAll = true
    } else if (arg === '--tags') {
      isTagsOnly = true
    } else if (PUSH_VALUE_OPTIONS.has(arg)) {
      i += 1
    } else if (arg.startsWith('--')) {
      continue
    } else if (arg.startsWith('-') && arg.length > 1) {
      // A cluster of short flags: -fu, -uf, -d. `-o` takes the rest or the next word.
      const flags = arg.slice(1)

      for (let at = 0; at < flags.length; at += 1) {
        if (flags[at] === 'f') {
          push.isForce = true
        } else if (flags[at] === 'd') {
          push.isDelete = true
        } else if (flags[at] === 'o') {
          i += at === flags.length - 1 ? 1 : 0

          break
        }
      }
    } else if (/^\d*[<>]/.test(arg) || arg.startsWith('&>')) {
      // A redirection (2>, >log) the splitter left as a word: it names no branch.
      continue
    } else {
      positional.push(arg)
    }
  }

  const refspecs = positional.slice(1)

  if (refspecs.length === 0) {
    push.targets = push.isAll || push.isMirror || isTagsOnly ? [] : [null]

    return push
  }

  for (const refspec of refspecs) {
    const isForced = refspec.startsWith('+')
    const spec = isForced ? refspec.slice(1) : refspec
    const colon = spec.indexOf(':')
    const source = colon === -1 ? spec : spec.slice(0, colon)
    const destination = colon === -1 ? spec : spec.slice(colon + 1)

    if (destination.startsWith('refs/tags/') || (colon === -1 && source.startsWith('refs/tags/'))) {
      continue
    }

    if (isForced) {
      push.isForce = true
    }

    if (colon !== -1 && source === '') {
      push.isDelete = true
    }

    push.targets.push(destination === 'HEAD' || destination === '@' ? null : destination.replace(/^refs\/heads\//, ''))
  }

  return push
}

export type Decision =
  | { kind: 'pass' }
  | { kind: 'deny'; reason: string }
  | { kind: 'confirm'; branch: string }

/**
 * What to do about one git call, given the branch it runs on.
 *
 * Force pushes, deletes and `reset --hard` on a protected branch are refused;
 * a plain push to one needs the person to say yes.
 */
export function decide(call: GitCall, current: string | null, patterns: readonly string[]): Decision {
  if (call.sub === 'reset' && call.args.includes('--hard') && isProtected(current, patterns)) {
    return {
      kind: 'deny',
      reason: `main-guard: \`git reset --hard\` on ${current} throws away commits and uncommitted work. Branch off first (\`git switch -c rescue\`) or \`git stash\`, then reset there.`,
    }
  }

  if (call.sub !== 'push') {
    return { kind: 'pass' }
  }

  const push = readPush(call.args)

  if (push.isMirror) {
    return { kind: 'deny', reason: 'main-guard: `git push --mirror` overwrites every branch on the remote, protected ones included. Push the branches you mean by name.' }
  }

  const targets = push.targets.map(target => target ?? current)
  const hit = targets.find(target => isProtected(target, patterns)) ?? (push.isAll ? patterns.find(pattern => !pattern.includes('*')) : undefined)

  if (hit === undefined || hit === null) {
    return { kind: 'pass' }
  }

  if (push.isForce || push.isDelete) {
    const what = push.isDelete ? 'Deleting' : 'Force-pushing'

    return {
      kind: 'deny',
      reason: `main-guard: ${what} ${hit} rewrites history other people build on, so it is blocked here. Push to a feature branch and open a PR; if you really mean it, run it yourself outside Claude.`,
    }
  }

  return { kind: 'confirm', branch: hit }
}

/** The band's text: "⚠ on main · NODE_ENV=production · .prod". */
export function bandText(reasons: readonly string[]): string {
  return `⚠ ${reasons.join(' · ')}`
}
