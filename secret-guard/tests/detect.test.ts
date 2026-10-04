import { describe, expect, test } from 'claude-code/testing'

import { bashWriteTargets, findSecrets, isEnvFile, isPlaceholder, isPublicInstructions, newSecrets } from '../hooks/detect'
import { KEYS, random } from './keys'

const types = (text: string, strict = false) => findSecrets(text, { strict }).map(f => f.type)

describe('finds real-looking secrets', () => {
  const cases: [keyof typeof KEYS, string][] = [
    ['aws', 'AWS access key'],
    ['anthropic', 'Anthropic API key'],
    ['openaiProject', 'OpenAI API key'],
    ['openaiLegacy', 'OpenAI API key'],
    ['generic', 'API key (sk-…)'],
    ['github', 'GitHub token'],
    ['githubPat', 'GitHub token'],
    ['slack', 'Slack token'],
    ['slackWebhook', 'Slack webhook URL'],
    ['stripe', 'Stripe live key'],
    ['stripeRestricted', 'Stripe live key'],
    ['google', 'Google API key'],
    ['privateKey', 'private key'],
    ['postgres', 'database URL with a password'],
    ['mysql', 'database URL with a password'],
    ['mongo', 'database URL with a password'],
  ]
  for (const [key, type] of cases) {
    test(`${key} → ${type}`, () => {
      expect(types(`const value = "${KEYS[key]}"`)).toEqual([type])
    })
  }

  test('a private key inside a JSON string, newlines escaped', () => {
    const json = JSON.stringify({ private_key: KEYS.privateKey.replace(/RSA /g, '') })
    expect(types(json)).toEqual(['private key'])
  })

  test('reports 1-based lines, in order', () => {
    const text = `# config\nA=${KEYS.github}\n\nB=${KEYS.aws}\n`
    expect(findSecrets(text).map(f => [f.type, f.line])).toEqual([
      ['GitHub token', 2],
      ['AWS access key', 4],
    ])
  })

  test('the database rule keeps the password as the secret', () => {
    expect(findSecrets(KEYS.postgres)[0]?.value).toBe(KEYS.postgres.split(':')[2]!.split('@')[0])
  })
})

describe('ignores placeholders and look-alikes', () => {
  const benign = [
    'AKIAIOSFODNN7EXAMPLE',
    'sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'sk-your-key-here',
    'OPENAI_API_KEY=<your-api-key>',
    'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}',
    'const key = process.env.OPENAI_API_KEY',
    'key = os.environ["STRIPE_SECRET_KEY"]',
    'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'ghp_************************************',
    'sk_test_' + random(24, 30),
    'AIza' + 'X'.repeat(35),
    'sk-' + 'a'.repeat(40),
    'sk-1234567890abcdefghijklmnopqrstuvwxyz',
    'pip install scikit-learn sk-learn task-runner',
    '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
    'Paste the key between -----BEGIN OPENSSH PRIVATE KEY----- and the END line.',
    'postgres://postgres:postgres@localhost:5432/dev',
    'postgres://app:password@db.internal.acme.io/app',
    'postgres://app:${DB_PASSWORD}@prod.acme.io/app',
    'postgres://app:$DB_PASSWORD@prod.acme.io/app',
    'mysql://user:%s@%s/db',
    'mongodb+srv://user:<password>@cluster0.ab12c.mongodb.net',
    'redis://default:' + random(20, 31) + '@redis:6379',
    'postgres://admin:' + random(16, 32) + '@db.example.com/app',
    'postgres://localhost/app',
  ]
  for (const text of benign) {
    test(text.slice(0, 60), () => {
      expect(types(text)).toEqual([])
    })
  }

  test('placeholder words and low-variety values', () => {
    expect(isPlaceholder('your-key-here')).toBe(true)
    expect(isPlaceholder('0000000000000000')).toBe(true)
    expect(isPlaceholder(KEYS.github)).toBe(false)
  })
})

describe('strict mode for public instruction files', () => {
  const line = `api_key: "${random(24, 40)}"`

  test('flags a credential-named assignment with a random value', () => {
    expect(types(line)).toEqual([])
    expect(types(line, true)).toEqual(['credential-looking value'])
  })

  test('still lets names, words and placeholders through', () => {
    expect(types('token: "set GITHUB_TOKEN in your shell"', true)).toEqual([])
    expect(types('password = "${DB_PASSWORD}"', true)).toEqual([])
    expect(types('secret_key: your-secret-key-goes-here-123', true)).toEqual([])
  })
})

describe('what a write adds', () => {
  test('a secret already in the old text is not new', () => {
    const before = `TOKEN=${KEYS.github}`
    expect(newSecrets(`${before}\nDEBUG=1`, before)).toEqual([])
    expect(newSecrets(`${before}\nAWS=${KEYS.aws}`, before).map(f => f.type)).toEqual(['AWS access key'])
  })
})

describe('paths and shell writes', () => {
  test('env files are where secrets belong; examples are not', () => {
    for (const path of ['.env', '/repo/.env.local', 'app/.env.production', '.dev.vars']) expect(isEnvFile(path)).toBe(true)
    for (const path of ['.env.example', '.env.sample', '.env.template', 'env.ts', 'config/.envrc']) expect(isEnvFile(path)).toBe(false)
  })

  test('CLAUDE.md and AGENTS.md are the public instruction files', () => {
    expect(isPublicInstructions('/repo/CLAUDE.md')).toBe(true)
    expect(isPublicInstructions('packages/api/AGENTS.md')).toBe(true)
    expect(isPublicInstructions('README.md')).toBe(false)
  })

  test('finds the files a command writes to', () => {
    expect(bashWriteTargets('echo "KEY=abc" > .env')).toEqual(['.env'])
    expect(bashWriteTargets('printf "%s" "$X" >> config/app.json')).toEqual(['config/app.json'])
    expect(bashWriteTargets('echo k | tee -a secrets.txt')).toEqual(['secrets.txt'])
    expect(bashWriteTargets("cat <<'EOF' > settings.yaml\nkey: v\nEOF")).toEqual(['settings.yaml'])
    expect(bashWriteTargets('npm test 2>&1 >/dev/null')).toEqual([])
    expect(bashWriteTargets('curl -H "Authorization: Bearer $T" https://api.x.io')).toEqual([])
    expect(bashWriteTargets('[ "$a" -gt 3 ] && echo ok')).toEqual([])
  })
})
