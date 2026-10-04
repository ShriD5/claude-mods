// Pure helpers for /ship: what the model is asked, and how its draft is checked.
import type { ShipPlatform } from '../types'

export const LIMITS: Record<ShipPlatform, number> = { x: 280, linkedin: 1300 }

const BANNED = [
  'officially',
  'game-changer',
  'game changer',
  'excited to announce',
  'thrilled to',
  'delighted to',
  'just dropped',
  'stay tuned',
]

export type ShipArgs = { platform: ShipPlatform; isAgain: boolean }

/** `/ship`, `/ship again`, `/ship linkedin`, `/ship again linkedin`, `/ship x`. */
export function parseArgs(args: string, lastPlatform: ShipPlatform | undefined): ShipArgs {
  const words = args.toLowerCase().split(/\s+/).filter(Boolean)
  const isAgain = words.includes('again')
  const named = words.find(word => word === 'linkedin' || word === 'li' || word === 'x' || word === 'twitter')
  const platform: ShipPlatform =
    named === undefined ? (isAgain ? (lastPlatform ?? 'x') : 'x') : named === 'linkedin' || named === 'li' ? 'linkedin' : 'x'

  return { platform, isAgain }
}

export type ShipContext = {
  commits: string
  diffStat: string
  prompts: readonly string[]
  minutes: number
}

/** Keeps the head of a list of lines and says how many were cut. */
export function clip(text: string, maxLines: number): string {
  const lines = text.trim().split('\n').filter(Boolean)

  return lines.length <= maxLines ? lines.join('\n') : [...lines.slice(0, maxLines), `(+${lines.length - maxLines} more)`].join('\n')
}

/** The diffstat's per-file rows cut down, its summary line ("3 files changed, ...") always kept. */
export function clipStat(stat: string, maxFiles: number): string {
  const lines = stat.trim().split('\n').filter(Boolean)
  const summary = lines.at(-1)?.includes('changed') ? lines.pop() : undefined
  const files = lines.length <= maxFiles ? lines : [...lines.slice(0, maxFiles), ` (+${lines.length - maxFiles} more files)`]

  return [...files, ...(summary === undefined ? [] : [summary])].join('\n')
}

export function hasWork(context: ShipContext): boolean {
  return context.commits.trim() !== '' || context.diffStat.trim() !== '' || context.prompts.length > 0
}

const VOICE: Record<ShipPlatform, string> = {
  x: [
    'Write ONE post for X about what I built in this coding session.',
    'Rules:',
    '- all lowercase, casual, first person ("i"), like a dev texting a friend',
    '- concrete: say what got built and include one specific number or detail from the material (files, lines, a function, a bug, minutes)',
    '- under 260 characters',
    '- no hashtags, at most one emoji, no em dashes or en dashes',
    '- never use: "officially", "game-changer", "excited to announce", "thrilled", "stay tuned"',
    '- no lists of three things, no tidy aphorism or moral at the end, no call to action',
    '- use only facts from the material, never invent backstory, feelings or how long something took',
    '- reply with the post text only, no quotes, no preface',
  ].join('\n'),
  linkedin: [
    'Write ONE LinkedIn post about what I built in this coding session.',
    'Rules:',
    '- sentence case, first person, plain and direct, 3 to 6 short paragraphs of one or two sentences',
    '- concrete: what got built, why it was needed, one specific number or detail from the material, one thing that was harder than expected',
    '- at most 1,200 characters',
    '- no hashtags, no emojis, no em dashes or en dashes, no bullet lists',
    '- never use: "officially", "game-changer", "excited to announce", "thrilled", "delighted", "stay tuned"',
    '- no lists of three things, no tidy aphorism or moral at the end, no "what do you think?" call to action',
    '- use only facts from the material, never invent backstory, feelings or how long something took',
    '- reply with the post text only, no quotes, no preface',
  ].join('\n'),
}

export function buildPrompt(platform: ShipPlatform, context: ShipContext, avoid?: string, problems?: readonly string[]): string {
  const material = [
    `Session length: about ${context.minutes} minutes.`,
    context.commits.trim() === '' ? 'Commits this session: none yet.' : `Commits this session:\n${context.commits}`,
    context.diffStat.trim() === '' ? '' : `Files changed since the session started (git diff --stat):\n${context.diffStat}`,
    context.prompts.length === 0 ? '' : `What I asked the coding agent for, in order:\n${context.prompts.map(prompt => `- ${prompt}`).join('\n')}`,
  ].filter(Boolean)

  return [
    VOICE[platform],
    avoid === undefined ? '' : `\nTake a different angle from this earlier draft, do not reuse its opening:\n"""${avoid}"""`,
    problems === undefined || problems.length === 0 ? '' : `\nYour last draft broke these rules, fix them: ${problems.join('; ')}.`,
    `\n<material>\n${material.join('\n\n')}\n</material>`,
  ].join('\n')
}

/** Cleans what models tend to add around a post: quotes, a "Here's a post:" line, hashtags, dashes. */
export function tidy(raw: string, platform: ShipPlatform): string {
  let text = raw.trim()

  text = text.replace(/^(here('|’)?s|here is|sure|okay|ok)\b[^\n]*:\s*\n+/i, '')
  text = text.replace(/^["“'`]+|["”'`]+$/g, '').trim()
  text = text.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '').trim()
  text = text.replace(/\s*[—–]\s*/g, ', ')
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')

  return platform === 'x' ? text.toLowerCase() : text
}

/** The rules a draft still breaks, as short phrases the retry prompt quotes back. */
export function problemsOf(text: string, platform: ShipPlatform): string[] {
  const found: string[] = []
  const lower = text.toLowerCase()
  const limit = LIMITS[platform]

  if (text.length > limit) {
    found.push(`it is ${text.length} characters, the limit is ${limit}`)
  }

  for (const phrase of BANNED) {
    if (lower.includes(phrase)) {
      found.push(`it uses "${phrase}"`)
    }
  }

  if ((text.match(/\p{Extended_Pictographic}/gu) ?? []).length > 1) {
    found.push('it has more than one emoji')
  }

  if (text.trim() === '') {
    found.push('it is empty')
  }

  return found
}

/** Last resort for a draft still over its limit: cut at the last sentence (or word) that fits. */
export function fit(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }

  const head = text.slice(0, limit)
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'))

  if (sentence > limit * 0.5) {
    return head.slice(0, sentence + 1).trim()
  }

  return head.slice(0, head.lastIndexOf(' ')).trim()
}

/** A user prompt cut to one line for the summary. */
export function squeeze(prompt: string, max = 160): string {
  const line = prompt.replace(/\s+/g, ' ').trim()

  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}
