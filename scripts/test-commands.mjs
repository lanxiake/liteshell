/**
 * Unit check for the command-completion matcher: history beats dictionary,
 * nothing is offered twice, and a full line never wipes what's already typed.
 *
 *   node scripts/test-commands.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-commands-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundle = join(work, 'commands.mjs')
await build({
  entryPoints: ['src/renderer/src/commands.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { PALETTE, hintFor, searchCommands, suggest } = await import(`file://${bundle.replaceAll('\\', '/')}`)

const cmds = (line, history = [], limit = 5) => suggest(line, history, limit).map((s) => s.cmd)
const hintOf = (line, cmd) => suggest(line, [], 5).find((s) => s.cmd === cmd)?.hint

/* ---------------- dictionary ---------------- */
check('空行不弹候选', cmds('').length === 0)
check('只有空格也不弹', cmds('   ').length === 0)
check('前缀命中内置字典', cmds('sys').includes('systemctl'), cmds('sys').join(','))
check('字典带中文说明', /服务/.test(hintOf('sys', 'systemctl') ?? ''), hintOf('sys', 'systemctl'))
check('按 limit 截断', cmds('s', [], 3).length === 3, cmds('s', [], 3).join(','))
check('完全对上的命令不重复推荐', !cmds('ls').includes('ls'), cmds('ls').join(','))
check('字典顺序即优先级', cmds('d', [], 3)[0] === 'df', cmds('d', [], 3).join(','))

/* ---------------- history ---------------- */
check('历史排在字典前面', cmds('s', ['ssh deploy@10.0.0.1'], 2)[0] === 'ssh deploy@10.0.0.1', cmds('s', ['ssh deploy@10.0.0.1'], 2).join(','))
check('历史里的最近优先', cmds('dock', ['docker ps -a', 'docker compose up'])[0] === 'docker compose up', cmds('dock', ['docker ps -a', 'docker compose up']).join(','))
check('历史与字典同名只出一次', cmds('top', ['top -b -n1'], 5).filter((c) => c === 'top').length === 0, cmds('top', ['top -b -n1'], 5).join(','))
check('历史不匹配前缀就不出', !cmds('sys', ['docker ps']).includes('docker ps'), cmds('sys', ['docker ps']).join(','))

/* ---------------- full lines ---------------- */
check('打完空格后历史仍排第一', cmds('systemctl res', ['systemctl restart nginx'])[0] === 'systemctl restart nginx', cmds('systemctl res', ['systemctl restart nginx']).join(','))
// The old worry was a bare dictionary name wiping what's already typed; the rule
// that actually protects it is "every candidate is the typed line plus more".
check('打完空格后只给追加式候选', cmds('systemctl res', []).every((c) => c.startsWith('systemctl res')), cmds('systemctl res', []).join(','))
check('已经打完整行就不再推荐它', !cmds('docker ps', ['docker ps']).includes('docker ps'), cmds('docker ps', ['docker ps']).join(','))

/* ---------------- follow-up options ---------------- */
check('打完命令名后给后续选项', cmds('systemctl ').includes('systemctl status '), cmds('systemctl ').join('|'))
check(
  '后续选项带中文说明',
  /状态/.test(hintOf('systemctl ', 'systemctl status ') ?? ''),
  hintOf('systemctl ', 'systemctl status ')
)
check(
  '后续选项按已输入的前缀过滤',
  cmds('systemctl re').join('|') === 'systemctl restart |systemctl reload ',
  cmds('systemctl re').join('|')
)
check('两个词的子命令也能补', cmds('docker comp', [], 9).every((c) => c.startsWith('docker compose')), cmds('docker comp', [], 9).join('|'))
check('不认识的命令不编造选项', cmds('frobnicate ').length === 0, cmds('frobnicate ').join('|'))
check('历史仍然排在后续选项前面', cmds('docker p', ['docker pull nginx'])[0] === 'docker pull nginx', cmds('docker p', ['docker pull nginx']).join('|'))
// The whole point of a trailing space in the table: with it nothing is accidentally unfindable.
const HEADS = ['systemctl', 'journalctl', 'docker', 'kubectl', 'git', 'apt', 'tar', 'find', 'grep', 'ss', 'curl', 'ssh', 'mysql', 'redis-cli', 'pm2']
check(
  '常用命令都配了足够的后续选项',
  HEADS.every((h) => suggest(`${h} `, [], 50).length >= 5),
  HEADS.map((h) => `${h}:${suggest(`${h} `, [], 50).length}`).join(' ')
)
// Every offered line must be the typed prefix plus something — never a rewrite of it.
check(
  '候选永远是在已输入内容上追加',
  HEADS.flatMap((h) => suggest(`${h} `, [], 50).map((s) => [h, s.cmd])).every(([h, c]) => c.startsWith(`${h} `))
)

/* ---------------- command palette ---------------- */
const hits = (q) => searchCommands(q).map((e) => e.cmd)

check('面板规模够用', PALETTE.length >= 100, `${PALETTE.length} 条`)
check('每条都有分组、命令和说明', PALETTE.every((e) => e.group && e.cmd && e.hint))
check('命令不重复', new Set(PALETTE.map((e) => e.cmd)).size === PALETTE.length)
// Headings are drawn when the group changes, so a group must stay contiguous.
check(
  '同组连续排列',
  new Set(PALETTE.map((e) => e.group)).size ===
    PALETTE.filter((e, i) => i === 0 || e.group !== PALETTE[i - 1].group).length
)
check('空查询给全量', searchCommands('').length === PALETTE.length)
check('按命令搜', hits('swap 用量').length === 1, hits('swap 用量').join('|'))
check('按说明搜', hits('显存').some((c) => c.includes('nvidia-smi')), hits('显存').join('|'))
check('按分组搜', hits('Kubernetes').every((c) => c.startsWith('kubectl')), hits('Kubernetes').length + ' 条')
check('多个词是收窄不是放宽', searchCommands('磁盘 排序').length <= searchCommands('磁盘').length)
check('搜不到就是空', hits('zzzz').length === 0)
// A stray backslash would be eaten by the TS string and silently corrupt the command.
check('反斜杠保住了', hits('innodb')[0].includes('\\G'), hits('innodb')[0])
check('转义序列不被提前解释', hits('docker ps -a')[0].includes('\\t'), hits('docker ps -a')[0])

/* ---------------- tooltips ---------------- */
check('能查到知名命令的说明', /日志/.test(hintFor('tail -f /var/log/nginx/access.log') ?? ''), hintFor('tail -f /var/log/nginx/access.log'))
check('自造的命令查不到说明', hintFor('echo hi') === undefined, hintFor('echo hi'))
check('面板条目都有说明可显示', PALETTE.every((e) => hintFor(e.cmd) === e.hint))

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\nCOMMANDS TEST PASS' : `\nCOMMANDS TEST FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
