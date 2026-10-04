import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardState } from '../types'
import { bandText, branchList, decide, DEFAULT_BRANCHES, gitCalls, isProtected } from './guard'

const guard = atom({ plugin: 'main-guard', key: 'guard' } as const, null)

const PROD = /^prod(uction)?$/i
const REFRESH_MS = 15_000

async function git($: EngineInterface, args: string[], dir?: string): Promise<string | null> {
  const argv = dir === undefined ? ['git', ...args] : ['git', '-C', dir, ...args]
  const ran = await $.process.run(argv, { timeoutMs: 5_000 }).catch(() => undefined)

  return ran?.exitCode === 0 ? ran.stdout.trim() : null
}

const branchOf = ($: EngineInterface, dir?: string) => git($, ['symbolic-ref', '--short', '-q', 'HEAD'], dir)

/** The first production-looking env var, as NAME=value. */
async function prodEnv($: EngineInterface): Promise<string | undefined> {
  const vars: [string, string | undefined][] = [
    ['NODE_ENV', await $.env.get('NODE_ENV')],
    ['RAILS_ENV', await $.env.get('RAILS_ENV')],
    ['APP_ENV', await $.env.get('APP_ENV')],
    ['ENVIRONMENT', await $.env.get('ENVIRONMENT')],
  ]
  const hit = vars.find(([, value]) => value !== undefined && PROD.test(value))

  return hit === undefined ? undefined : `${hit[0]}=${hit[1]}`
}

/** Works out why the band should be up and stores it; a no-op when nothing changed. */
async function refresh($: EngineInterface, patterns: readonly string[]) {
  const cwd = await $.session.cwd()
  const branch = await branchOf($)
  const root = (await git($, ['rev-parse', '--show-toplevel'])) ?? cwd
  const env = await prodEnv($)
  const hasMarker = (await $.fs.exists(`${cwd}/.prod`)) || (root !== cwd && (await $.fs.exists(`${root}/.prod`)))
  const reasons = [
    ...(isProtected(branch, patterns) ? [`on ${branch}`] : []),
    ...(env === undefined ? [] : [env]),
    ...(hasMarker ? ['.prod'] : []),
  ]
  const fresh: GuardState = { branch, reasons }
  const now = await read($, guard)

  if (JSON.stringify(now) !== JSON.stringify(fresh)) {
    await update($, guard, () => fresh)
  }
}

export const register: Register = (on, options) => {
  const patterns = branchList(String(options.protectedBranches ?? DEFAULT_BRANCHES))
  const confirmPushes = options.confirmPushes !== false

  on('session.start', async ($, e, next) => {
    await refresh($, patterns)
    $.clock.every(REFRESH_MS, () => void refresh($, patterns).catch(() => undefined))

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    for (const call of gitCalls(e.command)) {
      const decision = decide(call, await branchOf($, call.dir), patterns)

      if (decision.kind === 'deny') {
        return { deny: decision.reason }
      }

      if (decision.kind === 'confirm') {
        const stop = `main-guard: a direct push to ${decision.branch} needs your OK. Push a feature branch and open a PR, or run the push yourself.`

        if (!confirmPushes) {
          return { deny: stop }
        }

        const answer = await $.ui
          .ask(`Push straight to ${decision.branch}?`, { options: [`Push to ${decision.branch}`, 'Cancel'], header: 'main-guard' })
          .catch(() => undefined)

        if (answer !== `Push to ${decision.branch}`) {
          return { deny: answer === undefined ? stop : `main-guard: the push to ${decision.branch} was cancelled by the user.` }
        }
      }
    }

    const ran = await next(e)
    void refresh($, patterns).catch(() => undefined)

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, guard)

    if (e.props.hasSurvey || state === null || state.reasons.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const isOnBranch = state.reasons.some(reason => reason.startsWith('on '))

    return (
      <Box width={e.props.bodyColumns}>
        <Text backgroundColor="red" color="white" bold wrap="truncate">
          {` ${bandText(state.reasons)} `}
        </Text>
        {isOnBranch && (
          <Text dimColor wrap="truncate">
            {'  force-push and reset --hard are blocked'}
          </Text>
        )}
      </Box>
    )
  })
}
