// A small shell lexer that keeps where every token sits in the source, so a
// `git commit` message can be cut out of a command and a new one put in.

export type Word = { kind: 'word'; value: string; start: number; end: number; isDynamic: boolean }
export type Op = { kind: 'op'; value: string; start: number; end: number }
export type Heredoc = {
  kind: 'heredoc'
  /** The `<<'EOF'` text. */
  start: number
  end: number
  delimiter: string
  body: string
  /** The body's lines and the delimiter line, which come after the command's newline. */
  bodyStart: number
  bodyEnd: number
  isDynamic: boolean
  strip: boolean
}
export type Token = Word | Op | Heredoc

const OPS2 = ['&&', '||', '>>', '>&', '&>', '|&']
const OPS1 = [';', '|', '&', '(', ')', '<', '>']
const NAME = /[A-Za-z_0-9@*#?$!{-]/

/** `$(cat <<'EOF' ... EOF\n)`: the way agents pass a multi-line commit message. */
const CAT_HEREDOC = /^\$\(\s*cat\s*<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[ \t]*\n/

/** Where a `$(` substitution closes, counting nested parens and skipping quotes. */
function closeParen(src: string, from: number): number {
  let depth = 0

  for (let i = from; i < src.length; i += 1) {
    const char = src[i]

    if (char === "'" || char === '"') {
      const end = src.indexOf(char, i + 1)
      i = end === -1 ? src.length : end
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1

      if (depth === 0) {
        return i
      }
    }
  }

  return src.length - 1
}

/** Reads `$(cat <<'EOF' ...)` at `at`: the body and where the substitution ends, or undefined. */
function catHeredoc(src: string, at: number): { body: string; next: number; isDynamic: boolean } | undefined {
  const head = CAT_HEREDOC.exec(src.slice(at))

  if (head === null) {
    return undefined
  }

  const delimiter = head[2] ?? ''
  const lines: string[] = []
  let i = at + head[0].length

  while (i < src.length) {
    const lineEnd = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i)
    const line = src.slice(i, lineEnd)

    if (line.trim() === delimiter) {
      const close = /^\s*\)/.exec(src.slice(lineEnd))

      return close === null ? undefined : { body: lines.join('\n'), next: lineEnd + close[0].length, isDynamic: head[1] === '' && /[$`]/.test(lines.join('\n')) }
    }

    lines.push(line)
    i = lineEnd + 1
  }

  return undefined
}

export function lex(src: string): Token[] {
  const tokens: Token[] = []
  const pending: Heredoc[] = []
  let word: Word | null = null
  let i = 0

  const begin = (): Word => {
    word ??= { kind: 'word', value: '', start: i, end: i, isDynamic: false }

    return word
  }
  const flush = () => {
    if (word !== null) {
      word.end = i
      tokens.push(word)
      word = null
    }
  }

  while (i < src.length) {
    const char = src[i] ?? ''
    const pair = src.slice(i, i + 2)

    if (char === '\\') {
      if (src[i + 1] !== '\n') {
        begin().value += src[i + 1] ?? ''
      }

      i += 2
    } else if (char === "'") {
      const current = begin()
      const end = src.indexOf("'", i + 1) === -1 ? src.length : src.indexOf("'", i + 1)
      current.value += src.slice(i + 1, end)
      i = end + 1
    } else if (char === '"') {
      const current = begin()
      i += 1

      while (i < src.length && src[i] !== '"') {
        const inner = src[i] ?? ''

        if (inner === '\\' && '"\\$`\n'.includes(src[i + 1] ?? '')) {
          current.value += src[i + 1] === '\n' ? '' : (src[i + 1] ?? '')
          i += 2
        } else if (src.startsWith('$(', i)) {
          const heredoc = catHeredoc(src, i)

          if (heredoc === undefined) {
            const close = closeParen(src, i + 1)
            current.value += src.slice(i, close + 1)
            current.isDynamic = true
            i = close + 1
          } else {
            current.value += heredoc.body
            current.isDynamic ||= heredoc.isDynamic
            i = heredoc.next
          }
        } else if ((inner === '$' && NAME.test(src[i + 1] ?? '')) || inner === '`') {
          current.value += inner
          current.isDynamic = true
          i += 1
        } else {
          current.value += inner
          i += 1
        }
      }

      i += 1
    } else if (pair === "$'") {
      // ANSI-C quoting: $'line one\nline two'
      const current = begin()
      i += 2

      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\') {
          const escaped = src[i + 1] ?? ''
          current.value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
          i += 2
        } else {
          current.value += src[i]
          i += 1
        }
      }

      i += 1
    } else if (char === '$' || char === '`') {
      const current = begin()
      current.isDynamic = true

      if (pair === '$(') {
        const close = closeParen(src, i + 1)
        current.value += src.slice(i, close + 1)
        i = close + 1
      } else if (char === '`') {
        const end = src.indexOf('`', i + 1) === -1 ? src.length : src.indexOf('`', i + 1)
        current.value += src.slice(i, end + 1)
        i = end + 1
      } else {
        current.value += char
        i += 1
      }
    } else if (char === '#' && word === null) {
      while (i < src.length && src[i] !== '\n') {
        i += 1
      }
    } else if (char === ' ' || char === '\t') {
      flush()
      i += 1
    } else if (char === '\n') {
      flush()
      tokens.push({ kind: 'op', value: '\n', start: i, end: i + 1 })
      i += 1

      for (const heredoc of pending.splice(0)) {
        const lines: string[] = []
        heredoc.bodyStart = i

        while (i < src.length) {
          const lineEnd = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i)
          const line = src.slice(i, lineEnd)
          const bare = heredoc.strip ? line.replace(/^\t+/, '') : line
          i = Math.min(lineEnd + 1, src.length)

          if (bare === heredoc.delimiter) {
            break
          }

          lines.push(bare)
        }

        heredoc.bodyEnd = i
        heredoc.body = lines.join('\n')
        heredoc.isDynamic &&= /[$`]/.test(heredoc.body)
      }
    } else if (src.startsWith('<<<', i)) {
      flush()
      tokens.push({ kind: 'op', value: '<<<', start: i, end: i + 3 })
      i += 3
    } else if (pair === '<<') {
      flush()
      const start = i
      i += 2
      const strip = src[i] === '-'
      i += strip ? 1 : 0

      while (src[i] === ' ' || src[i] === '\t') {
        i += 1
      }

      const quote = src[i] === "'" || src[i] === '"' ? src[i] : ''
      i += quote === '' ? 0 : 1
      let delimiter = ''

      while (i < src.length && (quote === '' ? !/[\s;&|<>()]/.test(src[i] ?? '') : src[i] !== quote)) {
        delimiter += src[i]
        i += 1
      }

      i += quote === '' ? 0 : 1
      const heredoc: Heredoc = { kind: 'heredoc', start, end: i, delimiter, body: '', bodyStart: i, bodyEnd: i, isDynamic: quote === '', strip }
      tokens.push(heredoc)
      pending.push(heredoc)
    } else if (OPS2.includes(pair)) {
      flush()
      tokens.push({ kind: 'op', value: pair, start: i, end: i + 2 })
      i += 2
    } else if (OPS1.includes(char)) {
      flush()
      tokens.push({ kind: 'op', value: char, start: i, end: i + 1 })
      i += 1
    } else {
      begin().value += char
      i += 1
    }
  }

  flush()

  return tokens
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')', '|&'])
const REDIRECTS = new Set(['<', '>', '>>', '>&', '&>', '<<<'])

/** The simple commands of a token list: words and heredocs, redirections and their targets left out. */
export function simpleCommands(tokens: readonly Token[]): { words: Word[]; heredocs: Heredoc[] }[] {
  const commands: { words: Word[]; heredocs: Heredoc[] }[] = []
  let words: Word[] = []
  let heredocs: Heredoc[] = []

  const end = () => {
    if (words.length > 0) {
      commands.push({ words, heredocs })
    }

    words = []
    heredocs = []
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]

    if (token === undefined) {
      continue
    }

    if (token.kind === 'heredoc') {
      heredocs.push(token)
    } else if (token.kind === 'op' && SEPARATORS.has(token.value)) {
      end()
    } else if (token.kind === 'op' && REDIRECTS.has(token.value)) {
      // `2>` leaves a bare fd number as the word before it; the target is the word after.
      const before = words.at(-1)

      if (before !== undefined && before.end === token.start && /^\d+$/.test(before.value)) {
        words.pop()
      }

      if (tokens[i + 1]?.kind === 'word') {
        i += 1
      }
    } else if (token.kind === 'word') {
      words.push(token)
    }
  }

  end()

  return commands
}

/** Single-quotes a value for the shell: it then means exactly itself. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
