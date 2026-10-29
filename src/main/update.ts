import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, net, shell } from 'electron'
import type { UpdateAsset, UpdateCheck } from '../shared/types'

/** The repository the releases are published from — the same one the app's
 *  package.json points at, so there is one place to change it. */
export const REPO = 'lanxiake/liteshell'
export const RELEASES_URL = `https://github.com/${REPO}/releases`

/** `v0.2.4` and `0.2.4` are the same version; anything after a dash is a
 *  pre-release and sorts below the release it belongs to. */
export function parseVersion(raw: string): number[] {
  const core = raw.trim().replace(/^v/i, '').split('-')[0]
  return core.split('.').map((n) => Number.parseInt(n, 10) || 0)
}

/** True when `candidate` is a later release than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Which download belongs to this machine. A release carries one artifact per
 *  installer; picking the wrong one is how an arm64 build lands on an x64 box
 *  and installs nothing. */
export function pickAsset(
  assets: { name: string; browser_download_url: string; size?: number }[],
  platform: NodeJS.Platform,
  arch: string
): { name: string; url: string; size: number } | null {
  const usable = assets.filter((a) => !/\.(sha256|blockmap|yml|json)$/i.test(a.name))
  const tokens = arch === 'x64' ? ['x64', 'amd64'] : arch === 'arm64' ? ['arm64', 'aarch64'] : [arch]
  const forThisArch = (name: string): boolean => tokens.some((t) => name.includes(t))
  // A file that names a different architecture must never be picked as a
  // fallback: `arm64` contains no `x64`, but `...-setup.exe` with no label at
  // all is this machine's.
  const forAnother = (name: string): boolean => /arm64|aarch64|x64|amd64/.test(name) && !forThisArch(name)
  const pick = (test: (name: string) => boolean): (typeof usable)[number] | undefined => {
    const candidates = usable.filter((a) => test(a.name.toLowerCase()))
    return candidates.find((a) => forThisArch(a.name.toLowerCase())) ?? candidates.find((a) => !forAnother(a.name.toLowerCase()))
  }

  let hit: (typeof usable)[number] | undefined
  if (platform === 'win32') hit = pick((n) => n.endsWith('.exe'))
  else if (platform === 'darwin') hit = pick((n) => n.endsWith('.dmg'))
  else hit = pick((n) => n.endsWith('.appimage'))
  if (!hit) return null
  return { name: hit.name, url: hit.browser_download_url, size: hit.size ?? 0 }
}

/** Why a network call failed, in words the person reading the dialog can act
 *  on. Node's fetch hides everything behind "fetch failed"; the cause carries
 *  the code. */
function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'TimeoutError') return '连接 GitHub 超时'
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err)
}

/**
 * Electron's network stack, not Node's `fetch`: it follows the system proxy.
 * On a machine behind a local proxy (127.0.0.1:10808 and friends) Node's fetch
 * goes direct, and the release-asset host then resets the connection mid-body
 * — which surfaces as a bare `TypeError: fetch failed` after an update was
 * found. The Chromium stack downloads the same file fine.
 */
async function get(url: string, init: RequestInit): Promise<Response> {
  try {
    return await net.fetch(url, init)
  } catch (err) {
    throw new Error(`${describe(err)}（如果这台机器靠代理上网，请确认系统代理已开启）`)
  }
}

/** Asks GitHub for the latest published release. No token: this is a public
 *  repository, and shipping one inside the app would be a credential in a file
 *  anyone can read. */
export async function checkForUpdate(current = app.getVersion()): Promise<UpdateCheck> {
  try {
    const res = await get(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LiteShell-updater' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) {
      // 404 is the honest "nothing published yet", not a network problem.
      return {
        kind: 'error',
        message: res.status === 404 ? '这个仓库还没有发布过版本' : `GitHub 回了 ${res.status}`
      }
    }
    const release = (await res.json()) as {
      tag_name?: string
      name?: string
      body?: string
      assets?: { name: string; browser_download_url: string; size?: number }[]
    }
    const latest = String(release.tag_name ?? '').trim()
    if (!latest) return { kind: 'error', message: '没读到版本号' }
    if (!isNewer(latest, current)) return { kind: 'latest', current, latest }

    const picked = pickAsset(release.assets ?? [], process.platform, process.arch)
    // A `.sha256` beside the installer is what turns "downloaded" into
    // "downloaded the thing that was published".
    const digest = (release.assets ?? []).find((a) => a.name === `${picked?.name}.sha256`)
    return {
      kind: 'available',
      current,
      latest,
      notes: (release.body ?? '').trim().slice(0, 4000),
      asset: picked ? { ...picked, sha256: digest?.browser_download_url } : null
    }
  } catch (err) {
    return { kind: 'error', message: describe(err) }
  }
}

function digestOf(text: string): string {
  return text.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

/**
 * Downloads the installer to a temp directory, checking the release's own
 * `.sha256` when it publishes one. Returns the local path.
 *
 * The file is never written over anything: a fresh directory each time means a
 * half-download cannot be mistaken for a previous run's installer.
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  onProgress: (received: number, total: number) => void
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'liteshell-update-'))
  const target = join(dir, basename(asset.name))

  const res = await get(asset.url, {
    headers: { 'User-Agent': 'LiteShell-updater' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60_000)
  })
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length')) || asset.size
  let received = 0
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress(received, total)
  })
  await pipeline(body, createWriteStream(target))

  if (asset.sha256) {
    const expected = digestOf(await (await get(asset.sha256, { signal: AbortSignal.timeout(15_000) })).text())
    const actual = createHash('sha256').update(await readFile(target)).digest('hex')
    if (expected && expected !== actual) throw new Error('下载的文件和发布方的校验值对不上，已丢弃')
  }
  return target
}

/** Hands the installer to the OS. Windows runs the setup and quits, so it can
 *  replace the files it is currently running from. */
export function installUpdate(path: string): void {
  if (process.platform === 'win32') {
    spawn(path, [], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 400)
    return
  }
  // macOS mounts the image and Linux opens the package; both need the user to
  // finish the install, so the app stays up and says so.
  void shell.openPath(path)
}
