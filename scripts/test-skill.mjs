/**
 * The exported skill package: the bytes come from `skills/` and the folder it
 * lands in must be usable by another client as-is.
 *
 *   node scripts/test-skill.mjs
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-skill-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// `app` is the only Electron API this module touches, and it only answers "where
// is the source". A stub keeps the test out of a running Electron.
const stub = join(work, 'electron-stub.mjs')
writeFileSync(
  stub,
  `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(process.cwd())}, getPath: () => ${JSON.stringify(work)} }\n`
)

const bundle = join(work, 'skill.mjs')
await build({
  entryPoints: ['src/main/skill.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: { electron: stub },
  logLevel: 'silent'
})
const { exportSkill } = await import(`file://${bundle.replaceAll('\\', '/')}`)

const out = join(work, 'drop')
const dir = exportSkill(out)

check('落点是 <目录>/liteshell', dir === join(out, 'liteshell'), dir)
check('SKILL.md 原样带过来', existsSync(join(dir, 'SKILL.md')) &&
  readFileSync(join(dir, 'SKILL.md'), 'utf8') === readFileSync('skills/liteshell/SKILL.md', 'utf8'))
check('CLI 也在，且还是可执行的那份', existsSync(join(dir, 'bin', 'liteshell-cli.mjs')) &&
  readFileSync(join(dir, 'bin', 'liteshell-cli.mjs'), 'utf8') === readFileSync('skills/liteshell/bin/liteshell-cli.mjs', 'utf8'))
check('带一份安装说明', existsSync(join(dir, 'README.md')))
const readme = readFileSync(join(dir, 'README.md'), 'utf8')
check('安装说明讲了 Claude Code 和别的客户端',
  readme.includes('.claude/skills') && readme.includes('Cursor'))
check('安装说明讲了前提（Node 与 LiteShell 要开着）',
  readme.includes('Node') && readme.includes('app_not_running'))

// A second export over the same folder must not fail or nest a copy of itself.
const again = exportSkill(out)
check('重复导出覆盖自己的文件', again === dir &&
  readdirSync(dir).sort().join(',') === 'README.md,SKILL.md,bin')

rmSync(work, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
