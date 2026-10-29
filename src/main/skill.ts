import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * Hands the agent skill to someone else's AI client.
 *
 * The skill is two files and a socket: a Markdown description of when to use
 * the CLI, the CLI itself, and whatever LiteShell is already running. Nothing
 * in here is generated — the bytes come from `skills/` in this build, so the
 * exported copy is the one the smoke test vouches for.
 */

/** In a packaged app the files sit beside `app.asar` rather than inside it:
 *  `extraResources` in electron-builder.yml is what puts them there. */
const sourceRoot = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'skills', 'liteshell') : join(app.getAppPath(), 'skills', 'liteshell')

const README = `# LiteShell 技能包

这个目录是给 AI 客户端用的：让它通过本机正在运行的 LiteShell 操作你的服务器
（跑命令、看监控、传文件），凭据和连接都留在 LiteShell 里，AI 拿不到密码。

## 装到 Claude Code

把整个 \`liteshell\` 目录放进技能目录，然后重启 Claude Code：

- macOS / Linux：\`~/.claude/skills/liteshell/\`
- Windows：\`%USERPROFILE%\\.claude\\skills\\liteshell\\\`

技能是按名字发现的，目录名要是 \`liteshell\`。

## 装到其他 AI 客户端

**支持「技能 / Skills」目录的客户端**（Cline、Roo Code、Cherry Studio 等）：
把 \`liteshell/\` 放进它约定的技能目录即可，格式与上面相同（\`SKILL.md\` + \`bin/\`）。

**只支持自定义指令 / Rules 的客户端**（Cursor、Windsurf、Codex CLI 等）：
把 \`SKILL.md\` 里去掉了 frontmatter 的正文粘进项目的 rules 文件，并把里面的
\`CLI\` 路径换成这台机器上的绝对路径：

\`\`\`
CLI="<这个目录的绝对路径>/bin/liteshell-cli.mjs"
node "$CLI" conns
\`\`\`

**没有文件注入能力的客户端**：把下面这段贴进对话一次，之后照 \`SKILL.md\` 的表格调用：

> 你可以用本机的 LiteShell 操作我的远程服务器。方式是运行
> \`node <这个目录>/bin/liteshell-cli.mjs <动作> ...\`，stdout 永远是一个 JSON。
> 用 \`conns\` 看有哪些连接，\`exec <连接> <命令>\` 跑命令，\`monitor <连接>\` 看资源，
> \`ls/cat/get/put\` 走文件通道。删除、重启服务、改配置前先问我。

## 前提

- 本机装了 Node.js（18 以上）——CLI 是纯 JS，用 \`node\` 跑。
- **LiteShell 要开着**（窗口收进托盘没关系，退出才不行）。没开时 CLI 返回
  \`app_not_running\`，不会自己去拉起进程。
- CLI 只连本机的 socket，不联网，也没有凭据。

细节见 \`SKILL.md\`。
`

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const src = join(from, name)
    const dst = join(to, name)
    if (statSync(src).isDirectory()) copyDir(src, dst)
    else copyFileSync(src, dst)
  }
}

/**
 * Writes the skill into `<dir>/liteshell/` and returns that path. Overwrites its
 * own files on a second export; touches nothing else in the chosen directory.
 */
export function exportSkill(dir: string): string {
  const from = sourceRoot()
  if (!existsSync(join(from, 'SKILL.md'))) {
    throw new Error(`找不到技能包源文件：${from}`)
  }
  const to = join(dir, 'liteshell')
  mkdirSync(dirname(to), { recursive: true })
  copyDir(from, to)
  writeFileSync(join(to, 'README.md'), README, 'utf8')
  return to
}
