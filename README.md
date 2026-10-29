# LiteShell

轻量、快速、跨平台的 SSH / SFTP 终端客户端，FinalShell 的开源替代。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#下载)
[![Electron](https://img.shields.io/badge/Electron-44-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)

Electron + TypeScript + xterm.js，没有 JVM、没有 Swing、没有自己手写的 SSH 协议栈。

## 和 FinalShell 的对比

实测 FinalShell 安装目录 190MB（`jre/` 100M + `finalshell.jar` 47M + `ipdata.dat` 27M）。
拆开 jar 看到的实现：

| 层 | FinalShell | LiteShell |
| --- | --- | --- |
| SSH2 协议栈 | **自己实现**，跑在 Netty 3.x 上 | `ssh2`（成熟第三方库，纯 JS） |
| 终端模拟 | jVT220 + JLine jtermios | xterm.js（VS Code 同款） |
| UI | Swing + FlatLaf + SwingX + RSyntaxTextArea + MigLayout | HTML/CSS |
| 凭据加密 | BouncyCastle + 硬编码密钥 | 操作系统钥匙串（DPAPI / Keychain / libsecret） |
| 运行时 | 自带 JRE | 打包的 Node + Chromium |

**磁盘占用不占优势**：Windows 解包 322MB、NSIS 安装包 103MB，Linux 解包 277MB、tar.xz 86MB。
省下来的地方是**启动时间和内存**——没有 JVM 冷启动、不加载 Swing 皮肤，进程常驻内存也低得多。
安装包体积的构成见[开发与构建](docs/development.md#安装包里有什么)。

## 功能

- **连接管理**：文件夹树，密码 / 私钥 / SSH Agent 认证；右键复制 IP、重命名、导出单条连接
- **本机免密登录**：右键连接 →「配置本机免密登录」，自动生成密钥、装上服务器、写好 `~/.ssh/config`，
  之后在本机终端直接 `ssh 服务器IP` 即可；同一个 IP 出现多条连接时自动按 `-a`、`-b` 分名字
- **远程桌面**：连接右键 →「远程桌面 (RDP)…」，经 SSH 隧道打开远程 Ubuntu / Windows 等机器的图形桌面；
  可以弹系统客户端（`mstsc` / FreeRDP / Remmina），也可以**在 LiteShell 自己的窗口里内嵌操作**；
  桌面服务不必对网络开放
- **私钥库**：导入一次，所有连接直接选；加密私钥的口令只输一次，复用它时不再询问
- **多标签终端**：xterm.js，绿点已连接 / 红点已断开；标签可右键复制、重连、断开、**独立窗口**
- **资源监控**：连上标签页就自动打开，CPU / 内存 / Swap / 网络实时曲线，外加 GPU、磁盘、
  最忙的进程和服务器信息；每块都能折起来
- **SFTP 面板**：面包屑跳转、拖拽上传、下载、打包下载、新建、改权限、重命名、删除；
  底部传输清单同时记上传和下载，带进度、可清空
- **内置编辑器**：双击文本文件直接改，`Ctrl+S` 存回服务器；二进制、压缩包、超大文件会被挡下
- **命令面板与补全**：205 条带参数的运维命令，输入时在输入行下方给出候选
- **AI 助手**：用中文让模型查看、操作服务器并**收发文件**；只读命令自动跑，
  **改动和传文件都要你确认**；每条命令和自己的输出折叠在一起，读起来像一份可审计的操作记录
- **备份与迁移**：整份、单条连接或单个文件夹导出，设一个口令就能把密码、私钥口令、API Key 一起带走；
  支持从 FinalShell 导入连接、私钥，并自动解密其中保存的密码
- **安全**：密码经系统钥匙串加密、IPC 只传密文、主机指纹 TOFU 防中间人
- **托盘常驻**：关窗口不退出，会话保留；agent 的 CLI 也通过这个常驻进程工作
- **给别的 AI 客户端用**：设置里一键导出 `SKILL.md` + CLI 技能包，Claude Code / Cline / Cursor
  等客户端就能通过 LiteShell 操作你的服务器，凭据不出客户端

每项功能的细节见[功能详解](docs/features.md)，第一次用请看[使用引导](docs/guide.md)。

## 下载

- **Windows**：从 [Releases](https://github.com/lanxiake/liteshell/releases/latest) 下载
  `LiteShell-<version>-x64-setup.exe`（NSIS 安装包，x64）。
- **macOS / Linux**：目前需要从源码构建，命令见[开发与构建](docs/development.md#打包)。

## 快速开始

```bash
npm install
npm run dev
```

左侧 `+` 新建连接；也可以点侧栏「导入」选一个 FinalShell 目录，把现有连接和私钥搬过来。
第一次连接会记录主机指纹（TOFU），之后指纹变化会被拒绝。

## 文档

| 文档 | 内容 |
| --- | --- |
| [使用引导](docs/guide.md) | **第一次用就从这篇开始**：按顺序走一遍全部功能，十来分钟 |
| [功能详解](docs/features.md) | 监控、文件面板、编辑器、私钥库、命令面板、补全、快捷键、主题、AI 助手 |
| [备份与迁移](docs/backup.md) | 导出/导入、口令规则、单条导出、从 FinalShell 迁移 |
| [给 agent 用（CLI）](docs/agent-cli.md) | 技能包、CLI 命令与输出契约 |
| [安全模型与取舍](docs/security.md) | 凭据如何存储、明文边界、已知限制 |
| [开发与构建](docs/development.md) | 目录结构、测试、打包、配置文件位置 |

## 开发

```bash
npm run typecheck   # TypeScript 类型检查
npm run smoke       # 端到端冒烟测试
npm run dist:win    # 打 Windows 安装包
```

完整的测试与打包说明见[开发与构建](docs/development.md)。

## 安全

LiteShell 处理的是服务器凭据。SSH 密码、API Key 和私钥口令经系统钥匙串加密，渲染进程拿不到明文
（内嵌远程桌面的 RDP 密码是唯一的例外：它要在那个窗口里完成 CredSSP，不保存、关窗即丢弃）；
主机密钥首次记录后变化即拒绝。导出文件里**私钥本身是明文**，请像对待私钥一样保管。
完整说明见[安全模型与已知取舍](docs/security.md)。

## License

[MIT](LICENSE)
