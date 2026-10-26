/**
 * Which local address a connection binds to. The point of the interface setting
 * is that a VPN handing out a new address after a reconnect still matches, so
 * this checks the lookup rather than a stored string.
 *
 *   node scripts/test-localnet.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-localnet-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/* A stub for node:os with the two VPN-ish interfaces this test reasons about. */
const stub = join(work, 'os.mjs')
writeFileSync(
  stub,
  `export const networkInterfaces = () => ({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    'tun0': [{ address: '10.7.8.7', family: 'IPv4', internal: false }],
    'utun3': [{ address: 'fe80::1', family: 'IPv6', internal: false }],
    down0: []
  })\n` +
    `export const connect = () => { throw new Error('not used here') }\n`
)

const out = join(work, 'localnet.mjs')
await build({
  entryPoints: ['src/main/localnet.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
  plugins: [
    {
      name: 'stub-os',
      setup(build) {
        build.onResolve({ filter: /^node:os$/ }, () => ({ path: stub }))
      }
    }
  ]
})
const { bindAddress, localInterfaces } = await import(pathToFileURL(out).href)

check('没配就不绑定，交给路由表', bindAddress({}) === undefined)
check('写死的地址原样使用', bindAddress({ localAddress: '10.7.8.7' }) === '10.7.8.7')
check('前后空格不算地址的一部分', bindAddress({ localAddress: '  10.7.8.7 ' }) === '10.7.8.7')
check('网卡名当场查出地址', bindAddress({ localIface: 'tun0' }) === '10.7.8.7')
check('网卡和地址同时填时网卡优先（VPN 换地址后还能对上）',
  bindAddress({ localIface: 'tun0', localAddress: '10.7.8.99' }) === '10.7.8.7')
check('网卡不存在就退回写死的地址', bindAddress({ localIface: 'nope0', localAddress: '10.0.0.5' }) === '10.0.0.5')
check('网卡不存在又不填地址时干脆不绑定', bindAddress({ localIface: 'nope0' }) === undefined)
check('只有 IPv6 的网卡也能用', bindAddress({ localIface: 'utun3' }) === 'fe80::1')
check('网卡在但没地址时为 undefined', bindAddress({ localIface: 'down0' }) === undefined)

const list = localInterfaces()
check('选择列表只列 IPv4 且跳过回环', list.map((i) => i.name).join(',') === 'eth0,tun0', JSON.stringify(list))
check('列表带地址，看得出现在是哪个', list.find((i) => i.name === 'tun0')?.address === '10.7.8.7')

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
