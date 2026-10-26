/**
 * What counts as "too much" for each metric.
 *
 * Kept out of the renderer on purpose: the alert strip and the coloured numbers
 * read from the same table, so they can never disagree, and the rules stay
 * testable without a browser (scripts/test-alerts.mjs).
 */
import type { MonitorSnapshot } from '../../shared/types'

export type Tone = 'ok' | 'warn' | 'danger'

/** [warn, danger] — warn already means "worth a look". */
export const THRESHOLDS = {
  cpu: [80, 95],
  mem: [85, 95],
  swap: [60, 85],
  disk: [80, 90],
  gpuMem: [85, 95],
  gpuTemp: [75, 88],
  /** Load average per core: 1.0 means the queue is exactly the CPU count. */
  load: [1.5, 2.5],
  /** Round-trip milliseconds to the server. 100 ms is where typing starts to
   *  feel laggy, 300 ms is where people stop using the tab. */
  latency: [100, 300]
} as const satisfies Record<string, readonly [number, number]>

export type Metric = keyof typeof THRESHOLDS

export function toneOf(value: number, metric: Metric): Tone {
  const [warn, danger] = THRESHOLDS[metric]
  return value >= danger ? 'danger' : value >= warn ? 'warn' : 'ok'
}

export interface Alert {
  tone: Tone
  text: string
}

export const usePct = (used: number, total: number, fallback = 0): number =>
  total > 0 ? (used / total) * 100 : fallback

/** Worst first, so the one that matters is the one that gets read. */
const RANK: Record<Tone, number> = { danger: 0, warn: 1, ok: 2 }

export function alertsFor(m: MonitorSnapshot): Alert[] {
  const out: Alert[] = []
  const flag = (tone: Tone, text: string): void => {
    if (tone !== 'ok') out.push({ tone, text })
  }
  const pct = (v: number): string => `${v.toFixed(0)}%`

  flag(toneOf(m.cpu, 'cpu'), `CPU ${pct(m.cpu)}`)
  const mem = usePct(m.memUsed, m.memTotal)
  flag(toneOf(mem, 'mem'), `内存 ${pct(mem)}`)
  if (m.swapTotal) {
    const swap = usePct(m.swapUsed, m.swapTotal)
    flag(toneOf(swap, 'swap'), `Swap ${pct(swap)}`)
  }
  if (m.cpuCores) flag(toneOf(m.load[0] / m.cpuCores, 'load'), `负载 ${m.load[0].toFixed(2)}（${m.cpuCores} 核）`)
  // -1 is "the probe could not connect", not a fast link.
  if (m.latency && m.latency.rtt >= 0) flag(toneOf(m.latency.rtt, 'latency'), `延迟 ${m.latency.rtt} ms`)

  for (const d of m.disk) {
    const used = usePct(d.used, d.size)
    flag(toneOf(used, 'disk'), `${d.mount} 已用 ${pct(used)}`)
  }
  for (const g of m.gpu) {
    const mem = usePct(g.memUsed, g.memTotal)
    flag(toneOf(mem, 'gpuMem'), `${g.name} 显存 ${pct(mem)}`)
    flag(toneOf(g.temp, 'gpuTemp'), `${g.name} ${g.temp}°C`)
  }

  return out.sort((a, b) => RANK[a.tone] - RANK[b.tone])
}
