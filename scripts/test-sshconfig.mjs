/**
 * Unit check for the pieces that make `ssh <ip>` work: which alias a
 * connection gets when two profiles share an address, and how the generated
 * ~/.ssh/config block merges with what is already there.
 *
 *   node scripts/test-sshconfig.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-sshconfig-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundle = join(work, 'sshconfig.mjs')
await build({
  entryPoints: ['src/main/sshconfig.ts'],
  format: 'esm',
  bundle: true,
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { sshAlias, sshConfigWith } = await import(`file://${bundle.replaceAll('\\', '/')}`)

/* ---------------- alias ---------------- */

check('第一个用地址本身，不用记任何前缀', sshAlias('10.7.8.9', []) === '10.7.8.9')
check('同一地址的第二个排 -a', sshAlias('10.7.8.9', ['10.7.8.9']) === '10.7.8.9-a')
check('第三个排 -b', sshAlias('10.7.8.9', ['10.7.8.9', '10.7.8.9-a']) === '10.7.8.9-b')
check(
  '中间空出来也用最小的那一个',
  sshAlias('10.7.8.9', ['10.7.8.9', '10.7.8.9-b']) === '10.7.8.9-a'
)
check('别的地址的占用不影响这个', sshAlias('10.0.0.1', ['10.0.0.2', '10.0.0.2-a']) === '10.0.0.1')

/* ---------------- config block ---------------- */

const host = { id: 'c1', host: '10.7.8.9', port: 22, username: 'root', alias: '10.7.8.9' }
const block = sshConfigWith('', host)
check('Host 就是地址', block.includes('Host 10.7.8.9'))
check('HostName 也写全，别名以后改也不影响', block.includes('HostName 10.7.8.9'))
check('22 端口不写 Port', !block.includes('Port 22'))
check('指向生成的私钥', block.includes('IdentityFile ~/.ssh/liteshell_ed25519'))

const pinned = sshConfigWith('', { ...host, localAddress: '10.7.8.7' })
check('固定出口写进 BindAddress', pinned.includes('BindAddress 10.7.8.7'))
check('只填网卡时不把地址写死', !sshConfigWith('', { ...host, localIface: 'tun0' }).includes('BindAddress'))

const second = sshConfigWith(block, {
  id: 'c2',
  host: '10.7.8.9',
  port: 22,
  username: 'test001',
  alias: '10.7.8.9-a'
})
check('同 IP 的两个 profile 各占一块', (second.match(/# >>> LiteShell:/g) ?? []).length === 2)
check('两个块的用户各自保留', second.includes('User root') && second.includes('User test001'))

check('重复配置同一个别名结果不变', sshConfigWith(second, host) === second)
check(
  '重新配置时不会把另一个块顶掉',
  (sshConfigWith(second, host).match(/# >>> LiteShell:/g) ?? []).length === 2
)

/* Older builds keyed the block by connection id, and the one before that by
   bare address; both have to be replaced, not left beside the new block. */
const legacyId = `# >>> LiteShell: liteshell-c1 >>>\nHost liteshell-c1\n    User old\n# <<< LiteShell: liteshell-c1 <<<\n`
check('旧版按连接 id 写的块被替换', !sshConfigWith(legacyId, host).includes('liteshell-c1'))

const userConfig = 'Host github.com\n    User git\n'
const merged = sshConfigWith(userConfig, host)
check('用户自己的配置原样保留', merged.includes(userConfig.trimEnd()))
check('LiteShell 的块排在前面', merged.startsWith('# >>> LiteShell: 10.7.8.9 >>>'))

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
