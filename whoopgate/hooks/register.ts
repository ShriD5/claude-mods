import type { EngineInterface, Register } from 'claude-code'

import { BARE_PUSH, classify, shorten } from './risky'

// The whoopgate daemon streams the WHOOP band's heart rate into
// ~/.whoopgate/hr.json once a second; this mod only reads it.
const STALE_SECONDS = 30
const TICK_MS = 2000

type Heart = { bpm: number; ageSeconds: number; device: string }

type Gate = {
  heart: Heart | undefined
  threshold: number
  calmBpm: number
  unlockSeconds: number
  unlockedFor: number // seconds left on a `whoopgate breathe` unlock, 0 when none
  pausedFor: number // seconds left on a `whoopgate pause`, 0 when none
  extra: RegExp[]
}

type Verdict = 'unknown' | 'paused' | 'unlocked' | 'locked' | 'calm'

const verdictOf = (gate: Gate): Verdict => {
  if (gate.heart === undefined) return 'unknown'
  if (gate.pausedFor > 0) return 'paused'
  if (gate.heart.bpm < gate.threshold) return 'calm'

  return gate.unlockedFor > 0 ? 'unlocked' : 'locked'
}

const readJson = async ($: EngineInterface, path: string): Promise<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(path))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const toRegExps = (patterns: unknown): RegExp[] =>
  (Array.isArray(patterns) ? patterns : []).flatMap(pattern => {
    try {
      return typeof pattern === 'string' ? [new RegExp(pattern)] : []
    } catch {
      return []
    }
  })

const readGate = async ($: EngineInterface, threshold: number): Promise<Gate> => {
  const dir = `${(await $.env.get('HOME')) ?? ''}/.whoopgate`
  const nowSeconds = (await $.clock.now()) / 1000
  const [hr, unlock, pause, config] = await Promise.all(
    ['hr.json', 'unlock.json', 'pause.json', 'config.json'].map(name => readJson($, `${dir}/${name}`)),
  )
  const ageSeconds = nowSeconds - num(hr?.ts, -Infinity)
  const bpm = num(hr?.bpm, NaN)
  const isFresh = Math.abs(ageSeconds) <= STALE_SECONDS && bpm > 0
  const left = (file: Record<string, unknown> | undefined) =>
    Math.max(0, Math.round(num(file?.until, 0) - nowSeconds))

  return {
    heart: isFresh
      ? { bpm: Math.round(bpm), ageSeconds, device: typeof hr?.device === 'string' ? hr.device : 'WHOOP' }
      : undefined,
    threshold,
    calmBpm: num(config?.calmBpm, 92),
    unlockSeconds: num(config?.unlockSeconds, 120),
    unlockedFor: left(unlock),
    pausedFor: left(pause),
    extra: toRegExps(config?.extraPatterns),
  }
}

const clockOf = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

const statusOf = (gate: Gate): string => {
  const bpm = gate.heart?.bpm
  switch (verdictOf(gate)) {
    case 'unknown':
      return '♡ whoop offline'
    case 'paused':
      return `♥ ${bpm} · gate paused`
    case 'unlocked':
      return `♥ ${bpm} · unlocked ${clockOf(gate.unlockedFor)}`
    case 'locked':
      return `❤️ ${bpm} · deploys locked`
    case 'calm':
      return `♥ ${bpm}`
  }
}

const denyOf = (gate: Gate, label: string, command: string): string =>
  [
    `whoopgate blocked this ${label}: \`${shorten(command)}\``,
    `The user's live WHOOP heart rate is ${gate.heart?.bpm} bpm, at or over their limit of ${gate.threshold}. Their rule: no risky commands while their heart is racing.`,
    `To unlock, they run \`whoopgate breathe\` in their own terminal and stay under ${gate.calmBpm} bpm for 20 seconds, which opens a ${Math.round(gate.unlockSeconds / 60)} minute window.`,
    "Do not retry this command or work around it with a different command. Tell the user it was blocked and why, then continue with anything that doesn't need it.",
  ].join('\n')

const pulseOf = (gate: Gate): string => {
  const { heart } = gate
  if (heart === undefined) {
    return [
      `No live heart rate: ~/.whoopgate/hr.json is missing or older than ${STALE_SECONDS} s.`,
      'Start `whoopgate daemon` with the band nearby (or the mod\'s sim.sh for a simulated heart).',
      'Risky commands are allowed while the heart rate is unknown.',
    ].join('\n')
  }
  const verdict = verdictOf(gate)
  const gateLine = {
    paused: `paused for ${clockOf(gate.pausedFor)} (whoopgate pause)`,
    unlocked: 'over the limit, but unlocked',
    locked: 'risky commands BLOCKED',
    calm: 'risky commands allowed',
    unknown: '',
  }[verdict]
  const unlockLine =
    gate.unlockedFor > 0
      ? `unlocked for ${clockOf(gate.unlockedFor)} more`
      : `no unlock window. \`whoopgate breathe\`: ${gate.calmBpm} bpm or under for 20 s opens one`

  return [
    `${verdict === 'locked' ? '❤️' : '♥'} ${heart.bpm} bpm from ${heart.device} (${Math.max(0, Math.round(heart.ageSeconds))} s ago)`,
    `threshold ${gate.threshold} bpm · ${gateLine}`,
    unlockLine,
  ].join('\n')
}

const currentBranch = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeoutMs: 3000,
    })
    return exitCode === 0 ? stdout.trim() : undefined
  } catch {
    return undefined
  }
}

const refresh = async ($: EngineInterface, threshold: number) => {
  $.ui.status(statusOf(await readGate($, threshold)))
}

export const register: Register = (on, options) => {
  const threshold = num(options.threshold, 100)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pulse',
      description: 'Show your live WHOOP heart rate, the threshold and the unlock state',
    })
    await refresh($, threshold)
    $.clock.every(TICK_MS, () => void refresh($, threshold).catch(() => undefined))

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => ({ text: pulseOf(await readGate($, threshold)) }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const gate = await readGate($, threshold)
    if (verdictOf(gate) !== 'locked') return next(e)
    const branch = BARE_PUSH.test(e.command) ? await currentBranch($) : undefined
    const label = classify(e.command, gate.extra, branch)
    if (label === undefined) return next(e)

    $.ui.toast(`❤️ ${gate.heart?.bpm} bpm · blocked ${label}`)
    $.ui.status(statusOf(gate))

    return { deny: denyOf(gate, label, e.command) }
  })
}
