// High-precision secret detection: each rule matches a credential format that
// real services issue, then obvious placeholders are dropped. Better to miss a
// homemade token than to block a README that shows `sk-your-key-here`.

export type Finding = {
  /** What kind of secret, as the deny reason names it ("GitHub token"). */
  type: string
  /** The environment variable the reason suggests instead. */
  env: string
  /** 1-based line in the text scanned. */
  line: number
  /** The secret itself: compared, never shown. */
  value: string
}

type Rule = {
  type: string
  env: string
  pattern: RegExp
  /** The part of the match that is the secret (default: all of it). */
  secret?: (match: RegExpExecArray) => string
  /** Extra checks on a match that is not a placeholder. */
  isReal?: (match: RegExpExecArray) => boolean
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[^.]+)$/i
const DOC_HOST = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i
const DEFAULT_PASSWORD = /^(password|passwd|pass|pw|pwd|secret|root|admin|user|guest|test|postgres|mysql|mongo|redis|changeme)$/i

const RULES: Rule[] = [
  { type: 'AWS access key', env: 'AWS_ACCESS_KEY_ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'Anthropic API key', env: 'ANTHROPIC_API_KEY', pattern: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{32,}/g },
  {
    type: 'OpenAI API key',
    env: 'OPENAI_API_KEY',
    pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g,
  },
  { type: 'API key (sk-…)', env: 'API_KEY', pattern: /\bsk-[A-Za-z0-9]{32,}\b/g },
  {
    type: 'GitHub token',
    env: 'GITHUB_TOKEN',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b/g,
  },
  { type: 'Slack token', env: 'SLACK_TOKEN', pattern: /\bxox[baprs]-\d{6,}-[A-Za-z0-9-]{10,}/g },
  {
    type: 'Slack webhook URL',
    env: 'SLACK_WEBHOOK_URL',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/g,
  },
  { type: 'Stripe live key', env: 'STRIPE_SECRET_KEY', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { type: 'Google API key', env: 'GOOGLE_API_KEY', pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  {
    type: 'private key',
    env: 'PRIVATE_KEY_PATH',
    // a header alone is documentation; a real key has a base64 body (after
    // real newlines, or `\n` escapes inside a JSON string)
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\\n|\s)+(?:[\w-]+:[^\n]*(?:\\n|\s)+)*[A-Za-z0-9+/]{40,}/g,
  },
  {
    type: 'database URL with a password',
    env: 'DATABASE_URL',
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/'"`]+:([^\s@/'"`]+)@([^\s/:'"`?,]+)/g,
    secret: match => match[1]!,
    isReal: match =>
      !DEFAULT_PASSWORD.test(match[1]!) &&
      !/^[$%]/.test(match[1]!) &&
      !LOCAL_HOST.test(match[2]!) &&
      !DOC_HOST.test(match[2]!),
  },
]

// Stricter, for files that tend to be public: any credential-named assignment
// with a random-looking value.
const ASSIGNMENT: Rule = {
  type: 'credential-looking value',
  env: 'API_KEY',
  pattern:
    /\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|token|password|passwd)["']?\s*[:=]\s*["'`]?([A-Za-z0-9_\-+/=.]{16,})/gi,
  secret: match => match[1]!,
  isReal: match => /[A-Za-z]/.test(match[1]!) && /\d/.test(match[1]!) && new Set(match[1]).size >= 10,
}

const PLACEHOLDER =
  /x{4,}|example|your|placeholder|dummy|fake|sample|changeme|redacted|replace|insert|<|>|\$\{|\{\{|\*{3,}|\.\.\.|…|0{8,}|1234567|abcdefg/i

/** True for a value no one would issue: `sk-xxxx`, `<your-key>`, `${API_KEY}`, `AKIA…EXAMPLE`. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || new Set(value).size < 8
}

export function findSecrets(text: string, options: { strict?: boolean } = {}): Finding[] {
  const rules = options.strict ? [...RULES, ASSIGNMENT] : RULES
  const found: (Finding & { start: number; end: number })[] = []

  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      const start = match.index
      const end = start + match[0].length
      const value = rule.secret ? rule.secret(match) : match[0]
      if (found.some(f => start < f.end && f.start < end)) continue // an earlier rule has it
      if (isPlaceholder(value) || (rule.isReal && !rule.isReal(match))) continue
      const line = text.slice(0, start).split('\n').length
      found.push({ type: rule.type, env: rule.env, line, value, start, end })
    }
  }
  return found.sort((a, b) => a.start - b.start).map(({ start, end, ...finding }) => finding)
}

/** Secrets in `after` that `before` does not already hold: what a write adds. */
export function newSecrets(after: string, before: string, options: { strict?: boolean } = {}): Finding[] {
  return findSecrets(after, options).filter(finding => !before.includes(finding.value))
}

const basename = (path: string) => path.split(/[\\/]/).at(-1) ?? path

/** `.env`, `.env.local`, `.dev.vars`: where secrets belong. Not `.env.example`. */
export function isEnvFile(path: string): boolean {
  const name = basename(path.replace(/^["']|["']$/g, ''))
  if (name === '.dev.vars') return true
  return /^\.env(\.[\w.-]+)?$/.test(name) && !/\.(example|sample|template|dist|defaults?)$/i.test(name)
}

/** CLAUDE.md and AGENTS.md: instruction files that are often committed and public. */
export function isPublicInstructions(path: string): boolean {
  return /^(CLAUDE|AGENTS)\.md$/i.test(basename(path))
}

/** The files a shell command writes to with `>`, `>>` or `tee`. */
export function bashWriteTargets(command: string): string[] {
  const targets: string[] = []
  for (const match of command.matchAll(/(?:^|[^<>&\d])\d?>>?\|?\s*([^\s;&|<>()]+)/g)) targets.push(match[1]!)
  for (const match of command.matchAll(/\btee\s+(?:-\w+\s+)*([^\s;&|<>()]+)/g)) targets.push(match[1]!)
  return targets
    .map(target => target.replace(/^["']|["']$/g, ''))
    .filter(target => !/^\/dev\/(null|stdout|stderr|tty)$/.test(target))
}

/** "a GitHub token", "an AWS access key". */
export const withArticle = (type: string) => `${/^[AEIOU]/i.test(type) ? 'an' : 'a'} ${type}`
