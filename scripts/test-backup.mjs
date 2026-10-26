/**
 * Round-trip check for the backup file: what one machine exports, another can
 * import without anyone retyping a password — and what it exports unsealed
 * stays behind.
 *
 * store.ts is bundled against a stub `electron` module, so this runs the real
 * export/import code and the real vault, writing into a temp user-data dir.
 * The stub reports no OS keychain, which exercises the key-file fallback path
 * (vault's v2); the ciphertext wording differs, the logic does not.
 *
 *   node scripts/test-backup.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-backup-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Two user-data dirs: the machine that exports, the one that imports. */
const srcDir = join(work, 'src')
const dstDir = join(work, 'dst')

const stub = join(work, 'electron.mjs')
writeFileSync(
  stub,
  `export const app = { getPath: () => process.env.LITESHELL_HOME }\n` +
    `export const safeStorage = {\n` +
    `  isEncryptionAvailable: () => false,\n` +
    `  encryptString: (s) => Buffer.from(s, 'utf8'),\n` +
    `  decryptString: (b) => b.toString('utf8')\n` +
    `}\n`
)

const bundlePath = join(work, 'store.mjs')
await build({
  entryPoints: ['src/main/store.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  logLevel: 'silent',
  alias: { electron: stub }
})

/** The saved conversations live beside the store, in their own module. */
const historyPath = join(work, 'agenthistory.mjs')
await build({
  entryPoints: ['src/main/agenthistory.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: historyPath,
  logLevel: 'silent',
  alias: { electron: stub }
})

/** A fresh import of the module, pointed at one user-data dir. Electron creates
 *  that dir on a real machine; here the test has to. */
async function machine(dir) {
  mkdirSync(dir, { recursive: true })
  process.env.LITESHELL_HOME = dir
  return import(`file://${bundlePath.replaceAll('\\', '/')}?${Math.random()}`)
}

async function historyFor(dir) {
  mkdirSync(dir, { recursive: true })
  process.env.LITESHELL_HOME = dir
  return import(`file://${historyPath.replaceAll('\\', '/')}?${Math.random()}`)
}

const src = await machine(srcDir)
src.upsertConnection(
  {
    id: 'c1',
    name: '生产机',
    folderId: undefined,
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    termType: 'xterm-256color',
    keepalive: 30
  },
  'root-password'
)
src.upsertConnection(
  {
    id: 'c2',
    name: '无密码的机器',
    host: '10.0.0.2',
    port: 22,
    username: 'deploy',
    authType: 'password',
    termType: 'xterm-256color',
    keepalive: 30
  },
  null
)
src.setSettings({
  ...src.publicStore().settings,
  theme: 'gruvbox',
  fontSize: 18,
  agentWidth: 720,
  llm: { provider: 'openai', baseUrl: 'http://gw:8000/v1', model: 'gw-model', apiKey: 'sk-secret' }
})
src.rememberHostKey({ host: '10.0.0.1', port: 22 }, 'SHA256:aaa')
src.rememberHostKey({ host: '10.0.0.9', port: 2222 }, 'SHA256:bbb')

/* A saved conversation on c1 and one on a machine outside every scope used
   below, so the export tests can tell "follows the connection" from "went along". */
const srcHistory = await historyFor(srcDir)
const convo = srcHistory.append(null, 'c1', { kind: 'user', text: '磁盘满了没' })
srcHistory.append(convo, 'c1', { kind: 'assistant', text: '还有 12% 空间。' })
srcHistory.append(null, 'c2', { kind: 'user', text: '看看部署目录' })
// A conversation whose connection no longer exists: it stays behind, because
// there is nothing in the file for it to belong to.
srcHistory.append(null, 'loose', { kind: 'user', text: '另一台机器' })
srcHistory.flush()

const sealed = src.exportBundle('口令 abc')
check('导出时报了带走的密码数（1 条连接 + 1 个 API Key）', sealed.passwords === 2, String(sealed.passwords))
check('口令封进了 secrets', !!sealed.bundle.secrets)
check('界面设置和主机指纹也进包',
  sealed.bundle.settings?.theme === 'gruvbox' && sealed.bundle.knownHosts?.length === 2,
  JSON.stringify({ theme: sealed.bundle.settings?.theme, hosts: sealed.bundle.knownHosts?.length }))
check('settings 里没有 llm（模型那一半单独走）', !('llm' in (sealed.bundle.settings ?? {})))
check('模型配置进包，但 key 不在明处',
  sealed.bundle.llm?.model === 'gw-model' && !JSON.stringify(sealed.bundle.llm).includes('sk-secret'),
  JSON.stringify(sealed.bundle.llm))

// The file as it lands on disk — a scanner looks at exactly this string.
const file = JSON.stringify(sealed.bundle)
check('文件里搜不到连接密码', !file.includes('root-password'))
check('文件里搜不到 API Key', !file.includes('sk-secret'))

const dst = await machine(dstDir)
let refused = false
try {
  dst.importBundle(sealed.bundle, join(dstDir, 'keys'), '口令错了')
} catch {
  refused = true
}
check('口令不对时整个导入被拒', refused)
check('拒绝之后没有留下半条连接', dst.publicStore().connections.length === 0)
check('拒绝之后设置和指纹也一个字没改',
  dst.store().settings.theme !== 'gruvbox' && dst.store().knownHosts.length === 0)

const report = dst.importBundle(sealed.bundle, join(dstDir, 'keys'), '口令 abc')
check('密码跟着过来了', report.passwords === 1 && report.llm === true, JSON.stringify(report))
const [c1, c2] = dst.publicStore().connections
check('有密码的那条：本机钥匙串里有，连的时候不会再问',
  c1.id === 'c1' && c1.hasSecret === true && dst.secretOf(dst.store().connections[0]) === 'root-password',
  JSON.stringify({ id: c1.id, hasSecret: c1.hasSecret }))
check('本来就没存密码的那条，导入后照旧没有',
  c2.id === 'c2' && !c2.hasSecret)
check('模型配置落地了，API Key 也一并进来',
  dst.llmSettings().model === 'gw-model' && dst.llmSettings().apiKey === 'sk-secret',
  JSON.stringify({ ...dst.llmSettings(), apiKey: dst.llmSettings().apiKey ? '(有)' : '(无)' }))
check('界面设置落地了：主题、字号、面板宽度',
  dst.store().settings.theme === 'gruvbox' && dst.store().settings.fontSize === 18 && dst.store().settings.agentWidth === 720,
  JSON.stringify([dst.store().settings.theme, dst.store().settings.fontSize, dst.store().settings.agentWidth]))
check('主机指纹跟着来，对面不会再问一遍',
  dst.legacyHostKey('10.0.0.1', 22) === 'SHA256:aaa' && dst.legacyHostKey('10.0.0.9', 2222) === 'SHA256:bbb',
  JSON.stringify(dst.store().knownHosts))

// The other direction: no passphrase, no passwords on the other side.
const plain = src.exportBundle()
check('不设口令时一个密码都不外带', plain.passwords === 0 && !plain.bundle.secrets)
const dst2 = await machine(join(work, 'dst2'))
const report2 = dst2.importBundle(plain.bundle, join(work, 'dst2', 'keys'))
check('不设口令导入：连接来了、密码没来', report2.connections === 2 && report2.passwords === 0)
check('于是那条连接会照常弹密码框', dst2.publicStore().connections[0].hasSecret !== true)
check('模型接口照样过来了（它不是秘密）', dst2.llmSettings().model === 'gw-model')
check('界面设置和主机指纹也不靠口令', report2.settings === true && report2.hostKeys === 2, JSON.stringify(report2))
check('但 API Key 留在原机器，没有被清空或被顶掉', dst2.llmSettings().apiKey === '')

/* ---------------- one connection only ---------------- */

const one = src.exportBundle('口令 abc', ['c1'])
check('单条导出只带那条连接', one.bundle.connections.length === 1 && one.bundle.connections[0].id === 'c1')
check('单条导出只带它的密码（不连 API Key 一起走）', one.passwords === 1, String(one.passwords))
check('单条导出不带别的设置 / 模型 / 私钥 / 文件夹',
  one.bundle.folders.length === 0 && !one.bundle.llm && !one.bundle.settings && one.bundle.keys.length === 0,
  JSON.stringify({ folders: one.bundle.folders.length, llm: !!one.bundle.llm, settings: !!one.bundle.settings, keys: one.bundle.keys.length }))
const oneDst = await machine(join(work, 'one'))
oneDst.importBundle(one.bundle, join(work, 'one', 'keys'), '口令 abc')
check('对面导入后只有这一条，且密码可用',
  oneDst.publicStore().connections.length === 1 &&
    oneDst.publicStore().connections[0].id === 'c1' &&
    oneDst.secretOf(oneDst.store().connections[0]) === 'root-password')

/* ---------------- conversations travel with their connections ---------------- */

check('单条导出带上这条连接的对话',
  one.bundle.agentHistory?.length === 1 && one.bundle.agentHistory[0].connectionId === 'c1',
  JSON.stringify(one.bundle.agentHistory?.map((c) => c.connectionId)))
const oneDstHistory = await historyFor(join(work, 'one'))
check('对面看得到这段对话，标题是第一句话',
  oneDstHistory.list('c1').length === 1 && oneDstHistory.list('c1')[0].title === '磁盘满了没',
  JSON.stringify(oneDstHistory.list('c1')))
check('导出没把别的机器的对话带过去', !(oneDstHistory.list('loose').length > 0))

check('整机导出带上所有对话', (sealed.bundle.agentHistory?.length ?? 0) === 2,
  JSON.stringify(sealed.bundle.agentHistory?.map((c) => c.connectionId)))
check('对话里没有流式增量（只存落地的事件）',
  sealed.bundle.agentHistory.every((c) => c.events.every((e) => e.kind !== 'delta')))
check('文件里搜不到对话内容以外的私密字段',
  !JSON.stringify(sealed.bundle.agentHistory).includes('root-password'))

/* ---------------- one folder and its subtree ---------------- */

const [c1pub, c2pub] = src.publicStore().connections
const strip = ({ hasSecret: _h, secret: _s, ...rest }) => rest
src.upsertFolder({ id: 'f1', name: '生产环境', parentId: null })
src.upsertFolder({ id: 'f2', name: '华东', parentId: 'f1' })
src.upsertConnection({ ...strip(c1pub), folderId: 'f1' }, null)
src.upsertConnection({ ...strip(c2pub), folderId: 'f2' }, null)

const folderBundle = src.exportBundle('口令 abc', undefined, 'f1')
check('文件夹导出只带这棵子树',
  folderBundle.bundle.folders.length === 2 &&
    folderBundle.bundle.connections.map((c) => c.id).sort().join() === 'c1,c2',
  JSON.stringify({
    folders: folderBundle.bundle.folders.map((f) => f.id),
    conns: folderBundle.bundle.connections.map((c) => c.id)
  }))
check('导出的文件夹成为根，不会悬空',
  folderBundle.bundle.folders.find((f) => f.id === 'f1')?.parentId === null &&
    folderBundle.bundle.folders.find((f) => f.id === 'f2')?.parentId === 'f1')
check('文件夹导出不带模型配置和界面设置',
  !folderBundle.bundle.llm && !folderBundle.bundle.settings)
check('文件夹导出只带用到的密码', folderBundle.passwords === 1, String(folderBundle.passwords))

const dstF = await machine(join(work, 'dstF'))
dstF.importBundle(folderBundle.bundle, join(work, 'dstF', 'keys'), '口令 abc')
const dstFolders = dstF.publicStore().folders
check('文件夹结构在对面重建',
  dstFolders.length === 2 &&
    dstFolders.find((f) => f.id === 'f1')?.parentId === null &&
    dstFolders.find((f) => f.id === 'f2')?.parentId === 'f1',
  JSON.stringify(dstFolders))
check('子树之外的连接没有跟过去',
  dstF.publicStore().connections.length === 2 &&
    dstF.publicStore().connections.every((c) => c.id !== 'c3'))
check('文件夹里的密码导入后可用',
  dstF.secretOf(dstF.store().connections.find((c) => c.id === 'c1')) === 'root-password')

/* ---------------- a key that travels with the file ---------------- */

writeFileSync(join(srcDir, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nSMOKE\n-----END OPENSSH PRIVATE KEY-----\n')
const keyOrg = src.addKey(join(srcDir, 'id_ed25519'), '部署密钥', 'key-pass')
src.upsertConnection(
  {
    id: 'c3',
    name: '密钥机',
    host: '10.0.0.3',
    port: 22,
    username: 'root',
    authType: 'key',
    privateKeyPath: keyOrg.path,
    termType: 'xterm-256color',
    keepalive: 30
  },
  null
)
const withKey = src.exportBundle('口令 abc')
const dst3 = await machine(join(work, 'dst3'))
const report3 = dst3.importBundle(withKey.bundle, join(work, 'dst3', 'keys'), '口令 abc')
check('私钥文件在对面被写出来了',
  report3.keys === 1 && report3.missingKeys === 0, JSON.stringify(report3))
const c3 = dst3.publicStore().connections.find((c) => c.id === 'c3')
check('连接指向的是对面那把，不是源机器的路径',
  !!c3?.privateKeyPath && c3.privateKeyPath.startsWith(join(work, 'dst3')), c3?.privateKeyPath)
check('私钥口令跟着密文走，对面复用它时不用再输',
  !!c3?.privateKeyPath && dst3.keySecretOf(c3.privateKeyPath) === 'key-pass')
check('文件里搜不到私钥口令', !JSON.stringify(withKey.bundle).includes('key-pass'))
check('私钥口令也算在带走的密码数里', withKey.passwords >= 2, String(withKey.passwords))

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项未通过` : '\n全部通过')
process.exit(failures ? 1 : 0)
