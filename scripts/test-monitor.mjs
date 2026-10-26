/**
 * Unit check for the resource-monitor parser, against a canned capture of what
 * MONITOR_SCRIPT prints on a normal Linux box.
 *
 *   node scripts/test-monitor.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-monitor-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol

const RAW = `@@A
cpu  12345 100 2000 50000 300 0 50 0 0 0
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 500000 400 0 0 0 0 0 0 200000 300 0 0 0 0 0 0
@@B
cpu  12445 100 2010 50200 300 0 50 0 0 0
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 2000 20 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
  eth0: 512000 500 0 0 0 0 0 0 204800 400 0 0 0 0 0 0
@@MEM
MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    4000000 kB
Buffers:          500000 kB
SwapTotal:       2048000 kB
SwapFree:        2048000 kB
@@DISK
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1       41000000  30000000   9000000      77% /
tmpfs            8000000         0   8000000       0% /dev/shm
/dev/sdb1      100000000  20000000  75000000      21% /data
@@LOAD
0.52 0.58 0.59 1/234 5678
98765.43 1234567.89
@@INFO
hostname=web-01
kernel=Linux 5.15.0-91-generic
arch=x86_64
cores=8
cpu= Intel(R) Xeon(R) Platinum 8269CY CPU @ 2.50GHz
os=Ubuntu 22.04.3 LTS
@@GPU
Tesla T4, 37, 1024, 15360, 45
@@END`

const bundle = join(work, 'monitor.mjs')
await build({
  entryPoints: ['src/main/monitor.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { parseMonitor } = await import(`file://${bundle.replaceAll('\\', '/')}`)

const m = parseMonitor(RAW)

/* ---------------- cpu ---------------- */
// dTotal = 310, dIdle = idle+iowait = 50000+300 -> 50200+300, so 200/310 idle.
check('CPU 使用率按两次采样的差值算', near(m.cpu, (110 / 310) * 100, 0.05), `got ${m.cpu.toFixed(2)}`)

/* ---------------- network ---------------- */
check('下行速率取两次采样的差', m.netDown === 12000, `got ${m.netDown}`)
check('上行速率取两次采样的差', m.netUp === 4800, `got ${m.netUp}`)
check('回环不计入总速率', m.netDown + m.netUp === 16800, `got ${m.netDown + m.netUp}`)
check(
  '回环仍然单列出来',
  m.net.some((n) => n.name === 'lo' && n.rx === 1000 && n.tx === 1000),
  JSON.stringify(m.net)
)
check('表头行没有被当成网卡', m.net.length === 2, `got ${m.net.map((n) => n.name).join(',')}`)
check('累计流量取第二次采样，不是两次之差', m.netTotals.find((n) => n.name === 'eth0')?.rxBytes === 512000,
  JSON.stringify(m.netTotals))
check('累计流量不含回环', !m.netTotals.some((n) => n.name === 'lo'), JSON.stringify(m.netTotals))

/* ---------------- memory ---------------- */
check('内存总量', m.memTotal === 16384000 * 1024, `got ${m.memTotal}`)
check('已用内存按 MemAvailable 算', m.memUsed === (16384000 - 4000000) * 1024, `got ${m.memUsed}`)
check('swap 全空时为 0', m.swapUsed === 0, `got ${m.swapUsed}`)

/* ---------------- disk ---------------- */
check('tmpfs 被过滤掉', m.disk.length === 2, `got ${m.disk.map((d) => d.mount).join(',')}`)
check('按占用比例倒序（最紧张的在前）', m.disk[0].mount === '/', `got ${m.disk[0].mount}`)
check('磁盘容量换算成字节', m.disk[0].size === 41000000 * 1024, `got ${m.disk[0].size}`)

/* ---------------- load / uptime ---------------- */
check('load average 三项', m.load.join(',') === '0.52,0.58,0.59', m.load.join(','))
check('uptime', near(m.uptime, 98765.43), `got ${m.uptime}`)

/* ---------------- info ---------------- */
check('hostname', m.info.hostname === 'web-01', m.info.hostname)
check('内核', m.info.kernel === 'Linux 5.15.0-91-generic', m.info.kernel)
check('架构', m.info.arch === 'x86_64', m.info.arch)
check('核心数', m.cpuCores === 8, `got ${m.cpuCores}`)
check('CPU 型号去掉前导空格', m.info.cpuModel.startsWith('Intel(R)'), m.info.cpuModel)
check('发行版', m.info.os === 'Ubuntu 22.04.3 LTS', m.info.os)

/* ---------------- gpu ---------------- */
check('解析出一块 GPU', m.gpu.length === 1, `got ${m.gpu.length}`)
check('GPU 利用率与温度', m.gpu[0].util === 37 && m.gpu[0].temp === 45, JSON.stringify(m.gpu[0]))
check('显存 MiB 换算成字节', m.gpu[0].memTotal === 15360 * 1024 * 1024, `got ${m.gpu[0].memTotal}`)

/* ---------------- degradation: no tools, no gpu, ancient kernel ---------------- */
const bare = parseMonitor(`@@A
cpu  100 0 0 100 0 0 0 0 0 0
@@B
cpu  200 0 0 200 0 0 0 0 0 0
@@MEM
MemTotal:        1000000 kB
MemFree:          200000 kB
@@INFO
hostname=min
kernel=Linux 3.10.0
@@GPU
@@END`)
check('没有 nvidia-smi 时 GPU 列表为空', bare.gpu.length === 0)
check('没有 MemAvailable 时退回 MemFree', bare.memUsed === (1000000 - 200000) * 1024, `got ${bare.memUsed}`)
check('没有 /proc/net/dev 时速率为 0', bare.netDown === 0 && bare.netUp === 0)
check('没有网卡时累计流量为空列表而不是 undefined', Array.isArray(bare.netTotals) && bare.netTotals.length === 0)
check('没有 nproc 时核心数为 0 而不是 NaN', bare.cpuCores === 0)
check('完全没有输出也不抛异常', parseMonitor('').cpu === 0)

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\nMONITOR TEST PASS' : `\nMONITOR TEST FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
