import type { EngineInterface, Register } from 'claude-code'

import { describe, parseChoice, telegram, type Bot } from './telegram'

type Choice = 'allow' | 'deny'
type Outcome =
  | { kind: 'phone'; choice: Choice; callbackId: string }
  | { kind: 'terminal' }
  | { kind: 'timeout' }
  | { kind: 'failed'; error: unknown }

// getUpdates long-polls this long at most, so an abandoned wait ends quickly.
const POLL_SECONDS = 10
const MAX_FAILURES = 3

// Telegram refuses two getUpdates at once, so every waiting request shares one
// poll and the poll hands each button press to the request whose nonce it carries.
const waiting = new Map<string, (choice: Choice, callbackId: string) => void>()
let offset: number | undefined
let polling: Promise<void> | undefined

// Calls in flight, by tool and input: the permission event carries no
// tool_use_id, so this is how a request finds its call's dialog and learns
// that the call went on without the phone (answered in the terminal).
const callIds = new Map<string, string>()
const onCallSettled = new Map<string, () => void>()

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const keyOf = (tool: string, input: unknown) => `${tool} ${stable(input)}`

function showStatus($: EngineInterface) {
  const n = waiting.size
  $.ui.status(n === 0 ? undefined : `📱 waiting for phone…${n > 1 ? ` (${n})` : ''}`)
}

export const register: Register = (on, options) => {
  const token = String(options.botToken ?? '').trim()
  const chatId = String(options.chatId ?? '').trim()
  const timeoutMs = Math.max(5, Number(options.timeoutSeconds) || 120) * 1000
  const isConfigured = token !== '' && chatId !== ''

  const poll = (bot: Bot, seconds: number) => {
    polling ??= bot
      .updates(offset, seconds)
      .then(updates => {
        for (const update of updates) {
          offset = update.update_id + 1
          const press = update.callback_query
          if (press === undefined || String(press.message?.chat.id) !== chatId) continue
          const parsed = parseChoice(press.data)
          const waiter = parsed && waiting.get(parsed.nonce)
          if (parsed && waiter) waiter(parsed.choice, press.id)
          else void bot.answer(press.id, 'This request is no longer waiting.').catch(() => {})
        }
      })
      .finally(() => {
        polling = undefined
      })
    return polling
  }

  on('session.start', async ($, e, next) => {
    if (!isConfigured) {
      $.ui.log('phone-approve is off: set botToken and chatId (claude plugin configure phone-approve).')
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!isConfigured) return next(e)
    const { tool, tool_use_id, agentId, ...input } = e as Record<string, unknown>
    const key = keyOf(String(tool), input)
    callIds.set(key, String(tool_use_id))
    try {
      return await next(e)
    } finally {
      callIds.delete(key)
      onCallSettled.get(key)?.()
    }
  })

  // Fires when Claude Code is about to ask the person. Rules, modes and the
  // settings hooks beneath have had their say: only a real "ask" reaches the phone.
  on('classic.PermissionRequest', async ($, e, next) => {
    const below = await next(e)
    if (!isConfigured || below.decision !== undefined || below.block !== undefined) return below

    const bot = telegram((url, init) => $.http.fetch(url, init), token)
    const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    const key = keyOf(e.tool_name, e.tool_input)
    const project = e.cwd.split('/').filter(Boolean).at(-1) ?? e.cwd
    const html = describe(e.tool_name, e.tool_input, project)

    // Listen before sending: the person may answer in the terminal meanwhile.
    let answer: (outcome: Outcome) => void = () => {}
    const answered = new Promise<Outcome>(resolve => (answer = resolve))
    waiting.set(nonce, (choice, callbackId) => answer({ kind: 'phone', choice, callbackId }))
    onCallSettled.set(key, () => answer({ kind: 'terminal' }))
    next.signal.addEventListener('abort', () => answer({ kind: 'terminal' }), { once: true })

    const wait = async (): Promise<Outcome> => {
      const deadline = (await $.clock.now()) + timeoutMs
      let failures = 0
      for (;;) {
        const left = deadline - (await $.clock.now())
        if (left <= 0) return { kind: 'timeout' }
        const polled = poll(bot, Math.min(POLL_SECONDS, Math.ceil(left / 1000))).then(
          () => undefined,
          (error: unknown): Outcome => ({ kind: 'failed', error }),
        )
        const outcome = await Promise.race([polled, answered])
        if (outcome === undefined) failures = 0
        else if (outcome.kind !== 'failed') return outcome
        else if (++failures >= MAX_FAILURES) return outcome
      }
    }

    let messageId: number
    let outcome: Outcome
    try {
      try {
        messageId = (await bot.send(chatId, html, nonce)).message_id
      } catch (error) {
        $.ui.toast(`📱 ${error instanceof Error ? error.message : 'Telegram send failed'}`)
        return below
      }
      const callId = callIds.get(key)
      if (callId !== undefined) $.ui.notice(callId, '📱 also sent to Telegram: answer here or on your phone')
      showStatus($)
      outcome = await wait()
    } finally {
      waiting.delete(nonce)
      onCallSettled.delete(key)
      showStatus($)
    }

    const footer = {
      phone: outcome.kind === 'phone' && outcome.choice === 'allow' ? '✅ <b>Approved from phone</b>' : '❌ <b>Denied from phone</b>',
      terminal: '💻 Answered in the terminal',
      timeout: `⏱ No answer in ${timeoutMs / 1000} s: asked in the terminal`,
      failed: '⚠️ Stopped listening: asked in the terminal',
    }[outcome.kind]
    await bot.edit(chatId, messageId, `${html}\n\n${footer}`).catch(() => {})

    if (outcome.kind === 'failed') {
      $.ui.toast(`📱 ${outcome.error instanceof Error ? outcome.error.message : 'Telegram poll failed'}`)
    }
    if (outcome.kind !== 'phone') return below

    await bot.answer(outcome.callbackId, outcome.choice === 'allow' ? 'Approved' : 'Denied').catch(() => {})
    $.ui.toast(outcome.choice === 'allow' ? `📱 Approved ${e.tool_name} from phone` : `📱 Denied ${e.tool_name} from phone`)
    return outcome.choice === 'allow'
      ? { ...below, decision: { behavior: 'allow' } }
      : { ...below, decision: { behavior: 'deny', message: 'The person denied this from their phone.' } }
  })
}
