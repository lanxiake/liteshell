/** Pure strings for the "plain ssh works afterwards" feature — no Electron, no
 *  filesystem, so the quoting and the config merge can be checked in a test. */

export interface SshHost {
  id: string
  host: string
  port: number
  username: string
  /** See Connection.localAddress: pins the tunnel for same-subnet VPNs. */
  localAddress?: string
  /** The alias to write. Assigned by the caller, which is the side that knows
   *  every other profile and can therefore keep two on one IP apart. */
  alias?: string
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

/** The `ssh` target: the address as typed, then a letter for the second, third
 *  profile on it. An address is what people actually remember; the suffix only
 *  has to break a tie. */
export const sshAlias = (host: string, taken: Iterable<string> = []): string => {
  const used = new Set(taken)
  const base = host.trim()
  if (!used.has(base)) return base
  for (const suffix of 'abcdefghijklmnopqrstuvwxyz') {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  // ponytail: 26 profiles on one address is already absurd; past that a number
  // keeps working instead of looping forever.
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`
}

/** Who else may be holding a name. Deliberately not `SshHost`: an alias is
 *  assigned from the profile list, and that list has no port/username here. */
export interface AliasOwner {
  id: string
  host: string
  sshAlias?: string
}

/**
 * The alias this profile should own *right now*, judged against every profile
 * in the store — not just the ones in the same folder, which is how two
 * connections on one address ended up writing the same `Host` block and
 * quietly replacing each other.
 *
 * A stored alias is kept when nothing else claims it, so reconfiguring does not
 * walk it a letter down; a copy or an import that inherited one gets its own.
 */
export function aliasFor(self: AliasOwner, all: Iterable<AliasOwner>): string {
  const used = new Set<string>()
  for (const c of all) {
    if (c.id === self.id || !c.sshAlias) continue
    used.add(c.sshAlias)
  }
  const keep = self.sshAlias?.trim()
  const host = self.host.trim()
  // `startsWith` also drops a stale alias when the address itself changed: the
  // name is supposed to be the address, with a suffix only to break a tie.
  if (keep && keep.startsWith(host) && !used.has(keep)) return keep
  return sshAlias(host, used)
}

const blockStart = (key: string): string => `# >>> LiteShell: ${key} >>>`
const blockEnd = (key: string): string => `# <<< LiteShell: ${key} <<<`

/**
 * The block that makes `ssh <alias>` work: same user, port, tunnel and the
 * generated key. It is prepended so it wins over a later `Host *` default; an
 * older block for the same connection is replaced, everything else stays byte
 * for byte. Blocks from older builds were keyed by address and are dropped too.
 */
export function sshConfigWith(old: string, conn: SshHost): string {
  const key = conn.alias ?? conn.host
  // What this write replaces: this alias, and the connection-id key an older
  // build used. The bare address is *not* on the list — when this profile got
  // the `-a` suffix, that block belongs to the profile that owns the address.
  const stale = new Set([key, `liteshell-${conn.id}`])
  const lines = old.split(/\r?\n/)
  const kept: string[] = []
  let skipping: string | null = null
  // Where the replaced block was, so a rewrite stays put instead of walking to
  // the top of the file every time one profile is reconfigured.
  let at = -1
  for (const line of lines) {
    const t = line.trim()
    const start = [...stale].find((k) => t === blockStart(k))
    if (start) {
      if (at < 0) at = kept.length
      skipping = start
      continue
    }
    if (skipping) {
      if (t === blockEnd(skipping)) skipping = null
      continue
    }
    kept.push(line)
  }

  const bind = conn.localAddress
  const block = [
    blockStart(key),
    `Host ${key}`,
    `    HostName ${conn.host}`,
    `    User ${conn.username}`,
    ...(conn.port !== 22 ? [`    Port ${conn.port}`] : []),
    ...(bind ? [`    BindAddress ${bind}`] : []),
    '    IdentityFile ~/.ssh/liteshell_ed25519',
    '    IdentitiesOnly yes',
    blockEnd(key)
  ].join('\n')

  // A first write goes to the top: that is where it beats a later `Host *`.
  const cut = at < 0 ? 0 : at
  const before = kept.slice(0, cut).join('\n').replace(/\n+$/, '')
  const after = kept.slice(cut).join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
  return [before, block, after].filter(Boolean).join('\n\n')
}
