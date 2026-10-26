/**
 * Unit check for the authorized_keys install command — the half of "one-click
 * passwordless ssh" that is a shell string. The ~/.ssh/config merge has its
 * own file (test-sshconfig.mjs).
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

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
