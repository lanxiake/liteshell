# 开发与构建

[返回 README](../README.md)

## 目录结构

```text
src/
  main/                  Electron 主进程
    index.ts             窗口、托盘、IPC、多窗口会话路由
    ssh.ts               SSH / SFTP 会话（ssh2）
    store.ts             配置持久化、备份导入导出
    vault.ts             凭据加密（系统钥匙串 / AES-GCM 回退）
    sealed.ts            备份文件的口令加密
    monitor.ts           资源监控采集与解析
    finalshell.ts        FinalShell 导入器
    textfile.ts          编辑器准入规则
    agent.ts             AI 助手
    agent-providers.ts   Anthropic / OpenAI 兼容接口
    gate.ts              AI 命令审批闸门（正则分类器）
    cli-server.ts        本地 socket，给 agent 的 CLI 用
  preload/
    index.ts             contextBridge 暴露的 API
  renderer/
    index.html
    src/
      main.ts            界面逻辑（标签、面板、对话框、主题）
      commands.ts        命令面板与补全词典
      alerts.ts          监控阈值表
      style.css
  shared/
    types.ts             主进程与渲染进程共用的类型
scripts/                 冒烟测试与单元测试
skills/liteshell/        agent 技能包（CLI → 主进程 socket）
build/                   打包资源（应用图标）
docs/                    文档
```

## 开发

```bash
npm install
npm run dev          # 热重载开发
npm run typecheck
npm run icon         # 重新画 build/icon.png（改了配色再跑）
```

## 测试

```bash
npm run smoke          # 端到端冒烟测试（拉起本地 SSH 服务端 + CDP 驱动真实窗口）
npm run test:import    # FinalShell 导入器的单元测试（造一棵合成目录树）
npm run test:monitor   # 资源监控解析器的单元测试（喂一份真实格式的抓取结果）
npm run test:textfile  # 编辑器准入规则的单测（放行哪些、拦下哪些）
npm run test:commands  # 命令补全匹配的单测（历史优先、去重、整行不覆盖）
npm run test:alerts    # 监控阈值规则的单测（谁该报、谁该静默、排序）
npm run test:gate      # 审批闸门的单测（哪些 exec 免确认、哪些标红）
npm run test:sealed    # 备份口令加密的单测（错口令/被改过都要打不开）
npm run test:backup    # 导出/导入往返的单测（密码跟不跟着口令走、模型配置落没落地）
```

`smoke` 会占用调试端口 9333；本机同时开着的 dev 实例如果也用这个端口，会被冒烟脚本连上。

## 打包

```bash
npm run dist:win       # NSIS 安装包 (x64；arm64 加 --arm64 单独跑)
npm run dist:mac       # dmg (x64 / arm64)
npm run dist:linux     # AppImage + deb（要在 Linux 上跑）
npm run dist:linux-tar # tar.xz 便携包（任何平台都能出）
```

产物在 `release/`。

**为什么 Linux 包要在 Linux 上打**：deb 走 `fpm`、AppImage 走 `mksquashfs`，两个都是 Linux 可执行文件，
Windows/macOS 上直接 ENOENT；AppImage 还要建一堆符号链接，Windows 没开开发者模式会 EPERM。
在 Linux（或 Docker、CI）上 `npm run dist:linux` 一次出全。只想先要一个能在 Ubuntu 上跑起来的东西，
`npm run dist:linux-tar` 在任何平台都能出：解包后 `./liteshell` 直接跑。

**国内网络**：Electron 的二进制包从 GitHub 拉，连不上时会 `connect ETIMEDOUT`。加镜像即可：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist:win
```

**`EPERM ... rename 'release\win-unpacked.tmp' -> 'release\win-unpacked'`**：这是把刚解出来的
368 MB Electron 目录改名的动作被拦，通常是杀软/终端安全客户端正在扫描那些新文件（本机是 H3C iNode），
不是代码问题——同一条命令手敲 `mv` 是能过的。绕法是别让它重新解压，拿一份已经解好的 Electron 当模板
（`-c.electronDist` 走的是目录拷贝，没有那次改名）：

```bash
mv release/win-unpacked.tmp /tmp/electron-dist    # 失败留下的 .tmp 就是解好的 Electron 本身
npx electron-builder --win --publish never -c.electronDist=/tmp/electron-dist
```

### 安装包里有什么

都是实测，LZMA 极限压缩后的数字：

| 占安装包 | 文件 | 压缩前 | 压缩后 |
| --- | --- | --- | --- |
| ~60% | `LiteShell.exe`（Chromium + Node，都在这一个文件里） | 234 MB | **61 MB** |
| ~11% | `resources.pak`（Chromium 资源，本身已压过，压不动） | 11.9 MB | 11.8 MB |
| ~6% | `dxcompiler.dll` + `dxil.dll`（D3D12 着色器编译） | 26 MB | 6.2 MB |
| ~3% | `icudtl.dat`（ICU 数据） | 10.4 MB | 3.2 MB |
| ~4% | `vk_swiftshader` / `ffmpeg` / `d3dcompiler_47` | 12.8 MB | 3.7 MB |
| <1% | **LiteShell 自己**（`app.asar` + locales + 杂项） | ~6 MB | ~3 MB |

结论：**能省的已经省完了**。`electronLanguages` 只留了 `zh-CN`/`en-US`（原生 49MB → 1.2MB），
`compression: maximum` 打开着，`files` 里只有 `out/` 和 `package.json`。
剩下唯一能动的就是那几个 Chromium 自带的 DLL（全删约 8MB，占安装包 8%），代价是在某些
显卡/驱动组合下可能渲染异常——为一个终端工具省 8MB 不值得，所以留着。
`LICENSES.chromium.html` 看着有 20MB，压完只有 0.2MB，删了没意义还少了许可证。

想真正压到 10MB 量级，得换运行时：Tauri（系统 WebView，代价是装 Rust + MSVC 工具链）。

## 配置文件位置

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\liteshell\liteshell.json` |
| macOS | `~/Library/Application Support/liteshell/liteshell.json` |
| Linux | `~/.config/liteshell/liteshell.json` |

密钥材料单独放在同目录的 `vault.key`（权限 0600），仅在系统无钥匙串时才会用到。
