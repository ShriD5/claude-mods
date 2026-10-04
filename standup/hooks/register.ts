import type { EngineInterface, Register } from 'claude-code'

import { buildPrompt, label, parseLog, rawList, repoPaths, sinceDay, tidy } from './days'
import type { RepoLog } from './days'

async function run($: EngineInterface, argv: string[]): Promise<string | undefined> {
  const ran = await $.process.run(argv, { timeoutMs: 15_000 }).catch(() => undefined)

  return ran?.exitCode === 0 ? ran.stdout.trim() : undefined
}

/** Each repo's commits by `email` since the morning of `since`, repos deduplicated by their root. */
async function collect($: EngineInterface, paths: readonly string[], email: string, since: string): Promise<{ logs: RepoLog[]; missing: string[] }> {
  const logs: RepoLog[] = []
  const missing: string[] = []
  const seen = new Set<string>()

  for (const path of paths) {
    const root = await run($, ['git', '-C', path, 'rev-parse', '--show-toplevel'])

    if (root === undefined) {
      missing.push(path)
      continue
    }

    if (seen.has(root)) {
      continue
    }

    seen.add(root)
    const stdout = await run($, [
      'git', '-C', root, 'log', '--all', '--no-merges', '--regexp-ignore-case',
      `--author=${email}`, `--since=${since} 00:00`,
      '--format=%h%x09%ad%x09%s', '--date=format:%Y-%m-%d %H:%M',
    ])
    logs.push({ repo: root.split('/').pop() ?? root, commits: parseLog(stdout ?? '') })
  }

  return { logs, missing }
}

export const register: Register = (on, options) => {
  const model = String(options.model ?? 'haiku') || 'haiku'
  const extraRepos = String(options.repos ?? '')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'standup',
      description: "Write yesterday's standup from your commits (raw: just the commit list)",
      argumentHint: '[raw]',
    })

    return next(e)
  })

  on('command.run', { command: 'standup' }, async ($, e) => {
    const isRaw = e.args.trim().toLowerCase() === 'raw'
    const [today = '', isoWeekday = '1'] = ((await run($, ['date', '+%Y-%m-%d %u'])) ?? '').split(' ')
    const email = await run($, ['git', 'config', 'user.email'])

    if (today === '' || email === undefined || email === '') {
      return { text: 'standup: no git user.email set (git config --global user.email you@example.com), so there is no telling which commits are yours.' }
    }

    const since = sinceDay(today, Number(isoWeekday))
    const paths = [await $.session.cwd(), ...repoPaths(extraRepos, await $.env.get('HOME'))]
    const { logs, missing } = await collect($, paths, email, since)
    const count = logs.reduce((sum, log) => sum + log.commits.length, 0)
    const skipped = missing.length === 0 ? '' : `\n· not a git repo, skipped: ${missing.join(', ')}`

    if (count === 0) {
      const where = logs.length === 0 ? 'any repo' : logs.map(log => log.repo).join(', ')

      return { text: `No commits by ${email} since ${label(since)} in ${where}.${skipped}` }
    }

    const list = rawList(logs, today)

    if (isRaw) {
      return { text: `${count} commit${count === 1 ? '' : 's'} by ${email} since ${label(since)}\n\n${list}${skipped}` }
    }

    const reply = await $.model.complete({ model, prompt: buildPrompt(list, since, today), maxTokens: 600, timeoutMs: 45_000 })

    if (!reply.isAnswered) {
      return { text: `standup: the model gave no answer (${reply.reason}). Here are the commits:\n\n${list}${skipped}` }
    }

    const standup = tidy(reply.text)
    const copied = await $.ui.copy({ text: standup })

    return { text: `${standup}\n\n· ${copied.isCopied ? 'copied to clipboard' : `not copied (${copied.reason})`} · from ${count} commits since ${label(since)} · /standup raw for the list${skipped}` }
  })
}
