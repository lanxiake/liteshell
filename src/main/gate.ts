/**
 * The one place that decides whether a tool call runs by itself or waits for a
 * person. Pure on purpose — no model output reaches the verdict, so the model
 * can *ask* for things but never grade its own request. A shipped terminal
 * agent ran `dconf reset -f /` and labelled it `is_risky: false`; that is the
 * bug class this file exists to make impossible.
 *
 * Kept out of the main process for the same reason alerts.ts is: it is the
 * security-relevant logic, so it stays testable without Electron
 * (scripts/test-gate.mjs).
 */

/**
 * Tools that only look. They never prompt — every prompt they skip is attention
 * left over for the one that matters, and attention is the scarce resource in
 * this whole design. (Measured elsewhere: people approve 97% of prompts, and
 * detection of the dangerous one drops to ~5% after fifty of them.)
 */
const READ_TOOLS = new Set(['read_output', 'monitor', 'ls', 'cat'])

/**
 * `exec` with a command that only prints, so the model stops spending a prompt
 * on `tail -n 50 app.log`.
 *
 * A whitelist, not "anything that does not look dangerous". The two differ
 * exactly on the command nobody thought of: `systemctl start nginx`,
 * `python -c '…'` and `find . -delete` all read as harmless to a pattern list,
 * and every one of them changes the machine. Here the unknown answer is a
 * prompt, so a gap in the list costs a click, not a server.
 *
 * The shape rule is what makes the list trustworthy: one process, no shell
 * syntax at all. No `|`, `;`, `&&`, redirection, `$(…)` or backticks — those are
 * how a reader becomes a writer, and there is no second half of the line left
 * unread.
 */
const READ_VERBS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'cut', 'sort', 'uniq', 'tr',
  'df', 'du', 'free', 'ps', 'pgrep', 'pidof', 'uptime', 'uname', 'whoami', 'id', 'nproc', 'lscpu',
  'lsmod', 'lsblk', 'stat', 'file', 'readlink', 'realpath', 'basename', 'dirname', 'readelf',
  'md5sum', 'sha1sum', 'sha256sum', 'cksum', 'env', 'printenv', 'echo', 'printf', 'pwd', 'which',
  'type', 'tree', 'lsof', 'ss', 'netstat', 'vmstat', 'iostat', 'mpstat', 'sar', 'dmesg',
  'journalctl', 'nvidia-smi', 'who', 'w', 'last', 'lastlog', 'tty', 'getent', 'dig', 'nslookup',
  'host', 'ping', 'traceroute', 'find'
])

/** Sub-commands that only print, where the verb alone is not the reader:
 *  `systemctl status` is, `systemctl start` is not. Anchored patterns so each
 *  one names its own boundary — nothing gets in on a prefix of a prefix. */
const READ_SUBCOMMANDS: RegExp[] = [
  /^systemctl (status|show|cat|is-|list-)\b/,
  /^docker (ps|logs|inspect|images|stats|top|version|info|port)\b/,
  /^git (status|log|diff|show|blame|describe|rev-parse|ls-files)\b/,
  /^git (stash list|remote -v)\b/,
  /^kubectl (get|describe|logs|top|explain)\b/,
  /^crontab -l\b/,
  /^dpkg (-l|-s)\b/,
  /^rpm -q\b/,
  /^(apt|apt-get) list\b/,
  /^apt-cache\b/,
  /^(yum|dnf) list\b/,
  /^apk info\b/,
  /^pacman -Q\b/,
  /^(pip|pip3|npm) (list|ls|show|view)\b/,
  /^yarn list\b/
]

/** Whole commands that only print, and where any argument at all turns them
 *  into a write: `ip addr` lists the interfaces, `ip addr add …` adds one. */
const READ_EXACT = new Set(['ip a', 'ip addr', 'ip route', 'ip neigh', 'ip link'])

/** One process, nothing attached to it. Quotes and globs are fine; these are
 *  the shapes that mean "there is more to this line". */
