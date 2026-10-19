/**
 * Unit check for the strings behind "one-click passwordless ssh": the
 * authorized_keys install command and the ~/.ssh/config merge. Neither touches
 * the filesystem, so this runs anywhere.
 *
 *   node scripts/test-passwordless.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-passwordless-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundlePath = join(work, 'sshconfig.mjs')
await build({
  entryPoints: ['src/main/sshconfig.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  logLevel: 'silent'
})
const { installCommand, sshConfigWith } = await import(
  `file://${bundlePath.replaceAll('\\', '/')}`
)

/* ---------------- authorized_keys ---------------- */

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests liteshell'
const install = installCommand(KEY)
check('公钥被单引号包住整段传入', install.includes(`'${KEY}'`))
check('重复写入前先检查', install.includes('grep -qxF') && install.includes('echo present'))
check('不存在才追加', install.includes('>> ~/.ssh/authorized_keys') && install.includes('echo added'))
check('权限一并收紧', install.includes('chmod 700 ~/.ssh') && install.includes('chmod 600 ~/.ssh/authorized_keys'))
check(
  '公钥里的单引号被正确转义',
  installCommand("ssh-ed25519 AAA'BBB").includes(`'ssh-ed25519 AAA'\\''BBB'`)
)

/* ---------------- ssh config ---------------- */

const host = { host: '10.157.150.22', port: 22, username: 'root' }
const block = sshConfigWith('', host)
check('生成 Host 块', block.includes('Host 10.157.150.22') && block.includes('User root'))
check('22 端口不写 Port', !block.includes('Port 22'))
check('指向生成的私钥', block.includes('IdentityFile ~/.ssh/liteshell_ed25519'))
check('限定只用这把钥匙', block.includes('IdentitiesOnly yes'))

const userConfig = 'Host github.com\n    User git\n'
const merged = sshConfigWith(userConfig, host)
check('用户原有配置原样保留', merged.includes(userConfig))
check('LiteShell 块排在最前面', merged.startsWith('# >>> LiteShell: 10.157.150.22 >>>'))

check('重复执行结果不变', sshConfigWith(merged, host) === merged)

const changed = sshConfigWith(merged, { ...host, port: 2222, username: 'deploy' })
check('同主机重配会替换旧块而不是堆叠', (changed.match(/# >>> LiteShell:/g) ?? []).length === 1)
check('非 22 端口写进 Port', changed.includes('Port 2222') && changed.includes('User deploy'))
check('替换后用户配置还在', changed.includes(userConfig))

const another = sshConfigWith(changed, { host: '10.0.0.9', port: 22, username: 'ops' })
check('配另一台机器时保留已有块', another.includes('Host 10.157.150.22') && another.includes('Host 10.0.0.9'))

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
