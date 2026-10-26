/**
 * The update check decides two things that are easy to get wrong and hard to
 * notice: whether a release is actually newer, and which file belongs to this
 * machine. A wrong "newer" nags forever; a wrong asset installs nothing (that
 * is exactly how an arm64 build once landed on an x64 box).
 *
 *   node scripts/test-update.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-update-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/* The module imports electron at the top; the parts under test never touch it. */
const stub = join(work, 'electron.mjs')
writeFileSync(
  stub,
  `export const app = { getVersion: () => '0.0.0', quit: () => {} }\n` +
    `export const shell = { openPath: async () => '' }\n`
)

const out = join(work, 'update.mjs')
await build({
  entryPoints: ['src/main/update.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
  alias: { electron: stub }
})
const { parseVersion, isNewer, pickAsset } = await import(pathToFileURL(out).href)

/* ---------------- versions ---------------- */

check('v 前缀不影响比较', parseVersion('v1.2.3').join('.') === '1.2.3')
check('少写的段按 0 算', isNewer('1.3', '1.2.9'))
check('补丁号大就是新', isNewer('0.2.5', '0.2.4'))
check('主版本大就是新', isNewer('1.0.0', '0.9.9'))
check('一样不算新', !isNewer('0.2.4', '0.2.4') && !isNewer('v0.2.4', '0.2.4'))
check('旧版本不算新', !isNewer('0.2.3', '0.2.4'))
check('段数是数字比较不是字符串比较', isNewer('0.10.0', '0.9.0'))
check('预发布版本不会顶掉正式版', !isNewer('0.2.4-beta.1', '0.2.4'))
check('乱写的不抛异常', Number.isFinite(parseVersion('???')[0]))

/* ---------------- asset picker ---------------- */

const RELEASE = [
  { name: 'LiteShell-0.3.0-x64-setup.exe', browser_download_url: 'u/win-x64', size: 1 },
  { name: 'LiteShell-0.3.0-arm64-setup.exe', browser_download_url: 'u/win-arm64', size: 1 },
  { name: 'LiteShell-0.3.0-x64-setup.exe.sha256', browser_download_url: 'u/sha', size: 1 },
  { name: 'LiteShell-0.3.0-x64-setup.exe.blockmap', browser_download_url: 'u/map', size: 1 },
  { name: 'LiteShell-0.3.0-x64.dmg', browser_download_url: 'u/mac-x64', size: 1 },
  { name: 'LiteShell-0.3.0-arm64.dmg', browser_download_url: 'u/mac-arm64', size: 1 },
  { name: 'LiteShell-0.3.0-x64.AppImage', browser_download_url: 'u/linux', size: 1 },
  { name: 'latest.yml', browser_download_url: 'u/yml', size: 1 }
]

check('Windows 拿 exe', pickAsset(RELEASE, 'win32', 'x64')?.name === 'LiteShell-0.3.0-x64-setup.exe')
check('Windows arm64 拿 arm64 那个',
  pickAsset(RELEASE, 'win32', 'arm64')?.url === 'u/win-arm64')
check('不会把 .sha256 当成安装包', pickAsset(RELEASE, 'win32', 'x64')?.url === 'u/win-x64')
check('macOS Intel 拿 x64 dmg', pickAsset(RELEASE, 'darwin', 'x64')?.url === 'u/mac-x64')
check('macOS Apple Silicon 拿 arm64 dmg', pickAsset(RELEASE, 'darwin', 'arm64')?.url === 'u/mac-arm64')
check('Linux 拿 AppImage', pickAsset(RELEASE, 'linux', 'x64')?.url === 'u/linux')
check('没有对应文件时返回 null，而不是随便挑一个',
  pickAsset([{ name: 'latest.yml', browser_download_url: 'x' }], 'win32', 'x64') === null)

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