const SHELL_SYNTAX = /[;&|<>`$(){}]|\\|\n/

/** Flags that turn a reader into a writer on commands that are otherwise only
 *  ever read from. */
const NOT_READ = /--vacuum|--rotate|-(?:delete|exec|execdir|fprint|fprint0|fls|ok|okdir)(?![\w-])/

/** True when the command is one process that only prints. */
export function readOnly(command: string): boolean {
  const c = command.trim()
  if (!c || SHELL_SYNTAX.test(c) || NOT_READ.test(c)) return false
  if (READ_EXACT.has(c)) return true
  if (READ_SUBCOMMANDS.some((r) => r.test(c))) return true
  return READ_VERBS.has(c.split(/\s+/)[0])
}

export type Risk = 'safe' | 'risky' | 'critical'

/**
 * Shapes that mean "this stopped being a shell command and became a demolition
 * order". A tripwire, not a boundary: it catches the obvious and misses the
 * clever, which is why it only ever colours a prompt that was going to appear
 * anyway. Nothing here may be used to *allow* something.
 */
const CRITICAL: RegExp[] = [
  // Recursive rm aimed at something rooted, home, a glob, or bare . / .. —
  // `rm -rf ./build` is a normal thing to do and must not cry wolf.
  /\brm\s+(?:-\S+\s+)*-\S*[rR]\S*\s+(?:\/|~|\*|\.\.?\/?(?:\s|$))/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^|;]*\bof=\/dev\//,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\b(init|telinit)\s+0\b/,
  /\bchmod\s+(-\w+\s+)*777\s+\//,
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, // :(){ :|:& };:
  /\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?\w*sh\b/,
  />>?\s*\/dev\/(sd|nvme|hd|vd)/,
  />>?\s*\/etc\/(passwd|shadow|sudoers|fstab|crontab)/,
  />>?\s*[^\s]*\.ssh\/authorized_keys/,
  /\bhistory\s+-c\b/,
  /\b(userdel|groupdel)\b/,
  /\bcrontab\s+-r\b/
]

/**
 * Anything that can lose data, change state, or need a shell to be talked into
 * it. `$(`, backticks, `eval` and `sudo` are here because they are how a
 * harmless-looking command stops being one.
 */
const RISKY: RegExp[] = [
  /\brm\b/,
  /\bmv\b/,
  /\bdd\b/,
  /\btruncate\b/,
  /\b(kill|killall|pkill)\b/,
  /\bsystemctl\s+(stop|disable|mask|restart|reload)/,
  /\bservice\s+\S+\s+(stop|restart)/,
  /\bdocker\s+(rm|rmi|stop|kill|prune|down|compose\s+down)/,
  /\bkubectl\s+(delete|drain|cordon|scale|apply|patch)/,
  /\bgit\s+(reset|clean|checkout|push|rebase)/,
  /\b(useradd|usermod|groupadd|chpasswd|passwd)\b/,
  /\b(apt|apt-get|yum|dnf|apk|pacman)\s+\S*(remove|purge|erase|autoremove)/,
  /\bpip\w*\s+uninstall/,
  /\b(npm|pnpm|yarn)\s+(uninstall|publish|ci\s+--production)/,
  /\bchmod\b/,
  /\bchown\b/,
  /\b(insmod|rmmod|modprobe)\b/,
  /\b(mount|umount)\b/,
  /\bmkfs\b/,
  /\btee\b/,
  />>?\s*(?!\/dev\/null\b)[^\s&|]/, // 2>/dev/null is not evidence of anything
  /\bsudo\b/,
  /\bsu\s/,
  /\beval\b/,
  /\bexec\b/,
  /`/,
  /\$\(/,
  /\|\s*(ba|z|k|c|da)?sh\b/
]

export function riskOf(command: string): Risk {
  const c = command.trim()
  if (!c) return 'safe'
  if (CRITICAL.some((r) => r.test(c))) return 'critical'
  if (RISKY.some((r) => r.test(c))) return 'risky'
  return 'safe'
}

export interface Verdict {
  /** True = run it now. False = park the loop on a prompt. */
  auto: boolean
  risk: Risk
  /** Plain-language reason, shown on the card and in the transcript. */
  why: string
}

export function gate(tool: string, command = ''): Verdict {
  if (READ_TOOLS.has(tool)) return { auto: true, risk: 'safe', why: '只读' }
  if (tool === 'exec') {
    const risk = riskOf(command)
    if (risk === 'safe' && readOnly(command)) return { auto: true, risk: 'safe', why: '只读命令' }
    return { auto: false, risk, why: WHY[risk] }
  }
  return { auto: false, risk: 'risky', why: WHY.risky }
}

const WHY: Record<Risk, string> = {
  safe: '会改动服务器',
  risky: '会改动服务器，且有删除/覆盖/提权的痕迹',
  critical: '命中高危模式：这类命令没有撤销'
}
