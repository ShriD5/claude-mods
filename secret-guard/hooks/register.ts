import type { EngineInterface, Register } from 'claude-code'

import {
  bashWriteTargets,
  type Finding,
  isEnvFile,
  isPublicInstructions,
  newSecrets,
  withArticle,
} from './detect'

type Tally = { total: number; byType: Record<string, number> }

/** What a file tool is about to write: the new text, and the text it replaces. */
export type ProposedWrite = { path: string; after: string; before: string }

const COMMAND = 'secret-guard'
const PUBLIC_NOTE =
  'CLAUDE.md and AGENTS.md are often committed and public: in a public sample of 25,784 CLAUDE.md files, 275 contained real-looking secrets. Keep secret values out of them entirely and name the environment variable instead.'

/** The text a file tool call would write, or undefined for any other call. */
export function proposedWrite(tool: string, args: Record<string, unknown>): ProposedWrite | undefined {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : []
  switch (tool) {
    case 'Write':
      return { path: text(args.file_path), after: text(args.content), before: '' }
    case 'Edit':
      return { path: text(args.file_path), after: text(args.new_string), before: text(args.old_string) }
    case 'MultiEdit':
      return {
        path: text(args.file_path),
        after: edits.map(edit => text(edit.new_string)).join('\n'),
        before: edits.map(edit => text(edit.old_string)).join('\n'),
      }
    case 'NotebookEdit':
      return { path: text(args.notebook_path), after: text(args.new_source), before: '' }
  }
  return undefined
}

/** The deny reason: what was found and where, what to do instead; never the secret. */
export function denyReason(findings: Finding[], where: string, isPublic: boolean): string {
  const what = findings.map(f => `${withArticle(f.type)} (line ${f.line})`).join(', ')
  const env = findings[0]?.env ?? 'API_KEY'
  return [
    `secret-guard blocked this: it would write ${what} into ${where}.`,
    `Don't put secret values in files. Put the value in .env (and make sure .env is listed in .gitignore), read it from an environment variable such as ${env}, and use a placeholder like \${${env}} where the file needs to show it.`,
    isPublic ? PUBLIC_NOTE : '',
  ]
    .filter(Boolean)
    .join(' ')
}

async function block($: EngineInterface, findings: Finding[], where: string, isPublic: boolean) {
  const tally = ((await $.store.get('blocked')) as Tally | undefined) ?? { total: 0, byType: {} }
  for (const finding of findings) {
    tally.total += 1
    tally.byType[finding.type] = (tally.byType[finding.type] ?? 0) + 1
  }
  await $.store.set('blocked', tally)
  const short = where.split(/[\\/]/).at(-1) ?? where
  $.ui.toast(`🔒 secret-guard blocked ${withArticle(findings[0]!.type)} in ${short}`)
  return { deny: denyReason(findings, where, isPublic) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'How many secrets secret-guard has kept out of files' })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const tally = (await $.store.get('blocked')) as Tally | undefined
    if (!tally || tally.total === 0) return { text: "🔒 secret-guard hasn't had to block any secrets yet." }
    const kinds = Object.entries(tally.byType).map(([type, n]) => `${n} × ${type}`)
    return { text: `🔒 secret-guard has blocked ${tally.total} secret${tally.total === 1 ? '' : 's'} so far: ${kinds.join(', ')}.` }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as Record<string, unknown>

    if (tool === 'Bash' && typeof args.command === 'string') {
      const targets = bashWriteTargets(args.command).filter(target => !isEnvFile(target))
      if (targets.length === 0) return next(e)
      const isPublic = targets.some(isPublicInstructions)
      const findings = newSecrets(args.command, '', { strict: isPublic })
      return findings.length === 0 ? next(e) : block($, findings, `${targets.join(', ')} (via Bash)`, isPublic)
    }

    const write = proposedWrite(tool, args)
    if (write === undefined || isEnvFile(write.path)) return next(e)

    const isPublic = isPublicInstructions(write.path)
    let findings = newSecrets(write.after, write.before, { strict: isPublic })
    if (findings.length === 0) return next(e)

    // Secrets the file already holds are not this write's doing.
    const existing = await $.fs.read(write.path).catch(() => '')
    findings = findings.filter(finding => !existing.includes(finding.value))
    if (findings.length === 0) return next(e)

    // Report Edit lines as lines of the file, not of the snippet.
    const at = tool === 'Edit' ? existing.indexOf(write.before) : -1
    const offset = at > 0 ? existing.slice(0, at).split('\n').length - 1 : 0
    return block($, findings.map(f => ({ ...f, line: f.line + offset })), write.path, isPublic)
  })
}
