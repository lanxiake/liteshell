/**
 * Unit check for the sealed half of a backup file: passwords go in, only the
 * right passphrase gets them out, and nothing readable is left in the file.
 *
 * The failure that matters is silent: a blob that opens under the wrong
 * passphrase, or one that leaks the plaintext, looks fine in every dialog.
 *
 *   node scripts/test-sealed.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'liteshell-sealed-'))
let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bundle = join(work, 'sealed.mjs')
await build({
  entryPoints: ['src/main/sealed.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { sealSecrets, openSecrets } = await import(`file://${bundle.replaceAll('\\', '/')}`)

const secrets = { connections: { c1: 'hunter2', c2: '私钥口令' }, llmKey: 'sk-live-abc' }

const sealed = sealSecrets(secrets, 'the passphrase')
const opened = openSecrets(sealed, 'the passphrase')
check('同一个口令原样取回', JSON.stringify(opened) === JSON.stringify(secrets), JSON.stringify(opened))

// What the user actually carries around: the whole JSON file, searched by eye
// or by a scanner. None of it may be there.
const file = JSON.stringify(sealed)
check('文件里搜不到明文密码', !file.includes('hunter2'))
check('文件里搜不到 API Key', !file.includes('sk-live-abc'))

for (const wrong of ['', 'The passphrase', 'the passphrase ', '口令']) {
  let threw = false
  try {
    openSecrets(sealed, wrong)
  } catch {
    threw = true
  }
  check(`口令「${wrong}」打不开`, threw)
}

// A flipped byte anywhere in the blob must fail the tag rather than decrypt to
// garbage — that is the difference between "wrong passphrase" and a quiet
// corruption the user never hears about.
const bytes = Buffer.from(sealed.data, 'base64')
bytes[3] ^= 0x01
let tampered = false
try {
  openSecrets({ ...sealed, data: bytes.toString('base64') }, 'the passphrase')
} catch {
  tampered = true
}
check('改过一字节就打不开', tampered)

const again = sealSecrets(secrets, 'the passphrase')
check('同一个口令两次加密结果不同（salt/iv 是随机的）', again.data !== sealed.data && again.iv !== sealed.iv)

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} 项未通过` : '\n全部通过')
process.exit(failures ? 1 : 0)
