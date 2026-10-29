import type { CpuCore, GpuInfo, MonitorSnapshot, NetCounter, NetIface, ProcInfo } from '../shared/types'

/**
 * Resource sampling for Linux hosts, in the spirit of what FinalShell scrapes:
 * two reads of /proc/stat and /proc/net/dev a second apart give real rates; the
 * rest is one-shot. Everything is read-only and needs no sudo.
 *
 * One exec, one round trip. The `sleep 1` is what makes CPU% and network rates
 * percentages rather than "since boot" totals.
 */
export const MONITOR_SCRIPT = [
  'export LC_ALL=C',
  'echo "@@A"',
  'head -1 /proc/stat',
  'cat /proc/net/dev',
  'echo "@@B"',
  'sleep 1',
  'head -1 /proc/stat',
  'cat /proc/net/dev',
  'echo "@@MEM"',
  'cat /proc/meminfo',
  'echo "@@DISK"',
  'df -kP 2>/dev/null',
  'echo "@@LOAD"',
  'cat /proc/loadavg 2>/dev/null',
  'cat /proc/uptime 2>/dev/null',
  'echo "@@PROC"',
  // Busiest first, ten rows: this table is for spotting the process that is
  // eating the box, not for a complete listing. `|` is the field separator, and
  // the command line is last so it may contain anything.
  'ps -ww -eo pid=,user=,pcpu=,pmem=,rss=,comm=,args= --sort=-pcpu 2>/dev/null | head -n 10 | while read -r pid user pcpu pmem rss comm args; do',
  '  rd=0; wr=0',
  '  while read -r k v; do case "$k" in read_bytes:) rd=$v;; write_bytes:) wr=$v;; esac; done < /proc/$pid/io 2>/dev/null',
  '  exe=$(readlink /proc/$pid/exe 2>/dev/null)',
  '  echo "$pid|$user|$pcpu|$pmem|$rss|$rd|$wr|$comm|$exe|$args"',
  'done',
  'echo "@@INFO"',
  // Labelled so the parser does not depend on `nproc` existing or on line order.
  'echo "hostname=$(hostname 2>/dev/null)"',
  'echo "kernel=$(uname -sr 2>/dev/null)"',
  'echo "arch=$(uname -m 2>/dev/null)"',
  'echo "cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null)"',
  'echo "cpu=$(grep -m1 model.name /proc/cpuinfo 2>/dev/null | cut -d: -f2-)"',
  'echo "os=$(. /etc/os-release 2>/dev/null && echo \\"$PRETTY_NAME\\")"',
  'echo "@@GPU"',
  'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null',
  'echo "@@END"'
].join('\n')

const EMPTY = {
  at: 0,
  cpu: 0,
  cpuCores: 0,
  load: [0, 0, 0] as [number, number, number],
  memTotal: 0,
  memUsed: 0,
  swapTotal: 0,
  swapUsed: 0,
  netDown: 0,
  netUp: 0,
  net: [],
  netTotals: [],
  disk: [],
  gpu: [],
  proc: [],
  uptime: 0,
  info: { hostname: '', os: '', kernel: '', arch: '', cpuModel: '' }
}

function unquote(value: string | undefined): string {
  return (value ?? '').trim().replace(/^"|"$/g, '')
}

/** `cpu  user nice system idle iowait irq softirq steal guest guest_nice` */
function parseStat(line: string): CpuCore | null {
  const parts = line.trim().split(/\s+/).slice(1).map(Number)
  if (parts.length < 4 || parts.some(Number.isNaN)) return null
  const total = parts.reduce((a, b) => a + b, 0)
  // idle + iowait both mean the core was not doing work.
  return { total, idle: parts[3] + (parts[4] ?? 0) }
}

/** interleaved `iface: rx... tx...` -> bytes in/out per interface */
function parseNet(lines: string[]): Map<string, NetIface> {
  const out = new Map<string, NetIface>()
  for (const line of lines) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const cols = m[2].trim().split(/\s+/).map(Number)
    if (cols.length < 16) continue
    out.set(m[1].trim(), { rx: cols[0], tx: cols[8] })
  }
  return out
}

function splitV2(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {}
  let current = ''
  for (const line of text.split('\n')) {
    const marker = /^@@(\w+)\s*$/.exec(line.trim())
    if (marker) {
      current = marker[1]
      sections[current] = []
      continue
    }
    if (current) sections[current].push(line)
  }
  return sections
}

