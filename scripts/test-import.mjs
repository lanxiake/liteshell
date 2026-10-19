/**
 * Unit check for the FinalShell importer, run against a synthetic install tree
 * so it does not depend on any machine having FinalShell on it.
 *
 *   node scripts/test-import.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-import-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/* ---------------- fixture: a miniature FinalShell install ---------------- */

const fsRoot = join(work, 'finalshell')
const conn = join(fsRoot, 'conn')
const sub = join(conn, 'folderA')
const nested = join(sub, 'folderB')
mkdirSync(nested, { recursive: true })

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n'

function folder(dir, id, name, parent) {
  writeFileSync(join(dir, 'folder.json'), JSON.stringify({ id, name, parent_id: parent }))
}
function connection(dir, cfg) {
  writeFileSync(join(dir, `${cfg.id}_connect_config.json`), JSON.stringify(cfg))
}

folder(sub, 'folderA', '生产环境', 'root')
folder(nested, 'folderB', '嵌套层', 'folderA')

connection(conn, {
  id: 'c1',
  name: 'root上的机器',
  host: '10.0.0.1',
  port: 22,
  user_name: 'root',
  authentication_type: 1,
  parent_id: 'root',
  conection_type: 100
})
connection(sub, {
  id: 'c2',
  name: '用密钥的机器',
  host: '10.0.0.2',
  port: 2222,
  user_name: 'deploy',
  authentication_type: 2,
  secret_key_id: 'key1',
  parent_id: 'folderA',
  conection_type: 100
})
connection(nested, {
  id: 'c3',
  name: '引用了不存在密钥',
  host: '10.0.0.3',
  user_name: 'ubuntu',
  authentication_type: 2,
  secret_key_id: 'gone',
  parent_id: 'folderB',
  conection_type: 100
})
connection(sub, {
  id: 'c4',
  name: '不是SSH',
  host: '10.0.0.4',
  port: 3389,
  authentication_type: 1,
  parent_id: 'folderA',
  conection_type: 200
})

writeFileSync(
  join(fsRoot, 'config.json'),
  JSON.stringify({
    secret_key_list: [{ id: 'key1', name: '部署密钥', key_data: Buffer.from(PEM).toString('base64') }]
  })
)

/* ---------------- run the real module ---------------- */

const bundle = join(work, 'finalshell.mjs')
await build({
  entryPoints: ['src/main/finalshell.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { importFinalshell } = await import(`file://${bundle.replaceAll('\\', '/')}`)

const keyDir = join(work, 'keys')
const result = importFinalshell(fsRoot, keyDir)
const byId = Object.fromEntries(result.connections_new.map((c) => [c.id, c]))
const foldersById = Object.fromEntries(result.folders_new.map((f) => [f.id, f]))

/* ---------------- assertions ---------------- */

check('导入 2 个文件夹', result.folders === 2, `got ${result.folders}`)
check('导入 3 条 SSH 连接', result.connections === 3, `got ${result.connections}`)
check('跳过 1 条非 SSH 连接', result.skipped === 1, `got ${result.skipped}`)
check('统计出 1 条需要补录密码', result.needsPassword === 1, `got ${result.needsPassword}`)

check('根级连接的 folderId 为 null', byId['fs-c1'].folderId === null)
check('一级文件夹挂到根', foldersById['fs-folderA'].parentId === null)
check('二级文件夹的父级被重映射', foldersById['fs-folderB'].parentId === 'fs-folderA')
check('子文件夹里的连接挂到子文件夹', byId['fs-c3'].folderId === 'fs-folderB')

check('主机/端口/用户名正确', byId['fs-c2'].host === '10.0.0.2' && byId['fs-c2'].port === 2222 && byId['fs-c2'].username === 'deploy')
check('缺省端口补成 22', byId['fs-c3'].port === 22)
check('密码认证连接不带密钥', byId['fs-c1'].authType === 'password' && !byId['fs-c1'].privateKeyPath)
check('密钥认证连接带上私钥', byId['fs-c2'].authType === 'key')
check('私钥文件已写出', !!byId['fs-c2'].privateKeyPath && existsSync(byId['fs-c2'].privateKeyPath))
check('写出的私钥内容正确', readFileSync(byId['fs-c2'].privateKeyPath, 'utf8') === PEM)
check('只导出了被引用的私钥', result.keys === 1, `got ${result.keys}`)
check('丢失的私钥给出告警', result.warnings.some((w) => w.includes('gone')))
check('丢失私钥的连接仍被导入', !!byId['fs-c3'] && !byId['fs-c3'].privateKeyPath)
check('非 SSH 连接没有被导入', !byId['fs-c4'])

/* ---------------- idempotency: re-import must not duplicate ---------------- */
const again = importFinalshell(fsRoot, keyDir)
const ids = new Set([...result.connections_new, ...again.connections_new].map((c) => c.id))
check('二次导入 id 稳定（不会重复）', ids.size === again.connections, `ids=${ids.size}`)

/* ---------------- exported-tree shape (what 右键 → 导出 writes) ---------------- */

const expRoot = join(work, 'export')
const expSub = join(expRoot, '生产环境', '华东')
mkdirSync(expSub, { recursive: true })
// No folder.json anywhere: the directory name is the folder name. parent_id points
// at folder ids from the machine that did the exporting, so it must be ignored.
connection(expSub, {
  id: 'e2',
  name: '内网机器',
  host: '10.1.1.2',
  user_name: 'ops',
  authentication_type: 1,
  parent_id: '1xfv06i5syufcy73',
  conection_type: 100
})
connection(expRoot, {
  id: 'e1',
  name: '顶层机器',
  host: '10.1.1.1',
  user_name: 'root',
  authentication_type: 1,
  parent_id: 'root',
  conection_type: 100
})

const exp = importFinalshell(expRoot, join(work, 'keys2'))
const expFolders = Object.fromEntries(exp.folders_new.map((f) => [f.id, f]))
const expConns = Object.fromEntries(exp.connections_new.map((c) => [c.id, c]))

check('导出树：不靠 folder.json 也能建出文件夹', exp.folders === 2, `got ${exp.folders}`)
check('导出树：一级文件夹名为目录名', expFolders['fs-dir:生产环境']?.name === '生产环境')
check('导出树：二级文件夹的父级按路径串起来', expFolders['fs-dir:生产环境/华东']?.parentId === 'fs-dir:生产环境')
check('导出树：深层连接挂到对应目录', expConns['fs-e2']?.folderId === 'fs-dir:生产环境/华东')
check('导出树：根目录下的连接挂到根', expConns['fs-e1']?.folderId === null)
check('导出树：失效的 parent_id 被忽略', expConns['fs-e2']?.folderId !== 'fs-1xfv06i5syufcy73')
check('导出树：连接照常导入', exp.connections === 2, `got ${exp.connections}`)

/* ---------------- install shape regression: folder.json still wins ---------------- */

check('安装目录：folder.json 的名字优先于目录名', foldersById['fs-folderA']?.name === '生产环境')
check('安装目录：parent_id 命中时不走路径推断', byId['fs-c3']?.folderId === 'fs-folderB')

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\nIMPORT TEST PASS' : `\nIMPORT TEST FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
