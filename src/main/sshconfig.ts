/** Pure strings for the "plain ssh works afterwards" feature — no Electron, no
 *  filesystem, so the quoting and the config merge can be checked in a test. */

export interface SshHost {
  host: string
  port: number
  username: string
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Append-only and idempotent: a key already in the file is left as one line. */
export function installCommand(publicKey: string): string {
  const key = shellQuote(publicKey)
  return [
    'umask 077',
    'mkdir -p ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    `if grep -qxF ${key} ~/.ssh/authorized_keys; then echo present; ` +
      `else printf '%s\\n' ${key} >> ~/.ssh/authorized_keys; echo added; fi`,
    'chmod 700 ~/.ssh',
    'chmod 600 ~/.ssh/authorized_keys'
  ].join('; ')
}

const blockStart = (host: string): string => `# >>> LiteShell: ${host} >>>`
const blockEnd = (host: string): string => `# <<< LiteShell: ${host} <<<`

/**
 * The block that makes a bare `ssh <host>` work: same user, port, and the
 * generated key. It is prepended so it wins over a later `Host *` default; an
 * older block for the same host is replaced, everything else stays byte for
 * byte.
 */
export function sshConfigWith(old: string, conn: SshHost): string {
  const lines = old.split(/\r?\n/)
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line.trim() === blockStart(conn.host)) skipping = true
    if (!skipping) kept.push(line)
    if (line.trim() === blockEnd(conn.host)) skipping = false
  }

  const block = [
    blockStart(conn.host),
    `Host ${conn.host}`,
    `    User ${conn.username}`,
    ...(conn.port !== 22 ? [`    Port ${conn.port}`] : []),
    '    IdentityFile ~/.ssh/liteshell_ed25519',
    '    IdentitiesOnly yes',
    blockEnd(conn.host)
  ].join('\n')

  const rest = kept.join('\n').replace(/^\n+/, '')
  return `${block}\n${rest ? `\n${rest}` : ''}`
}
