import type { EngineInterface, Register } from 'claude-code'

import { findCommit, rewrite } from './commit'
import type { CommitCall } from './commit'
import { buildPrompt, laziness, readReply, split, stripAttribution, trimDiff } from './message'

async function git($: EngineInterface, call: CommitCall, args: string[]): Promise<string | undefined> {
  const argv = call.dir === undefined ? ['git', ...args] : ['git', '-C', call.dir, ...args]
  const ran = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)

  return ran?.exitCode === 0 ? ran.stdout : undefined
}

/** The change the commit will record, as the model should see it. */
async function diffOf($: EngineInterface, call: CommitCall): Promise<string> {
  if (call.isAmend) {
    const patch = await git($, call, ['diff', '--cached', 'HEAD~1'])

    if (patch !== undefined) {
      return trimDiff((await git($, call, ['diff', '--cached', '--stat', 'HEAD~1'])) ?? '', patch)
    }
  }

  // With -a, or a `git add` earlier in the same command, the index is not final yet: read the work tree.
  if (call.isAll || call.isAddedFirst) {
    const untracked = call.isAddedFirst ? ((await git($, call, ['ls-files', '--others', '--exclude-standard'])) ?? '').trim() : ''
    const stat = `${(await git($, call, ['diff', '--stat', 'HEAD'])) ?? ''}${untracked === '' ? '' : `\nnew files:\n${untracked}`}`

    return trimDiff(stat, (await git($, call, ['diff', 'HEAD'])) ?? '')
  }

  return trimDiff((await git($, call, ['diff', '--cached', '--stat'])) ?? '', (await git($, call, ['diff', '--cached'])) ?? '')
}

async function suggest($: EngineInterface, model: string, call: CommitCall, original: string) {
  const diff = await diffOf($, call)

  if (diff.trim() === '') {
    return undefined
  }

  const reply = await $.model.complete({ model, prompt: buildPrompt(original, diff), maxTokens: 300, effort: 'low', timeoutMs: 20_000 })

  return reply.isAnswered ? readReply(reply.text) : undefined
}

export const register: Register = (on, options) => {
  const shouldStrip = options.stripAttribution !== false
  const shouldCoach = options.rewriteSubjects !== false
  const model = String(options.model ?? 'haiku') || 'haiku'

  if (shouldStrip) {
    // Prevention as well as cure: the model is not asked to add the trailer in the first place.
    on('attribution.text', { kind: 'commit' }, () => ({ text: '' }))
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const call = findCommit(e.command)

    if (call === undefined || call.skip !== undefined) {
      return next(e)
    }

    const path = call.file === undefined || call.dir === undefined || call.file.startsWith('/') ? call.file : `${call.dir}/${call.file}`
    const original = path === undefined ? call.message : await $.fs.read(path).catch(() => undefined)
    const isMerging = (await git($, call, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) !== undefined

    if (original === undefined || isMerging) {
      return next(e)
    }

    const stripped = shouldStrip ? stripAttribution(original) : { message: original.trim(), removed: 0 }
    const { subject, body } = split(stripped.message)
    const reason = shouldCoach ? laziness(subject) : undefined
    const better = reason === undefined ? undefined : await suggest($, model, call, stripped.message)
    const dropped = stripped.removed === 0 ? '' : ` · dropped ${stripped.removed} attribution line${stripped.removed === 1 ? '' : 's'}`

    if (subject === '' || (better === undefined && stripped.removed === 0)) {
      if (reason !== undefined) {
        $.ui.toast(`commit-coach: kept '${subject}' (${reason}; no better subject came back)`)
      }

      return next(e)
    }

    const command = rewrite(e.command, call, better?.subject ?? subject, body === '' ? (better?.body ?? '') : body)

    $.ui.toast(better === undefined ? `commit-coach${dropped.replace(' ·', ':')}` : `commit-coach: '${subject}' → '${better.subject}'${dropped}`, { timeoutMs: 6000 })

    const ran = await next({ ...e, command })

    if (ran.deny !== undefined || ran.isError) {
      return ran
    }

    // Without this the model sees a commit message it didn't write, blames a git hook, and offers to amend it back.
    const what = better === undefined ? `dropped ${stripped.removed} attribution line${stripped.removed === 1 ? '' : 's'}` : `rewrote the subject '${subject}' to '${better.subject}'`
    const note = `commit-coach (a plugin the user installed) ${what} in this commit's message before it ran. This is intended: don't amend or redo the commit to change it back.`

    return { ...ran, context: [...(ran.context ?? []), note] }
  })
}
