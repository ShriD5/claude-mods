import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ShipDraft, ShipPlatform, ShipStart } from '../types'
import { buildPrompt, clip, clipStat, fit, hasWork, LIMITS, parseArgs, problemsOf, squeeze, tidy } from './post'
import type { ShipContext } from './post'

const start = atom({ plugin: 'ship-log', key: 'start' } as const, null)
const prompts = atom({ plugin: 'ship-log', key: 'prompts' } as const, [])
const last = atom({ plugin: 'ship-log', key: 'last' } as const, null)

const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

async function git($: EngineInterface, args: string[]): Promise<string> {
  const ran = await $.process.run(['git', ...args]).catch(() => undefined)

  return ran?.exitCode === 0 ? ran.stdout.trim() : ''
}

async function gather($: EngineInterface, since: ShipStart | null): Promise<ShipContext> {
  const sha = since?.sha ?? null
  const commits = sha === null ? await git($, ['log', '--oneline', '--no-merges', '-n', '15']) : await git($, ['log', '--oneline', '--no-merges', `${sha}..HEAD`])
  const diffStat = sha === null ? await git($, ['diff', '--stat', 'HEAD']) : await git($, ['diff', '--stat', sha])
  const now = await $.clock.now()

  return {
    commits: clip(commits, 30),
    diffStat: clipStat(diffStat, 25),
    prompts: (await read($, prompts)).slice(-25),
    minutes: since === null ? 0 : Math.max(1, Math.round((now - since.at) / 60_000)),
  }
}

async function write($: EngineInterface, model: string, platform: ShipPlatform, context: ShipContext, avoid?: string) {
  let problems: string[] = []
  let text = ''

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await $.model.complete({
      model,
      prompt: buildPrompt(platform, context, avoid, attempt === 0 ? undefined : problems),
      maxTokens: platform === 'x' ? 300 : 900,
      timeoutMs: 45_000,
    })

    if (!reply.isAnswered) {
      return { error: reply.reason === 'api-error' ? `the model call failed (HTTP ${reply.status})` : `no reply (${reply.reason})` }
    }

    text = tidy(reply.text, platform)
    problems = problemsOf(text, platform)

    if (problems.length === 0) {
      break
    }
  }

  return { text: fit(text, LIMITS[platform]) }
}

export const register: Register = (on, options) => {
  const model = String(options.model ?? 'haiku') || 'haiku'
  const webhookUrl = String(options.webhookUrl ?? '').trim()
  const webhookToken = String(options.webhookToken ?? '').trim()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ship',
      description: 'Draft a build-in-public post from this session (again: another take, linkedin: longer)',
      argumentHint: '[again] [linkedin]',
    })

    // A hot reload raises session.start again: keep the start we recorded first.
    if ((await read($, start)) === null) {
      const sha = (await git($, ['rev-parse', '--verify', '-q', 'HEAD'])) || null
      const at = await $.clock.now()
      await update($, start, () => ({ sha, at }))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (USER_ORIGINS.has(e.origin.kind) && !e.text.trimStart().startsWith('/')) {
      const line = squeeze(e.text)
      await update($, prompts, list => [...list, line].slice(-40))
    }

    return next(e)
  })

  on('command.run', { command: 'ship' }, async ($, e) => {
    const previous = await read($, last)
    const { platform, isAgain } = parseArgs(e.args, previous?.platform)
    const context = await gather($, await read($, start))

    if (!hasWork(context)) {
      return { text: 'Nothing to ship yet: no commits, no changes and no prompts this session.' }
    }

    const avoid = isAgain && previous?.platform === platform ? previous.text : undefined
    const written = await write($, model, platform, context, avoid)

    if (written.text === undefined) {
      return { text: `ship-log: ${written.error}. Try /ship again.` }
    }

    const draft: ShipDraft = { platform, text: written.text }
    await update($, last, () => draft)

    const copied = await $.ui.copy({ text: draft.text })
    const notes = [
      `${copied.isCopied ? 'copied to clipboard' : `not copied (${copied.reason})`} · ${draft.text.length}/${LIMITS[platform]} chars`,
      platform === 'x' ? '/ship again for another take · /ship linkedin for a longer version' : '/ship again for another take · /ship for the X version',
    ]

    if (webhookUrl !== '') {
      const sent = await $.http
        .fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(webhookToken === '' ? {} : { authorization: `Bearer ${webhookToken}` }) },
          body: JSON.stringify({ platform, text: draft.text, source: 'ship-log' }),
        })
        .then(response => (response.ok ? `sent to webhook (${response.status})` : `webhook answered ${response.status}`))
        .catch(() => 'webhook unreachable')
      notes.push(sent)
    }

    return { text: `${draft.text}\n\n${notes.map(note => `· ${note}`).join('\n')}` }
  })
}
