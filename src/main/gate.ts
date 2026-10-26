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

/**
 * What actually waits for a person: no-undo on the data side.
 *
 * The rule is "can this lose something", not "does this write". Restarting a
 * service, chmod-ing a file, installing a package and `git push` are all
 * recoverable or reversible, and making people click through them is what
 * trains them to click through the one that is neither — the measured effect
 * is a collapse in noticing, not an increase in safety. Anything that deletes,
 * overwrites or converts storage stays a prompt.
 *
 * `sudo`, `$(…)`, pipes and redirections are not on this list on purpose: they
 * *amplify* a command, and the amplified command is judged on its own text.
 */
const DESTRUCTIVE: RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bshred\b/,
  /\btruncate\b/,
  /\bmv\b/,
  /\bdd\b/,
  /\b(kill|killall|pkill)\b/,
  /\bdocker\s+(rm|rmi|prune|down|compose\s+down|volume\s+rm|system\s+prune)/,
  /\bkubectl\s+(delete|drain|cordon)/,
  /\bgit\s+(reset\s+--hard|clean|push\s+--force|push\s+-f)/,
  /\b(apt|apt-get|yum|dnf|apk|pacman)\s+\S*(remove|purge|erase|autoremove)/,
  /\bpip\w*\s+uninstall/,
  /\b(npm|pnpm|yarn)\s+uninstall/,
  /\b(vgremove|lvremove|pvremove|swapoff)\b/,
  /\b(crontab|at)\s+-(r|d)\b/,
  />>?\s*(?!\/dev\/null\b)[^\s&|]/, // 2>/dev/null is not evidence of anything
  /\btee\b/
]

export interface Verdict {
  /** True = run it now. False = park the loop on a prompt. */
  auto: boolean
  risk: Risk
  /** Plain-language reason, shown on the card and in the transcript. */
  why: string
}

export function gate(tool: string, command = ''): Verdict {
  if (READ_TOOLS.has(tool)) return { auto: true, risk: 'safe', why: '只读' }
  // An empty command is a model mistake, not a safe one: it is shown as a card
  // so the person sees that nothing was proposed.
  if (!command.trim()) return { auto: false, risk: 'safe', why: '空命令' }
  const risk = riskOf(command)
  if (risk === 'critical') return { auto: false, risk, why: WHY.critical }
  if (DESTRUCTIVE.some((r) => r.test(command))) return { auto: false, risk, why: WHY.data }
  return { auto: true, risk, why: risk === 'safe' ? WHY.safe : WHY.changes }
}

const WHY: Record<'safe' | 'changes' | 'data' | 'critical', string> = {
  safe: '只读命令',
  changes: '改了服务器，但可以改回来',
  data: '会删除或覆盖数据，这一步退不回来',
  critical: '命中高危模式：这类命令没有撤销'
}
