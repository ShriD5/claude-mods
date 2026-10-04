import type { On } from 'claude-code'
import { describe, type Engine, expect, mock, test } from 'claude-code/testing'

import { proposedWrite } from '../hooks/register'
import { KEYS } from './keys'

// The world beneath the plugin: files on disk, the tool itself, the store, toasts.
function world(on: On, files: Record<string, string> = {}) {
  const ran: string[] = []
  const toasts: string[] = []
  mock.store(on)
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  on('tool.call', ($, e) => (ran.push(String(e.tool)), { result: 'done' }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  return { ran, toasts }
}

// What the model reads back: the deny reason, or nothing when the call ran.
const refusal = (result: unknown) => {
  const r = result as { deny?: string; isError?: boolean; text?: string }
  return r.deny ?? (r.isError ? r.text : undefined)
}

const report = ($: Engine) =>
  $.command.run({ command: 'secret-guard', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

describe('secret-guard', () => {
  test('blocks a key written into a source file, without repeating it', async ($, on) => {
    const { ran, toasts } = world(on)

    const result = await $.tool.call({ tool: 'Write', file_path: '/app/src/config.ts', content: `export const config = {\n  github: "${KEYS.github}",\n}\n` })

    const reason = refusal(result)
    expect(reason).toContain('a GitHub token (line 2) into /app/src/config.ts')
    expect(reason).toContain('.env')
    expect(reason).toContain('.gitignore')
    expect(reason).toContain('GITHUB_TOKEN')
    expect(reason).not.toContain(KEYS.github)
    expect(ran).toEqual([])
    expect(toasts).toEqual(['🔒 secret-guard blocked a GitHub token in config.ts'])
  })

  test('lets the same key go into .env', async ($, on) => {
    const { ran } = world(on)

    const result = await $.tool.call({ tool: 'Write', file_path: '/app/.env', content: `GITHUB_TOKEN=${KEYS.github}\n` })

    expect(refusal(result)).toBeUndefined()
    expect(ran).toEqual(['Write'])
  })

  test('lets placeholders and env references through', async ($, on) => {
    const { ran } = world(on)

    await $.tool.call({ tool: 'Write', file_path: '/app/.env.example', content: 'GITHUB_TOKEN=ghp_your_token_here\n' })
    await $.tool.call({ tool: 'Write', file_path: '/app/src/gh.ts', content: 'const token = process.env.GITHUB_TOKEN\n' })

    expect(ran).toEqual(['Write', 'Write'])
  })

  test('reports an Edit by its line in the file', async ($, on) => {
    world(on, { '/app/src/db.ts': 'import pg from "pg"\n\n// connect\nconst url = ""\n' })

    const result = await $.tool.call({ tool: 'Edit', file_path: '/app/src/db.ts', old_string: 'const url = ""', new_string: `const url = "${KEYS.postgres}"` })

    expect(refusal(result)).toContain('a database URL with a password (line 4)')
    expect(refusal(result)).toContain('DATABASE_URL')
  })

  test('allows editing around a secret the file already holds', async ($, on) => {
    const line = `const key = "${KEYS.stripe}"`
    const { ran } = world(on, { '/app/pay.ts': `${line}\n` })

    await $.tool.call({ tool: 'Edit', file_path: '/app/pay.ts', old_string: line, new_string: `${line} // TODO move to env` })
    await $.tool.call({ tool: 'Write', file_path: '/app/pay.ts', content: `${line}\nexport {}\n` })

    expect(ran).toEqual(['Edit', 'Write'])
  })

  test('is extra strict about CLAUDE.md and says why', async ($, on) => {
    world(on)

    const result = await $.tool.call({ tool: 'Write', file_path: '/app/CLAUDE.md', content: '# Notes\n\nStaging api_key: "q8Zr2LmK9vT4pXw7nB3c"\n' })

    expect(refusal(result)).toContain('a credential-looking value (line 3)')
    expect(refusal(result)).toContain('25,784 CLAUDE.md files, 275 contained real-looking secrets')
  })

  test('blocks shell commands that write a key to a file, not to .env', async ($, on) => {
    const { ran } = world(on)

    const blocked = await $.tool.call({ tool: 'Bash', command: `echo '{"key":"${KEYS.anthropic}"}' > config.json` })
    await $.tool.call({ tool: 'Bash', command: `echo "ANTHROPIC_API_KEY=${KEYS.anthropic}" >> .env` })
    await $.tool.call({ tool: 'Bash', command: `curl -H "x-api-key: ${KEYS.anthropic}" https://api.anthropic.com/v1/models` })

    expect(refusal(blocked)).toContain('an Anthropic API key (line 1) into config.json (via Bash)')
    expect(ran).toEqual(['Bash', 'Bash'])
  })

  test('counts what it blocked for /secret-guard', async ($, on) => {
    world(on)
    expect((await report($)).text).toBe("🔒 secret-guard hasn't had to block any secrets yet.")

    await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: `${KEYS.github}\n${KEYS.aws}` })
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: 'b.ipynb', new_source: `key = "${KEYS.github}"` })

    expect((await report($)).text).toBe('🔒 secret-guard has blocked 3 secrets so far: 2 × GitHub token, 1 × AWS access key.')
  })
})

describe('proposedWrite', () => {
  test('reads each file tool, MultiEdit included', () => {
    expect(proposedWrite('Write', { file_path: 'a', content: 'x' })).toEqual({ path: 'a', after: 'x', before: '' })
    expect(proposedWrite('Edit', { file_path: 'a', old_string: 'o', new_string: 'n' })).toEqual({ path: 'a', after: 'n', before: 'o' })
    expect(
      proposedWrite('MultiEdit', { file_path: 'a', edits: [{ old_string: 'o1', new_string: 'n1' }, { old_string: 'o2', new_string: 'n2' }] }),
    ).toEqual({ path: 'a', after: 'n1\nn2', before: 'o1\no2' })
    expect(proposedWrite('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 's' })).toEqual({ path: 'n.ipynb', after: 's', before: '' })
    expect(proposedWrite('Read', { file_path: 'a' })).toBeUndefined()
  })
})
