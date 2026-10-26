/**
 * Writes `<installer>.sha256` next to every installer in release/, in the same
 * "hash  filename" shape the release page serves. The in-app updater checks it
 * before running anything it downloaded; without it, a download is trusted
 * purely because it came over TLS from a URL the API named.
 *
 *   node scripts/make-sha256.mjs
 */
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'release'
const installers = readdirSync(dir).filter((n) => /\.(exe|dmg|AppImage|deb)$/i.test(n))

for (const name of installers) {
  const file = join(dir, name)
  const hash = createHash('sha256')
  await new Promise((resolve, reject) =>
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  )
  const digest = hash.digest('hex')
  writeFileSync(`${file}.sha256`, `${digest}  ${name}\n`)
  console.log(`  ${name}  ${digest.slice(0, 12)}…`)
}
