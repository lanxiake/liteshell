/**
 * Unit check for the monitor's warning rules: what counts as normal, what gets
 * flagged, and in what order the flags come out.
 *
 *   node scripts/test-alerts.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-alerts-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundle = join(work, 'alerts.mjs')
await build({
  entryPoints: ['src/renderer/src/alerts.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { alertsFor, toneOf, THRESHOLDS } = await import(`file://${bundle.replaceAll('\\', '/')}`)

/** A boring, healthy 8-core box. Everything else is an override on top. */
const snap = (over = {}) => ({
  at: 0,
  cpu: 10,
  cpuCores: 8,
  load: [0.4, 0.4, 0.3],
  memTotal: 16e9,
  memUsed: 4e9,
  swapTotal: 2e9,
  swapUsed: 0,
  netDown: 0,
  netUp: 0,
  net: [],
  disk: [{ fs: '/dev/sda1', mount: '/', size: 40e9, used: 8e9 }],
  gpu: [],
  uptime: 100,
  info: { hostname: 'h', os: 'o', kernel: 'k', arch: 'x86_64', cpuModel: 'c' },
  ...over
})

const texts = (over) => alertsFor(snap(over)).map((a) => `${a.tone}:${a.text}`)
const tones = (over) => alertsFor(snap(over)).map((a) => a.tone)

/* ---------------- thresholds ---------------- */
check('阈值表是 warn/danger 两档', Object.values(THRESHOLDS).every((t) => t.length === 2 && t[0] < t[1]))
check('不到 warn 就是 ok', toneOf(79, 'cpu') === 'ok' && toneOf(80, 'cpu') === 'warn')
check('到 danger 就是 danger', toneOf(94, 'cpu') === 'warn' && toneOf(95, 'cpu') === 'danger')

/* ---------------- quiet when it should be ---------------- */
check('一切正常时没有任何预警', alertsFor(snap()).length === 0, texts({}).join('|'))
check('内存 84% 还不报', alertsFor(snap({ memUsed: 16e9 * 0.84 })).length === 0)
check('换页关掉了就不看 swap 用量', alertsFor(snap({ swapTotal: 0, swapUsed: 0 })).length === 0)

/* ---------------- each metric ---------------- */
check('CPU 高会报', texts({ cpu: 88 })[0]?.includes('CPU 88%'), texts({ cpu: 88 }).join('|'))
check('内存按已用/总量算', texts({ memUsed: 15e9 })[0] === 'warn:内存 94%', texts({ memUsed: 15e9 }).join('|'))
check('swap 用超六成会报', texts({ swapUsed: 1.4e9 })[0] === 'warn:Swap 70%', texts({ swapUsed: 1.4e9 }).join('|'))
check('磁盘预警带挂载点', texts({ disk: [{ fs: 'x', mount: '/data', size: 100e9, used: 92e9 }] })[0] === 'danger:/data 已用 92%', texts({ disk: [{ fs: 'x', mount: '/data', size: 100e9, used: 92e9 }] }).join('|'))
check('满了的盘一定比快满的排前面', tones({ disk: [
  { fs: 'a', mount: '/a', size: 100e9, used: 82e9 },
  { fs: 'b', mount: '/b', size: 100e9, used: 95e9 }
] })[0] === 'danger')

/* ---------------- gpu ---------------- */
check('显存和温度分开判', texts({ gpu: [{ name: 'T4', util: 5, memTotal: 16e9, memUsed: 15e9, temp: 40 }] }).join('|') === 'warn:T4 显存 94%')
check('GPU 温度高会报', texts({ gpu: [{ name: 'T4', util: 5, memTotal: 16e9, memUsed: 1e9, temp: 82 }] })[0] === 'warn:T4 82°C')
check('GPU 正常就不出现', alertsFor(snap({ gpu: [{ name: 'T4', util: 5, memTotal: 16e9, memUsed: 1e9, temp: 55 }] })).length === 0)

/* ---------------- load ---------------- */
check('负载按核心数折算，不是绝对数', alertsFor(snap({ load: [4, 4, 4] })).length === 0, texts({ load: [4, 4, 4] }).join('|'))
check('每核负载超 1.5 会报', texts({ load: [14, 14, 14] })[0] === 'warn:负载 14.00（8 核）', texts({ load: [14, 14, 14] }).join('|'))
check('每核负载超 2.5 是 danger', tones({ load: [24, 24, 24] })[0] === 'danger')

/* ---------------- ordering ---------------- */
const many = alertsFor(snap({ cpu: 99, memUsed: 16e9 * 0.9, disk: [{ fs: 'x', mount: '/data', size: 100e9, used: 86e9 }] }))
check('多个预警按严重度排', many.map((a) => a.tone).join(',') === 'danger,warn,warn', many.map((a) => `${a.tone}:${a.text}`).join(' | '))

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\nALERTS TEST PASS' : `\nALERTS TEST FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