function num(value: string | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Used both ways: as a parser for the output of MONITOR_SCRIPT, and as the shape
 * the renderer keeps for rate maths. Pure — no ssh2, no Electron.
 */
export function parseMonitor(raw: string, at = Date.now()): MonitorSnapshot {
  const sections = splitV2(raw)
  // Spread EMPTY but re-create every array: a shallow copy would share the same
  // lists between calls and each snapshot would inherit the previous one's rows.
  const snapshot: MonitorSnapshot = {
    ...EMPTY,
    info: { ...EMPTY.info },
    load: [0, 0, 0],
    net: [],
    netTotals: [],
    disk: [],
    gpu: [],
    proc: [],
    at
  }

  /* --- CPU: two samples a second apart --- */
  const cpuA = parseStat(sections.A?.[0] ?? '')
  const cpuB = parseStat(sections.B?.[0] ?? '')
  if (cpuA && cpuB) {
    const dTotal = cpuB.total - cpuA.total
    const dIdle = cpuB.idle - cpuA.idle
    snapshot.cpu = dTotal > 0 ? Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100)) : 0
  }

  /* --- network: same two samples --- */
  // The two `Inter-|`/` face |` header lines carry no colon, so they drop out here.
  const netLines = (section: string): string[] =>
    (sections[section] ?? []).filter((l) => l.includes(':') && !l.includes('|'))
  const netA = parseNet(netLines('A'))
  const netB = parseNet(netLines('B'))
  // The script sleeps exactly one second between samples, so byte deltas == bytes/second.
  for (const [name, b] of netB) {
    const a = netA.get(name)
    if (!a) continue
    const rx = Math.max(0, b.rx - a.rx)
    const tx = Math.max(0, b.tx - a.tx)
    snapshot.net.push({ name, rx, tx })
    if (name === 'lo') continue // loopback would double-count local traffic
    snapshot.netDown += rx
    snapshot.netUp += tx
  }
  // Same sample, read as a counter rather than a delta: traffic since boot is
  // what people mean by "how much has this box moved", and a reboot resets it.
  if (netB.size) {
    const totals: NetCounter[] = []
    for (const [name, b] of netB) {
      if (name === 'lo') continue
      totals.push({ name, rxBytes: b.rx, txBytes: b.tx })
    }
    snapshot.netTotals = totals.sort((x, y) => y.rxBytes + y.txBytes - (x.rxBytes + x.txBytes))
  }

  /* --- memory --- */
  const mem: Record<string, number> = {}
  for (const line of sections.MEM ?? []) {
    const m = /^(\w+):\s+(\d+)/.exec(line)
    if (m) mem[m[1]] = Number(m[2]) * 1024
  }
  snapshot.memTotal = mem.MemTotal ?? 0
  // MemAvailable is what `free` calls available; fall back for ancient kernels.
  snapshot.memUsed = snapshot.memTotal - (mem.MemAvailable ?? mem.MemFree ?? 0)
  snapshot.swapTotal = mem.SwapTotal ?? 0
  snapshot.swapUsed = snapshot.swapTotal - (mem.SwapFree ?? 0)

  /* --- disk: skip pseudo filesystems, they are noise --- */
  for (const line of (sections.DISK ?? []).slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6) continue
    const fs = cols[0]
    const mount = cols[5]
    if (mount.startsWith('/proc') || mount.startsWith('/sys') || mount.startsWith('/dev')) continue
    if (fs === 'tmpfs' || fs === 'devtmpfs' || fs === 'overlay' || fs === 'shm') continue
    const size = Number(cols[1]) * 1024
    const used = Number(cols[2]) * 1024
    if (!Number.isFinite(size) || size === 0) continue
    snapshot.disk.push({ fs, mount, size, used })
  }
  snapshot.disk.sort((a, b) => b.used / b.size - a.used / a.size)

  /* --- load + uptime --- */
  const load = (sections.LOAD?.[0] ?? '').trim().split(/\s+/)
  if (load.length >= 3) snapshot.load = [num(load[0]), num(load[1]), num(load[2])]
  snapshot.uptime = num((sections.LOAD?.[1] ?? '').trim().split(/\s+/)[0])

  /* --- identity: `key=value` lines, so order and missing tools don't matter --- */
  const fields: Record<string, string> = {}
  for (const line of sections.INFO ?? []) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    fields[line.slice(0, eq).trim()] = unquote(line.slice(eq + 1))
  }
  snapshot.cpuCores = num(fields.cores)
  snapshot.info = {
    hostname: fields.hostname ?? '',
    kernel: fields.kernel ?? '',
    arch: fields.arch ?? '',
    cpuModel: fields.cpu ?? '',
    os: fields.os || fields.kernel || ''
  }

  /* --- GPU: one line per card; empty when nvidia-smi is absent --- */
  for (const line of sections.GPU ?? []) {
    const cols = line.split(',').map((c) => c.trim())
    if (cols.length < 5 || !/^[\d.]+$/.test(cols[1])) continue
    snapshot.gpu.push({
      name: cols[0],
      util: num(cols[1]),
      memUsed: num(cols[2]) * 1024 * 1024,
      memTotal: num(cols[3]) * 1024 * 1024,
      temp: num(cols[4])
    } satisfies GpuInfo)
  }

  /* --- processes: `pid|user|cpu|mem|rss|read|write|comm|exe|args` ---
     `exe` is empty for another user's process without CAP_SYS_PTRACE, and the
     command line is the honest fallback in that case. */
  for (const line of sections.PROC ?? []) {
    const [pid, user, pcpu, pmem, rss, rd, wr, comm, exe, ...rest] = line.split('|')
    if (!/^\d+$/.test((pid ?? '').trim())) continue
    const args = rest.join('|').trim()
    snapshot.proc.push({
      pid: Number(pid),
      user: (user ?? '').trim() || '?',
      cpu: num(pcpu),
      mem: num(pmem),
      rss: num(rss) * 1024,
      diskRead: num(rd) * 1024,
      diskWrite: num(wr) * 1024,
      name: (comm ?? '').trim() || args.split(/\s+/)[0] || `pid ${pid}`,
      cmd: args || (comm ?? '').trim(),
      path: (exe ?? '').trim() || undefined
    } satisfies ProcInfo)
  }

  return snapshot
}