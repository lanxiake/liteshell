/**
 * Decides whether a remote file is something a text editor has any business
 * opening. Pure — no ssh2, no Electron — so it can be unit tested against
 * real buffers.
 */

/** Editors choke well before this, and a 2 MB dialog is already unwieldy. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

/**
 * Formats that are never text, even when the first bytes happen to look calm.
 * Deliberately short: the byte sniff below is the real test, this is just the
 * cheap answer for things we know by name (a .zip whose first chunk is the
 * stub of an empty archive, say).
 */
const BINARY_EXT = new Set([
  // archives
  'zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', 'tar', 'cab',
  // java / native build outputs
  'jar', 'war', 'ear', 'class', 'pyc', 'pyo', 'o', 'a', 'obj', 'so', 'dll', 'dylib',
  // packages and images
  'deb', 'rpm', 'apk', 'ipa', 'dmg', 'iso', 'img', 'exe', 'msi', 'bin', 'dat',
  // documents that are actually containers
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
  // media and fonts
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff', 'psd',
  'mp3', 'mp4', 'avi', 'mkv', 'mov', 'wav', 'flac', 'ogg', 'webm', 'm4a',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // databases
  'db', 'sqlite', 'sqlite3', 'mdb', 'idx'
])

export type TextCheck = { ok: true } | { ok: false; reason: string }

/** `foo.tar.gz` -> `gz`; dotfiles and extensionless names yield ''. */
function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function looksLikeText(name: string, head: Buffer, size = head.length): TextCheck {
  const ext = extensionOf(name)
  if (BINARY_EXT.has(ext)) return { ok: false, reason: `.${ext} 是压缩包或二进制格式，不能当文本编辑` }
  if (size > MAX_TEXT_BYTES) {
    return { ok: false, reason: `文件 ${(size / 1024 / 1024).toFixed(1)} MB，超过编辑器上限 2 MB` }
  }
  // A NUL byte is the one thing text never contains and binaries almost always do.
  if (head.includes(0)) return { ok: false, reason: '内容里有 0 字节，是二进制文件' }

  let control = 0
  for (const byte of head) {
    // Tab, LF, CR, FF, ESC (ANSI colors) are fine; other C0 codes are not.
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12 && byte !== 27) control++
  }
  if (head.length && control / head.length > 0.05) {
    return { ok: false, reason: '内容里控制字符太多，不像文本文件' }
  }
  return { ok: true }
}

/**
 * @returns the decoded text, or why it cannot be edited. Invalid UTF-8 is the
 *          last line of defence — no NUL, no control noise, still not text.
 */
export function decodeText(body: Buffer): { text: string } | { reason: string } {
  if (body.includes(0)) return { reason: '内容里有 0 字节，是二进制文件' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body) }
  } catch {
    return { reason: '不是 UTF-8 文本（可能是 GBK 等其它编码，或二进制）' }
  }
}
