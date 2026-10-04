import type { On } from 'claude-code'
import { describe as group, expect, test } from 'claude-code/testing'

import { describe, parseChoice } from '../hooks/telegram'

const OPTIONS = { botToken: '123:SECRET-TOKEN', chatId: '42', timeoutSeconds: 60 }
const REQUEST = { tool_name: 'Bash', tool_input: { command: 'npm publish' } }

type Call = { method: string; body: Record<string, any> }

// The world beneath the plugin: Telegram, the clock and the display.
function world(on: On, updates: (calls: Call[]) => unknown[] | Promise<unknown[]>, send?: { status: number; reply: object }) {
  const calls: Call[] = []
  const shown = { status: [] as (string | undefined)[], toasts: [] as string[], notices: [] as (string | undefined)[] }
  let now = 1_000_000
  let noticed: () => void = () => {}
  const wasNoticed = new Promise<void>(resolve => (noticed = resolve))

  on('http.fetch', async ($, e) => {
    const method = e.url.split('/').at(-1) ?? ''
    const call = { method, body: JSON.parse(e.init?.body ?? '{}') }
    calls.push(call)
    if (method === 'sendMessage') {
      if (send) return { value: { status: send.status, ok: false, headers: {}, text: JSON.stringify(send.reply) } }
    }
    const result = method === 'sendMessage' ? { message_id: 7 } : method === 'getUpdates' ? await updates(calls) : true
    if (method === 'getUpdates') now += 30_000
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, result }) } }
  })
  on('clock.now', () => ({ value: now }))
  on('ui.status', ($, e) => (shown.status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (shown.toasts.push(e.text), { value: undefined }))
  on('ui.notice', ($, e) => (shown.notices.push(e.text), noticed(), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return { calls, shown, wasNoticed }
}

const nonceOf = (calls: Call[]): string =>
  calls.find(c => c.method === 'sendMessage')?.body.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1]

const press = (calls: Call[], choice: 'allow' | 'deny', chat = 42) => [
  { update_id: 100, callback_query: { id: `cb-${chat}`, data: `pa:${nonceOf(calls)}:${choice}`, message: { message_id: 7, chat: { id: chat } } } },
]

const methods = (calls: Call[]) => calls.map(c => c.method)

group('phone-approve', () => {
  test('approves from the phone', { options: OPTIONS }, async ($, on) => {
    on('classic.PermissionRequest', () => ({}))
    const { calls, shown } = world(on, calls => press(calls, 'allow'))

    const result = await $.classic.PermissionRequest(REQUEST)

    expect(result.decision).toEqual({ behavior: 'allow' })
    const message = calls.find(c => c.method === 'sendMessage')!
    expect(message.body.chat_id).toBe('42')
    expect(message.body.text).toContain('npm publish')
    expect(calls.find(c => c.method === 'editMessageText')?.body.text).toContain('Approved from phone')
    expect(calls.find(c => c.method === 'answerCallbackQuery')?.body.text).toBe('Approved')
    expect(shown.status).toEqual(['📱 waiting for phone…', undefined])
    expect(shown.toasts).toEqual(['📱 Approved Bash from phone'])
  })

  test('denies from the phone, ignoring presses from other chats', { options: OPTIONS }, async ($, on) => {
    on('classic.PermissionRequest', () => ({}))
    let polls = 0
    const { calls } = world(on, calls => (++polls === 1 ? press(calls, 'allow', 99) : press(calls, 'deny')))

    const result = await $.classic.PermissionRequest(REQUEST)

    expect(result.decision).toEqual({ behavior: 'deny', message: 'The person denied this from their phone.' })
    expect(calls.find(c => c.method === 'editMessageText')?.body.text).toContain('Denied from phone')
    // a press from any other chat is ignored: never answered, never decides
    expect(calls.filter(c => c.method === 'answerCallbackQuery').map(c => c.body.callback_query_id)).toEqual(['cb-42'])
  })

  test('falls back to the terminal prompt after the timeout', { options: OPTIONS }, async ($, on) => {
    on('classic.PermissionRequest', () => ({}))
    const { calls, shown } = world(on, () => [])

    const result = await $.classic.PermissionRequest(REQUEST)

    expect(result).toEqual({})
    expect(methods(calls).filter(m => m === 'getUpdates').length).toBe(2)
    expect(calls.find(c => c.method === 'editMessageText')?.body.text).toContain('No answer in 60 s')
    expect(shown.status.at(-1)).toBeUndefined()
  })

  test('stops waiting when the person answers in the terminal', { options: OPTIONS }, async ($, on) => {
    on('classic.PermissionRequest', () => ({}))
    let releasePoll: () => void = () => {}
    const { calls, shown, wasNoticed } = world(on, () => new Promise<unknown[]>(resolve => (releasePoll = () => resolve([]))))
    let asked: Promise<unknown> = Promise.resolve()
    // The engine's side of a call: the dialog opens (PermissionRequest) with the
    // plugin's line under it, the person presses Yes there, the tool runs.
    on('tool.call', async () => {
      asked = $.classic.PermissionRequest(REQUEST)
      await wasNoticed
      return { result: 'published' }
    })

    await $.tool.call({ tool: 'Bash', command: 'npm publish' })
    const result = await asked
    releasePoll()

    expect(result).toEqual({})
    expect(shown.notices).toEqual(['📱 also sent to Telegram: answer here or on your phone'])
    expect(calls.find(c => c.method === 'editMessageText')?.body.text).toContain('Answered in the terminal')
  })

  test('leaves a decision made beneath it alone', { options: OPTIONS }, async ($, on) => {
    const decided = { decision: { behavior: 'deny' as const, message: 'policy' } }
    on('classic.PermissionRequest', () => decided)
    const { calls } = world(on, () => [])

    expect(await $.classic.PermissionRequest(REQUEST)).toEqual(decided)
    expect(calls).toEqual([])
  })

  test('does nothing until configured', async ($, on) => {
    on('classic.PermissionRequest', () => ({}))
    const { calls } = world(on, () => [])

    expect(await $.classic.PermissionRequest(REQUEST)).toEqual({})
    expect(calls).toEqual([])
  })

  test('reports a Telegram error without the token', { options: OPTIONS }, async ($, on) => {
    on('classic.PermissionRequest', () => ({}))
    const { shown } = world(on, () => [], { status: 401, reply: { ok: false, description: 'Unauthorized' } })

    expect(await $.classic.PermissionRequest(REQUEST)).toEqual({})
    expect(shown.toasts).toEqual(['📱 Telegram sendMessage failed (401): Unauthorized'])
    expect(shown.toasts.join(' ')).not.toContain('SECRET')
  })
})

group('telegram helpers', () => {
  test('describes requests readably and escapes HTML', () => {
    expect(describe('Bash', { command: 'echo <b> && ls', description: 'List' }, 'app')).toBe(
      '🔐 <b>Claude Code wants to use Bash</b>\n📁 app\n\n<pre>echo &lt;b&gt; &amp;&amp; ls</pre>\n<i>List</i>',
    )
    expect(describe('Write', { file_path: '/a/b.ts', content: 'x\ny' }, 'app')).toContain('<code>/a/b.ts</code> (2 lines)')
    expect(describe('mcp__db__query', { sql: 'select 1' }, 'app')).toContain('"sql": "select 1"')
  })

  test('parses only its own callback data', () => {
    expect(parseChoice('pa:abc123:allow')).toEqual({ nonce: 'abc123', choice: 'allow' })
    expect(parseChoice('pa:abc123:maybe')).toBeUndefined()
    expect(parseChoice('other')).toBeUndefined()
    expect(parseChoice(undefined)).toBeUndefined()
  })
})
