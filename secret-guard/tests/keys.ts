// Keys are assembled at run time from a seeded generator, so this file holds
// no literal credential (and trips no push protection). None of them is real.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export function random(length: number, seed: number, chars = ALNUM): string {
  let x = seed
  let out = ''
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648
    out += chars[(x >> 8) % chars.length]
  }
  return out
}
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const join = (...parts: string[]) => parts.join('')

export const KEYS = {
  aws: join('AK', 'IA', random(16, 1, UPPER)),
  anthropic: join('sk-', 'ant-', 'api03-', random(93, 2), 'AA'),
  openaiProject: join('sk-', 'proj-', random(48, 3), '_', random(56, 4)),
  openaiLegacy: join('sk-', random(20, 5), 'T3Blbk', 'FJ', random(20, 6)),
  generic: join('sk-', random(32, 7)),
  github: join('gh', 'p_', random(36, 8)),
  githubPat: join('github', '_pat_', random(22, 9), '_', random(59, 10)),
  slack: join('xo', 'xb-', '2938475610', '-', '9182736450', '-', random(24, 11)),
  slackWebhook: join('https://hooks.', 'slack.com/services/T', random(9, 12, UPPER), '/B', random(9, 13, UPPER), '/', random(24, 14)),
  stripe: join('sk', '_live_', random(24, 15)),
  stripeRestricted: join('rk', '_live_', random(24, 16)),
  google: join('AI', 'za', random(35, 17)),
  privateKey: join('-----BEGIN RSA ', 'PRIVATE KEY-----\n', random(64, 18), '\n', random(64, 19), '\n-----END RSA PRIVATE KEY-----'),
  postgres: join('postgres://', 'app_user:', random(20, 20), '@prod-db.c9x2k1.us-east-1.rds.amazonaws.com:5432/app'),
  mysql: join('mysql://', 'root:', random(16, 21), '@10.0.4.12:3306/shop'),
  mongo: join('mongodb+srv://', 'svc:', random(18, 22), '@cluster0.ab12c.mongodb.net/prod'),
}

