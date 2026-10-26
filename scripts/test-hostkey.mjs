/**
 * Host-key pinning. Two environments can hand out the same IP (a test and a
 * prod cluster behind the same VPN address), so the key is pinned to the
 * connection profile rather than to host:port. Change detection still applies
 * to the profile that recorded the key.
 *
 * store.ts is bundled against a stub `electron`, the same way test-backup.mjs
 * runs the real store without Electron.
 *
 *   node scripts/test-hostkey.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-hostkey-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const stub = join(work, 'electron.mjs')
writeFileSync(
  stub,
  `export const app = { getPath: () => process.env.LITESHELL_HOME }\n` +
    `export const safeStorage = {\n` +
    `  isEncryptionAvailable: () => false,\n` +
    `  encryptString: (s) => Buffer.from(s, 'utf8'),\n` +
    `  decryptString: (b) => b.toString('utf8')\n` +
    `}\n`
)

const bundlePath = join(work, 'store.mjs')
await build({
  entryPoints: ['src/main/store.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  logLevel: 'silent',
  alias: { electron: stub }
})

async function machine(dir, seed) {
  mkdirSync(dir, { recursive: true })
  if (seed) writeFileSync(join(dir, 'liteshell.json'), JSON.stringify(seed))
  process.env.LITESHELL_HOME = dir
  return import(`file://${bundlePath.replaceAll('\\', '/')}?${Math.random()}`)
}

const HOST = '10.157.152.29'
const A = { id: 'env-a', host: HOST, port: 22 }
const B = { id: 'env-b', host: HOST, port: 22 }
const FP_A = 'SHA256:env-a'
const FP_B = 'SHA256:env-b'
const FP_NEW = 'SHA256:env-a-reinstalled'

/* ---------------- two profiles, one address ---------------- */

const s = await machine(join(work, 'pin'))

check('连接 A 还没有记录', s.hostKey(A.id) === undefined)
s.rememberHostKey(A, FP_A)
check('A 记住了自己的指纹', s.hostKey(A.id) === FP_A)

check('同 IP 的连接 B 不受 A 影响', s.hostKey(B.id) === undefined, String(s.hostKey(B.id)))
s.rememberHostKey(B, FP_B)
check('B 记住了自己的指纹', s.hostKey(B.id) === FP_B)
check('A 的指纹没有被 B 覆盖', s.hostKey(A.id) === FP_A)

/* ---------------- a known profile still catches a change ---------------- */

s.rememberHostKey(A, FP_NEW)
check('同一连接换指纹会更新', s.hostKey(A.id) === FP_NEW)
check('B 仍然不受影响', s.hostKey(B.id) === FP_B)

/* ---------------- records written before per-profile pinning ---------------- */

const legacy = await machine(join(work, 'legacy'), {
  version: 1,
  knownHosts: [{ host: HOST, port: 22, fingerprint: FP_A }]
})

check('旧记录没有归属，按地址能读到', legacy.legacyHostKey(HOST, 22) === FP_A)
check('旧记录不会冒充连接 A 的记录', legacy.hostKey(A.id) === undefined)

legacy.rememberHostKey(A, FP_A)
check('指纹相同时旧记录被 A 认领', legacy.hostKey(A.id) === FP_A)

legacy.rememberHostKey(B, FP_B)
check('指纹不同时 B 照样能记录自己的', legacy.hostKey(B.id) === FP_B)
check('旧记录原样保留，不误伤', legacy.legacyHostKey(HOST, 22) === FP_A)

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项未通过` : '\n全部通过')
process.exit(failures ? 1 : 0)
