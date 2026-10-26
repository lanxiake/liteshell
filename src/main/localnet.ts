import { networkInterfaces } from 'node:os'
import { connect } from 'node:net'

/**
 * Which local address a connection leaves through.
 *
 * A pinned address is exact but breaks the moment the tunnel comes back with a
 * different one — which is the normal case for a VPN after a reboot. An
 * interface name survives that: the address is looked up at connect time, every
 * time. Both are only hints to the socket, so the answer is `undefined` rather
 * than an error when neither is set.
 */
export function bindAddress(conn: { localAddress?: string; localIface?: string }): string | undefined {
  // The interface wins when both are set: its address is looked up at connect
  // time, so a tunnel that came back with a new one still matches, while a
  // pinned address would be pointing at a lease that no longer exists.
  const iface = conn.localIface?.trim()
  if (iface) {
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      if (name !== iface) continue
      // IPv4 first: a VPN tunnel's v6 address is usually link-local and useless here.
      const v4 = addrs?.find((a) => a.family === 'IPv4' && !a.internal)
      const any = v4 ?? addrs?.find((a) => !a.internal)
      if (any) return any.address
    }
  }
  return conn.localAddress?.trim() || undefined
}

export interface LocalIface {
  name: string
  address: string
}

/** What the picker in the connection dialog lists: non-internal addresses only,
 *  which is exactly the set a VPN tunnel appears in. */
export function localInterfaces(): LocalIface[] {
  const out: LocalIface[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') out.push({ name, address: a.address })
    }
  }
  return out
}

/**
 * One TCP handshake, timed. This is the number a person means by "延迟": how
 * long the line takes, before the server has done anything at all. Bounded so a
 * black-holed tunnel shows up as a timeout, not a hung monitor panel.
 */
export function probeLatency(host: string, port: number, source?: string, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = connect({ host, port, ...(source ? { localAddress: source } : {}) })
    let done = false
    const finish = (value: number): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(Date.now() - started))
    socket.once('timeout', () => finish(-1))
    socket.once('error', () => finish(-1))
    const timer = setTimeout(() => finish(-1), timeoutMs + 500)
  })
}
