import type { HttpInit, HttpResponse } from 'claude-code'

// A tiny Telegram Bot API client over the host's fetch. The token only ever
// appears in the request URL, which is never logged or put in an error.

export type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

export type CallbackQuery = {
  id: string
  data?: string
  message?: { message_id: number; chat: { id: number } }
}

export type Update = { update_id: number; callback_query?: CallbackQuery }

export class TelegramError extends Error {
  constructor(method: string, status: number, description: string) {
    super(`Telegram ${method} failed (${status}): ${description}`)
  }
}

export function telegram(fetch: Fetch, token: string) {
  async function call<T>(method: string, body: object): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let reply: { ok?: boolean; result?: T; description?: string } = {}
    try {
      reply = JSON.parse(res.text)
    } catch {
      // fall through: reported below without the body
    }
    if (!reply.ok) throw new TelegramError(method, res.status, reply.description ?? 'no reply')
    return reply.result as T
  }

  return {
    send: (chatId: string, html: string, nonce: string) =>
      call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `pa:${nonce}:allow` },
              { text: '❌ Deny', callback_data: `pa:${nonce}:deny` },
            ],
          ],
        },
      }),
    // Without reply_markup the buttons are removed.
    edit: (chatId: string, messageId: number, html: string) =>
      call('editMessageText', { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML' }),
    answer: (callbackId: string, text: string) =>
      call('answerCallbackQuery', { callback_query_id: callbackId, text }),
    updates: (offset: number | undefined, timeoutSeconds: number) =>
      call<Update[]>('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['callback_query'] }),
  }
}

export type Bot = ReturnType<typeof telegram>

/** `pa:<nonce>:allow|deny` -> its parts, or undefined for anything else. */
export function parseChoice(data: string | undefined) {
  const match = /^pa:([a-z0-9]+):(allow|deny)$/.exec(data ?? '')
  return match ? { nonce: match[1]!, choice: match[2] as 'allow' | 'deny' } : undefined
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** The request as a readable Telegram message (HTML), whatever the tool. */
export function describe(tool: string, input: unknown, project: string): string {
  const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  const pre = (body: string) => `<pre>${escape(clip(body, 1500))}</pre>`

  let body: string
  switch (tool) {
    case 'Bash':
      body = pre(text('command')) + (text('description') ? `\n<i>${escape(text('description'))}</i>` : '')
      break
    case 'Write':
      body = `📝 <code>${escape(text('file_path'))}</code> (${text('content').split('\n').length} lines)`
      break
    case 'Edit':
      body = `✏️ <code>${escape(text('file_path'))}</code>\n${pre(text('new_string'))}`
      break
    case 'MultiEdit':
      body = `✏️ <code>${escape(text('file_path'))}</code> (${Array.isArray(args.edits) ? args.edits.length : 0} edits)`
      break
    case 'NotebookEdit':
      body = `📓 <code>${escape(text('notebook_path'))}</code>\n${pre(text('new_source'))}`
      break
    case 'Read':
      body = `📖 <code>${escape(text('file_path'))}</code>`
      break
    case 'WebFetch':
      body = `🌐 ${escape(text('url'))}`
      break
    case 'WebSearch':
      body = `🔎 ${escape(text('query'))}`
      break
    default:
      body = pre(JSON.stringify(args, null, 1))
  }
  return `🔐 <b>Claude Code wants to use ${escape(tool)}</b>\n📁 ${escape(project)}\n\n${body}`
}
