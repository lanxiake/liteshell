# 给 agent 用（CLI）

[返回 README](../README.md)

`skills/liteshell/` 是一个技能包（`SKILL.md` + `bin/liteshell-cli.mjs`），复制到客户端的技能目录
（Claude Code 是 `~/.claude/skills/`）就能让 agent 用上这台终端：

```bash
cp -r skills/liteshell ~/.claude/skills/
```

CLI 里没有一行 SSH 代码——它通过本机 socket 把活交给**正在运行的** LiteShell 主进程去做。
凭据、已知主机、连接复用全走界面里那一套，agent 的每一步都开在真实标签页里，你能看着，也能随时接管。

```bash
node ~/.claude/skills/liteshell/bin/liteshell-cli.mjs conns                    # 有哪些连接（不含密码）
node ~/.claude/skills/liteshell/bin/liteshell-cli.mjs exec 开发环境 'df -h'     # 跑命令，拿 stdout/stderr/退出码
node ~/.claude/skills/liteshell/bin/liteshell-cli.mjs monitor 开发环境          # 结构化资源快照
node ~/.claude/skills/liteshell/bin/liteshell-cli.mjs put 开发环境 ./dist /opt/app
```

## 输出契约

stdout 永远是一个 JSON 对象。**远端退出码是数据，不是失败**：命令跑起来了就是 `ok:true`，
`code` 才是它的退出状态；`ok:false` 只表示压根没跑成（`app_not_running` / `needs_password` /
`needs_key` / `host_key_changed` / `timeout` …），每种都带 `suggestion` 说明下一步。

```json
{"ok":true,"stdout":"...","stderr":"...","code":0,"ms":123,"truncated":false}
```

agent 跑过的每条命令追加到 `%APPDATA%\liteshell\cli-audit.log`。

## 运行前提

LiteShell 必须开着；没开时 CLI 回 `app_not_running`，它不会自己去拉进程。
窗口关掉只是把它收进**系统托盘**（右键托盘图标 → 退出才是真的退出），
所以把窗口收起来不影响 agent，它下次调用照样连得上。

协议的两端分别在 `src/main/cli-server.ts` 和 `skills/liteshell/bin/liteshell-cli.mjs`——
仓库里的 `skills/liteshell/` 是源，改了要重新复制到技能目录（`npm run smoke` 会检查两边是否一致）。
