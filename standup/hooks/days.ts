// Pure helpers for /standup: which days count, reading git log, and the model's prompt.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function utcOf(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number)

  return new Date(Date.UTC(year, month - 1, date))
}

/** "2026-10-02" -> "Fri 2 Oct" (calendar arithmetic only, so no time zone gets a say). */
export function label(day: string): string {
  const date = utcOf(day)

  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

export function weekday(day: string): string {
  return DAYS[utcOf(day).getUTCDay()] ?? ''
}

/**
 * The first day the standup covers: yesterday, or Friday when today is
 * Saturday, Sunday or Monday. `isoWeekday` is `date +%u`: 1 Monday ... 7 Sunday.
 */
export function sinceDay(today: string, isoWeekday: number): string {
  const back = isoWeekday === 1 ? 3 : isoWeekday === 7 ? 2 : 1
  const date = utcOf(today)
  date.setUTCDate(date.getUTCDate() - back)

  return date.toISOString().slice(0, 10)
}

export type Commit = { sha: string; day: string; time: string; subject: string }
export type RepoLog = { repo: string; commits: Commit[] }

/** Lines of `git log --format=%h%x09%ad%x09%s --date=format:'%Y-%m-%d %H:%M'`. */
export function parseLog(stdout: string): Commit[] {
  return stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [sha = '', when = '', ...subject] = line.split('\t')
      const [day = '', time = ''] = when.split(' ')

      return { sha, day, time, subject: subject.join('\t') }
    })
}

/** The repo list, one block per repo, oldest commit first. */
export function rawList(logs: readonly RepoLog[], today: string): string {
  return logs
    .filter(log => log.commits.length > 0)
    .map(log => {
      const rows = [...log.commits].reverse().map(commit => `  ${commit.sha}  ${commit.day === today ? 'today' : weekday(commit.day)} ${commit.time}  ${commit.subject}`)

      return [`${log.repo} (${log.commits.length})`, ...rows].join('\n')
    })
    .join('\n\n')
}

/** Paths from the option: commas or newlines between them, `~/` expanded. */
export function repoPaths(option: string, home: string | undefined): string[] {
  return option
    .split(/[,\n]/)
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => (home !== undefined && (path === '~' || path.startsWith('~/')) ? `${home}${path.slice(1)}` : path))
}

export function buildPrompt(list: string, since: string, today: string): string {
  return [
    `Write my daily standup from my git commits since ${label(since)} (today is ${label(today)}).`,
    '',
    'Use exactly this shape, plain text, no markdown headings or bold:',
    'Yesterday',
    '- ...',
    'Today',
    '- ...',
    'Blockers',
    '- ...',
    '',
    'Rules:',
    '- Yesterday: 2 to 5 short bullets of what got done, merged from related commits, outcomes over file names, name the repo when there are several',
    '- Today: 1 to 3 bullets of the natural next steps, judged from where the work stopped (commits marked "today" are already under way)',
    '- Blockers: "None" unless a commit says something is blocked, reverted or waiting on someone',
    '- each bullet under 12 words, plain words, no emojis, no em dashes, no filler like "worked on"',
    '',
    '<commits>',
    list,
    '</commits>',
  ].join('\n')
}

/** Keeps the model's three sections and drops anything it wrapped around them. */
export function tidy(reply: string): string {
  const text = reply
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .trim()
  const start = text.search(/^Yesterday\b/m)

  return start === -1 ? text : text.slice(start).trim()
}
