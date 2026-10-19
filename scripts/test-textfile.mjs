/**
 * Unit check for the "is this editable text?" gate, which decides whether a file
 * opens in the built-in editor or gets pushed off to a local program.
 *
 *   node scripts/test-textfile.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-textfile-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundle = join(work, 'textfile.mjs')
await build({
  entryPoints: ['src/main/textfile.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { looksLikeText, decodeText, MAX_TEXT_BYTES } = await import(
  `file://${bundle.replaceAll('\\', '/')}`
)

const ok = (name, buf, size) => looksLikeText(name, buf, size ?? buf.length).ok
const why = (name, buf, size) => {
  const r = looksLikeText(name, buf, size ?? buf.length)
  return r.ok ? '(allowed)' : r.reason
}

/* ---------------- text passes ---------------- */
const shell = Buffer.from('#!/bin/bash\nset -euo pipefail\necho "hi"\n')
check('普通脚本文件放行', ok('deploy.sh', shell))
check('无扩展名的文件也放行', ok('Makefile', Buffer.from('all:\n\tgcc -o x x.c\n')))
check('点开头的隐藏文件放行', ok('.bashrc', shell))
check('CRLF 与中文放行', ok('readme.txt', Buffer.from('# 标题\r\n内容\r\n')))
check('带 ANSI 颜色的日志放行', ok('app.log', Buffer.from('\x1b[32mOK\x1b[0m done\n')))
check('空文件放行', ok('empty.conf', Buffer.alloc(0)))

/* ---------------- archives and binaries refused ---------------- */
const zipMagic = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64, 0x41)])
check('.zip 按扩展名拒绝', !ok('backup.zip', zipMagic), why('backup.zip', zipMagic))
check('.tar.gz 看最后一段', !ok('logs.tar.gz', shell), why('logs.tar.gz', shell))
check('.png 拒绝', !ok('shot.png', Buffer.from('\x89PNG\r\n\x1a\n')))
check('大写扩展名一样拒绝', !ok('DATA.ZIP', Buffer.alloc(4)), why('DATA.ZIP', Buffer.alloc(4)))
check('.jar 拒绝', !ok('app.jar', Buffer.from('PK\x03\x04\x00\x00')))

/* ---------------- content sniffing ---------------- */
check('有 0 字节就拒绝（即使扩展名是 .txt）', !ok('weird.txt', Buffer.from('abc\x00def')), why('weird.txt', Buffer.from('abc\x00def')))
const noisy = Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 3) + 1))
// Named .txt on purpose: only the content rule may reject this one.
check('控制字符成片出现就拒绝', !ok('mangled.txt', noisy), why('mangled.txt', noisy))

/* ---------------- size gate ---------------- */
check('超过上限按大小拒绝', !ok('huge.log', Buffer.from('x'), MAX_TEXT_BYTES + 1), why('huge.log', Buffer.from('x'), MAX_TEXT_BYTES + 1))
check('刚好等于上限放行', ok('big.log', Buffer.from('x'), MAX_TEXT_BYTES))

/* ---------------- utf-8 validity ---------------- */
const decoded = decodeText(Buffer.from('中文 ok\n', 'utf8'))
check('合法 UTF-8 解出文本', 'text' in decoded && decoded.text.includes('中文'))
const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // "中文" in GBK
check('非法 UTF-8 被拒绝', !('text' in decodeText(gbk)), 'reason' in decodeText(gbk) ? decodeText(gbk).reason : '')
check('0 字节在解码阶段也拦一次', !('text' in decodeText(Buffer.from('a\x00b'))))

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\nTEXTFILE TEST PASS' : `\nTEXTFILE TEST FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
