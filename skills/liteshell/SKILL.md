---
name: liteshell
description: 通过 LiteShell 终端客户端操作用户的远程服务器——跑命令、看资源、传文件。当用户说「上服务器看看」「帮我查一下 web-1 上的日志」「服务器磁盘满了没」「把构建产物传到服务器上」「这台机器什么配置」时使用。操作的是**用户真实的生产/测试服务器**，`rm`、重启服务这类动作不可撤回。
---

# LiteShell · 远程服务器

你通过一个本地 CLI 驱动用户**自己电脑上开着的 LiteShell**。CLI 里没有一行 SSH 代码：
服务器连接、凭据、已知主机、会话全部活在 LiteShell 主进程里，你只是请它替你跑东西。

**所以 LiteShell 必须开着。** 没开的话 `conns` 会返回 `app_not_running`——这时告诉用户
「先把 LiteShell 打开」，不要自己去拉起进程。

好处是你的每一步都开在 LiteShell 的标签页里，用户能看着你敲、也能随时接管。

## 调用

```bash
CLI="$HOME/.claude/skills/liteshell/bin/liteshell-cli.mjs"
node "$CLI" conns
```

| 动作 | 说明 |
|---|---|
| `conns` | 列出可用连接（名字、主机、用户、认证方式、有没有存密码） |
| `exec <连接> <命令>` | 跑一条命令，拿 stdout/stderr/退出码 |
| `monitor <连接>` | 资源快照：CPU、负载、内存、swap、磁盘、网络、GPU、uptime、系统信息 |
| `ls <连接> [路径]` | 列目录（走 SFTP，不经 shell） |
| `cat <连接> <路径>` | 读文本文件；二进制会被拒 |
| `get <连接> <远端> <本地目录> [--isDir]` | 下载 |
| `put <连接> <本地路径…> <远端目录>` | 上传（最后一个参数是落地目录） |
| `rm <连接> <路径> [--isDir]` | 删除（`--isDir` 递归） |
| `mv <连接> <源> <目标>` / `mkdir <连接> <路径>` | 移动 / 建目录 |
| `close <连接>` | 断开这条连接 |

`--timeout 秒`（默认 120）只对 `exec` 有意义。
命令里带 `--xxx` 时整条加引号最稳；引号麻烦就 `echo '命令' | node "$CLI" exec <连接> --stdin`。

## 输出契约

**stdout 永远是一个 JSON 对象**，退出码 0 = `ok:true`，1 = `ok:false`。

```json
{"ok":true,"stdout":"...","stderr":"...","code":0,"ms":123,"truncated":false}
```

**远端退出码是数据，不是失败。** `code:1` 配 `ok:true` 表示命令跑了、它自己失败了——
去看 `stderr`，别把它当成工具坏了。`ok:false` 只表示**压根没跑成**：

| error_code | 该怎么办 |
|---|---|
| `app_not_running` | LiteShell 没开。请用户打开，别自己拉进程 |
| `bad_token` | LiteShell 刚重启过，原样重试一次 |
| `unknown_connection` | 名字不对。结果里带 `connections`，先 `conns` 核对 |
| `ambiguous_connection` | 重名。用结果里 `candidates` 的 id，或问用户是哪台 |
| `needs_password` | 这台机器密码没存。**让用户在 LiteShell 界面里手动连一次并保存密码**，你没法代输 |
| `needs_key` | 这条连接说用密钥，但没指私钥文件（FinalShell 导入的常见情况）。让用户在界面上编辑它、从私钥库选一把 |
| `host_key_changed` | 主机密钥和记录不符，**已拒绝连接**。这是安全拦截，不要绕过；请用户人工确认这台机器是不是换了密钥 |
| `connect_failed` | 连不上（网络/凭据）。让用户在界面上手动连一次，能看到完整握手日志 |
| `timeout` | 命令没跑完，通道已掐断。**别重发**——远端可能还在跑。`partial_stdout` 是半截输出，不是结果 |
| `sftp_error` | 路径不存在或权限不够 |
| `binary_file` | 不是文本。用 `get` 下到本地 |
| `bad_args` | 参数不对，按 `suggestion` 改 |

`truncated:true` 说明输出被截到 20 万字符了，你要的不是完整的。

## 纪律

1. **不可撤回的动作先问用户**：`rm`、重启/停止服务、改配置文件、动数据库、防火墙规则、
   包管理器的安装卸载。先说要做什么、在哪台机器上，等用户点头。读操作（`ls`/`cat`/`monitor`/
   只读的 `exec`）随便做。
2. **别把大文件灌进上下文**：`cat` 一个几 GB 的日志会毁掉整轮对话。用
   `exec <连接> 'tail -n 200 /var/log/x'`，先看大小再决定。
3. **先 `conns` 再动手**。名字报错时不要猜、不要试别的写法，用返回的 `connections` 或问用户。
4. 你做的每一条命令都记在 `%APPDATA%\liteshell\cli-audit.log`（`exec`/`rm`/`put`/`get`/`mv`/`mkdir`），
   用户会看。写到一半被叫停也算。

## 会咬人的地方

- **`exec` 是非交互通道**：没有 pty。`PATH` 和你手动登录时可能不一样，`.bashrc` 里那些
  交互式的东西不生效，`sudo` 会静静挂在密码提示上直到超时。要 sudo 就用 `sudo -n`
  （不行会立刻报错而不是卡住），或者请用户配 NOPASSWD。
- **每次 `exec` 之间没有状态**：`cd /opt/app` 之后再 `exec ls` 还是在 home 目录，环境变量也不留。
  写成 `cd /opt/app && ls` 一次发过去。想要持久 shell 目前没有——那是另一件事。
- **长任务别在前台跑**：`apt install`、`docker build`、数据库导入这些用
  `nohup ... > /tmp/x.log 2>&1 &` 丢后台，然后 `exec 'tail /tmp/x.log'` 看进度。
  超时掐断只是断开通道，不保证远端进程跟着死。
- **`cat` 走 SFTP 不走 shell**，所以 `~`、通配符、`$VAR` 都不展开——要展开就用
  `exec 'cat ~/x'`。
- 连接是按连接名复用的：一次会话在你反复调用之间一直热着。用户在界面上把那个标签页关掉，
  会话就断了，下次调用会自动重连（不报错）。
