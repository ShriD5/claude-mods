// Which shell commands count as risky. A port of the classifier in
// whoopgate's Sources/main.swift, so the mod and the CLI agree.

export const RISKY: readonly (readonly [label: string, pattern: RegExp])[] = [
  ['force push', /\bgit\s+push\b[^|;&]*\s(--force|--force-with-lease|-f)\b/],
  ['push to main', /\bgit\s+push\b[^|;&]*\s(\S+\s+)?(main|master)\b/],
  ['hard reset', /\bgit\s+reset\b[^|;&]*--hard\b/],
  ['git clean', /\bgit\s+clean\s+-[a-zA-Z]*f/],
  ['branch delete', /\bgit\s+branch\s+(-D|--delete\s+--force)\b/],
  [
    'rm -rf',
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b/,
  ],
  [
    'prod deploy',
    /\b(wrangler\s+(deploy|publish)|vercel\b[^|;&]*--prod|netlify\s+deploy\b[^|;&]*--prod|fly(ctl)?\s+deploy|railway\s+up|firebase\s+deploy|serverless\s+deploy|sls\s+deploy|cdk\s+deploy|eas\s+submit)\b/,
  ],
  ['publish', /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/],
  [
    'infra change',
    /\bterraform\s+(apply|destroy)\b|\bkubectl\s+(delete|apply|drain)\b|\bhelm\s+(upgrade|uninstall)\b/,
  ],
  ['destructive SQL', /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i],
  ['destructive SQL', /\b(psql|mysql|mariadb|sqlite3)\b.*\btruncate\s+\w/is],
  ['PR merge', /\bgh\s+pr\s+merge\b/],
  ['release', /\bgh\s+release\s+create\b/],
]

/** A bare `git push`, risky only while the checkout sits on main or master. */
export const BARE_PUSH = /\bgit\s+push\b/

/**
 * The label of the first rule `command` breaks, or undefined when it is safe.
 * `extra` are the person's own patterns; `branch` the current git branch.
 */
export const classify = (
  command: string,
  extra: readonly RegExp[] = [],
  branch?: string,
): string | undefined => {
  for (const [label, pattern] of RISKY) if (pattern.test(command)) return label
  for (const pattern of extra) if (pattern.test(command)) return 'custom rule'
  const isOnMain = branch === 'main' || branch === 'master'

  return isOnMain && BARE_PUSH.test(command) ? 'push to main' : undefined
}

/** One line of a command, cut to fit a message. */
export const shorten = (command: string, max = 80): string => {
  const line = command.trim().replace(/\s+/g, ' ')

  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}
