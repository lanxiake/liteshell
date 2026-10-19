/**
 * Command-name completion.
 *
 * The shell can complete for us but only once we press Tab, and only against
 * its own PATH; the popup needs an answer while the user is still typing. So:
 * a small dictionary of everyday commands (with a one-line Chinese hint) merged
 * with this connection's own history, which always wins — whatever you actually
 * ran on this box beats a generic list. Once the command name is settled the
 * dictionary is swapped for that command's own follow-ups (SUBCOMMANDS).
 *
 * Pure data + one matcher, no DOM: `scripts/test-commands.mjs` covers it.
 */

export interface Suggestion {
  /** The whole line that gets written back to the terminal. */
  cmd: string
  /** One-line Chinese description; dictionary entries only. */
  hint?: string
}

/** Ordered by "how likely is this what you meant" — matches are taken in order. */
const COMMON: [string, string][] = [
  ['ls', '列目录'],
  ['cd', '切换目录'],
  ['cat', '查看文件'],
  ['tail', '看文件末尾，常用 -f 跟踪日志'],
  ['grep', '按内容搜索文本'],
  ['ps', '查看进程'],
  ['top', '实时进程与负载'],
  ['systemctl', '管理 systemd 服务'],
  ['journalctl', '查看 systemd 日志'],
  ['df', '磁盘使用率'],
  ['du', '目录占用统计'],
  ['free', '内存使用'],
  ['tar', '打包解包'],
  ['curl', '发 HTTP 请求'],
  ['docker', '容器管理'],
  ['git', '版本控制'],
  ['vim', '编辑文件'],
  ['less', '分页查看'],
  ['head', '看文件开头'],
  ['find', '按条件找文件'],
  ['sed', '流式替换文本'],
  ['awk', '按列处理文本'],
  ['sort', '排序'],
  ['uniq', '去重'],
  ['wc', '统计行数字数'],
  ['lsblk', '列出块设备'],
  ['lsof', '查看端口/文件占用'],
  ['ss', '查看网络连接'],
  ['netstat', '网络连接与端口'],
  ['ping', '测试连通性'],
  ['nvidia-smi', '查看 GPU 状态'],
  ['iptables', '防火墙规则'],
  ['chmod', '改权限'],
  ['chown', '改属主'],
  ['cp', '复制'],
  ['mv', '移动或改名'],
  ['rm', '删除'],
  ['mkdir', '新建目录'],
  ['touch', '新建空文件/更新时间'],
  ['ln', '建链接'],
  ['pwd', '当前路径'],
  ['echo', '输出文本'],
  ['export', '设置环境变量'],
  ['source', '在当前 shell 执行脚本'],
  ['env', '查看环境变量'],
  ['which', '命令的绝对路径'],
  ['whereis', '命令相关的文件'],
  ['man', '查看手册'],
  ['history', '历史命令'],
  ['crontab', '定时任务'],
  ['date', '当前时间'],
  ['uptime', '开机时长与负载'],
  ['who', '当前登录用户'],
  ['whoami', '当前用户名'],
  ['id', '用户与组信息'],
  ['uname', '内核信息'],
  ['hostname', '主机名'],
  ['kill', '按 PID 结束进程'],
  ['pkill', '按名字结束进程'],
  ['killall', '结束同名进程'],
  ['nohup', '后台常驻运行'],
  ['watch', '定时重复执行'],
  ['screen', '会话保持'],
  ['tmux', '终端复用'],
  ['crontab -l', '列出定时任务'],
  ['rsync', '增量同步文件'],
  ['scp', '远程复制'],
  ['ssh', '登录另一台机器'],
  ['ssh-keygen', '生成密钥对'],
  ['wget', '下载文件'],
  ['unzip', '解压 zip'],
  ['gzip', '压缩/解压 gz'],
  ['zip', '打包 zip'],
  ['uname -a', '完整系统信息'],
  ['lscpu', 'CPU 信息'],
  ['lsusb', 'USB 设备'],
  ['lspci', 'PCI 设备'],
  ['dmesg', '内核日志'],
  ['vmstat', '系统整体状态'],
  ['iostat', '磁盘 IO 统计'],
  ['iptables -L', '列出防火墙规则'],
  ['redis-cli', '连接 Redis'],
  ['mysql', '连接 MySQL'],
  ['nginx', 'Nginx 服务'],
  ['make', '编译构建'],
  ['gcc', '编译 C'],
  ['python3', '运行 Python'],
  ['node', '运行 Node'],
  ['npm', 'Node 包管理'],
  ['pip', 'Python 包管理'],
  ['java', '运行 Java'],
  ['mvn', 'Maven 构建'],
  ['go', 'Go 工具链'],
  ['kubectl', 'Kubernetes 集群'],
  ['pm2', 'Node 进程管理'],
  ['supervisorctl', '管理 supervisord 进程'],
  ['service', '服务管理（旧版）'],
  ['apt', 'Debian 系包管理'],
  ['yum', 'RedHat 系包管理'],
  ['dnf', 'Fedora 系包管理'],
  ['firewall-cmd', 'firewalld 规则'],
  ['sysctl', '内核参数'],
  ['mount', '挂载'],
  ['umount', '卸载'],
  ['blkid', '块设备 UUID'],
  ['fdisk', '磁盘分区'],
  ['reboot', '重启机器'],
  ['shutdown', '关机'],
  ['sudo', '以 root 执行'],
  ['su', '切换用户'],
  ['passwd', '改密码'],
  ['useradd', '新建用户'],
  ['diff', '比较两个文件'],
  ['md5sum', '算 MD5'],
  ['sha256sum', '算 SHA256'],
  ['base64', 'base64 编解码'],
  ['tree', '树状列目录'],
  ['stat', '文件元信息'],
  ['file', '识别文件类型'],
  ['type', '命令是内建还是外部'],
  ['alias', '查看或定义别名'],
  ['history -c', '清空历史']
]

/* ------------------------------------------------------------------ *
 * command palette
 * ------------------------------------------------------------------ */

export interface CommandEntry {
  /** Heading in the palette; entries are kept grouped so headings never repeat. */
  group: string
  cmd: string
  hint: string
}

/**
 * Ready-to-run one-liners for the job you are actually doing. Unlike COMMON
 * above (bare names, for completion) these carry their arguments — a palette
 * entry you have to finish typing is half a feature. Placeholders are concrete
 * examples meant to be edited, not blank slots.
 */
export const PALETTE: CommandEntry[] = [
  // --- 系统信息 ---
  { group: '系统信息', cmd: 'uname -a', hint: '内核版本与架构' },
  { group: '系统信息', cmd: 'cat /etc/os-release', hint: '发行版与版本号' },
  { group: '系统信息', cmd: 'hostnamectl', hint: '主机名与系统摘要' },
  { group: '系统信息', cmd: 'uptime', hint: '开机时长与平均负载' },
  { group: '系统信息', cmd: 'lscpu | head -20', hint: 'CPU 型号、核心数与主频' },
  { group: '系统信息', cmd: 'timedatectl', hint: '时间、时区与 NTP 同步状态' },
  { group: '系统信息', cmd: 'who -a', hint: '当前登录的会话' },
  { group: '系统信息', cmd: 'last -n 10', hint: '最近 10 次登录记录' },
  { group: '系统信息', cmd: 'dmesg -T | tail -30', hint: '最近的带时间的内核消息' },

  // --- 用户 / 权限 ---
  { group: '用户 / 权限', cmd: 'id', hint: '当前用户的 UID、GID 与附加组' },
  { group: '用户 / 权限', cmd: 'getent passwd | cut -d: -f1,3,7', hint: '所有账号及其 UID 与登录 shell' },
  { group: '用户 / 权限', cmd: 'awk -F: \'$3>=1000 && $3<65534 {print $1}\' /etc/passwd', hint: '人类用户列表（UID 1000 起）' },
  { group: '用户 / 权限', cmd: 'sudo -l -U deploy', hint: '查看某个用户能 sudo 执行什么' },
  { group: '用户 / 权限', cmd: 'usermod -aG docker $USER', hint: '把当前用户加进 docker 组（重新登录生效）' },
  { group: '用户 / 权限', cmd: 'groups deploy', hint: '某个用户属于哪些组' },
  { group: '用户 / 权限', cmd: 'chown -R app:app /data/app', hint: '递归改属主与属组' },
  { group: '用户 / 权限', cmd: 'chmod -R u+rwX,go-rwx /data/app', hint: '递归收紧权限（X 只作用于目录）' },
  { group: '用户 / 权限', cmd: 'passwd -S root', hint: '密码状态：P 正常、L 已锁定' },
  { group: '用户 / 权限', cmd: 'umask', hint: '新建文件的默认权限掩码' },

  // --- CPU / 内存 ---
  { group: 'CPU / 内存', cmd: 'top -b -n1 | head -20', hint: '一次性的进程快照，按 CPU 排序' },
  { group: 'CPU / 内存', cmd: 'ps aux --sort=-%cpu | head -10', hint: 'CPU 占用前十' },
  { group: 'CPU / 内存', cmd: 'ps aux --sort=-%mem | head -10', hint: '内存占用前十' },
  { group: 'CPU / 内存', cmd: 'free -h', hint: '内存与 Swap 用量' },
  { group: 'CPU / 内存', cmd: 'vmstat 1 5', hint: '每秒一行，看 CPU 等待和换页' },
  { group: 'CPU / 内存', cmd: 'mpstat -P ALL 1 3', hint: '每个核心的使用率（需 sysstat）' },
  { group: 'CPU / 内存', cmd: 'pidstat -u 1 3', hint: '按进程看 CPU（需 sysstat）' },
  { group: 'CPU / 内存', cmd: 'cat /proc/loadavg', hint: '负载与正在运行的任务数' },

  // --- 磁盘 / IO ---
  { group: '磁盘 / IO', cmd: 'df -hT', hint: '各文件系统用量与类型' },
  { group: '磁盘 / IO', cmd: 'du -sh * | sort -rh | head -20', hint: '当前目录下谁最占地方' },
  { group: '磁盘 / IO', cmd: 'du -h --max-depth=1 /var | sort -rh | head', hint: '指定目录的一级占用' },
  { group: '磁盘 / IO', cmd: 'lsblk -f', hint: '块设备、文件系统与 UUID' },
  { group: '磁盘 / IO', cmd: 'iostat -x 1 3', hint: '磁盘 IO 详情与饱和度（需 sysstat）' },
  { group: '磁盘 / IO', cmd: 'iotop -oP', hint: '哪个进程在读写磁盘（需 iotop）' },
  { group: '磁盘 / IO', cmd: 'find / -xdev -type f -size +500M 2>/dev/null', hint: '找出大于 500MB 的文件' },
  { group: '磁盘 / IO', cmd: 'lsof +L1 | head', hint: '已删除但没释放空间的文件（磁盘满的经典原因）' },
  { group: '磁盘 / IO', cmd: 'mount | column -t', hint: '当前挂载点' },

  // --- 系统调优 ---
  { group: '系统调优', cmd: 'sysctl -a | grep -E "somaxconn|tcp_max_syn|file-max"', hint: '几个最容易成为瓶颈的内核参数' },
  { group: '系统调优', cmd: 'sysctl -w net.core.somaxconn=1024', hint: '临时调大连接队列（重启即失效）' },
  { group: '系统调优', cmd: 'ulimit -n', hint: '当前会话的文件句柄上限' },
  { group: '系统调优', cmd: 'cat /proc/sys/net/ipv4/ip_local_port_range', hint: '可用本地端口范围，TIME_WAIT 多时关键' },
  { group: '系统调优', cmd: 'sysctl vm.swappiness', hint: '换页倾向，数据库机器通常调到 1~10' },
  { group: '系统调优', cmd: 'swapon --show', hint: '当前启用的 swap 设备' },
  { group: '系统调优', cmd: 'cat /proc/sys/kernel/pid_max', hint: 'PID 上限，长期运行的机器要注意' },
  { group: '系统调优', cmd: 'cat /sys/block/sda/queue/scheduler', hint: 'IO 调度器（NVMe 上一般是 none）' },
  { group: '系统调优', cmd: 'cat /proc/sys/net/core/rmem_max', hint: '接收缓冲区上限，高吞吐网络要调' },

  // --- 进程 / 服务 ---
  { group: '进程 / 服务', cmd: 'ps -eo pid,ppid,etime,cmd --sort=-etime | head', hint: '运行时间最长的进程' },
  { group: '进程 / 服务', cmd: 'systemctl list-units --failed', hint: '启动失败的服务' },
  { group: '进程 / 服务', cmd: 'systemctl status nginx -l --no-pager', hint: '某个服务的详细状态' },
  { group: '进程 / 服务', cmd: 'systemctl restart nginx', hint: '重启服务' },
  { group: '进程 / 服务', cmd: 'systemctl daemon-reload', hint: '改完 unit 文件后重载' },
  { group: '进程 / 服务', cmd: 'journalctl -u nginx -n 200 --no-pager', hint: '某服务最近 200 行日志' },
  { group: '进程 / 服务', cmd: 'pkill -f java', hint: '按命令行关键字结束进程（先确认再按回车）' },
  { group: '进程 / 服务', cmd: 'pgrep -af java', hint: '按关键字找进程，带完整命令行' },

  // --- JVM / 运行时排查 ---
  { group: 'JVM / 运行时排查', cmd: 'jps -lvm', hint: '本机所有 JVM 进程及其启动参数' },
  { group: 'JVM / 运行时排查', cmd: 'jstack $(pgrep -f java | head -1) > stack.txt', hint: '抓线程栈，卡死和死锁都看它' },
  { group: 'JVM / 运行时排查', cmd: 'jmap -heap $(pgrep -f java | head -1)', hint: '堆内存分区概况' },
  { group: 'JVM / 运行时排查', cmd: 'jstat -gcutil $(pgrep -f java | head -1) 1000 10', hint: '每秒一次 GC 统计，看是否频繁 Full GC' },
  { group: 'JVM / 运行时排查', cmd: 'jcmd $(pgrep -f java | head -1) GC.heap_info', hint: '各分区实占与容量' },
  { group: 'JVM / 运行时排查', cmd: 'jinfo -flags $(pgrep -f java | head -1)', hint: '生效的 JVM 参数' },
  { group: 'JVM / 运行时排查', cmd: 'py-spy top --pid $(pgrep -f python | head -1)', hint: 'Python 实时占用排行（需 py-spy）' },
  { group: 'JVM / 运行时排查', cmd: 'py-spy dump --pid $(pgrep -f python | head -1)', hint: 'Python 线程调用栈快照（需 py-spy）' },
  { group: 'JVM / 运行时排查', cmd: 'python3 -m http.server 8000', hint: '当前目录起个临时静态服务' },
  { group: 'JVM / 运行时排查', cmd: 'node --inspect=0.0.0.0:9229 app.js', hint: '带调试端口启动 Node' },

  // --- 网络 ---
  { group: '网络', cmd: 'ss -tunlp', hint: '监听中的端口与对应进程' },
  { group: '网络', cmd: 'ss -s', hint: '连接数总览' },
  { group: '网络', cmd: 'ip -br a', hint: '网卡与地址（简洁版）' },
  { group: '网络', cmd: 'ip route', hint: '路由表' },
  { group: '网络', cmd: 'curl -I https://example.com', hint: '只看响应头' },
  { group: '网络', cmd: "curl -o /dev/null -s -w '%{http_code} %{time_total}s\\n' https://example.com", hint: '测响应码与总耗时' },
  { group: '网络', cmd: 'ping -c 4 8.8.8.8', hint: '连通性与丢包' },
  { group: '网络', cmd: 'mtr -rwzc 10 8.8.8.8', hint: '每一跳的丢包与延迟（需 mtr）' },
  { group: '网络', cmd: 'iftop -i eth0', hint: '实时流量按连接拆分（需 iftop）' },
  { group: '网络', cmd: 'nload', hint: '实时进出带宽（需 nload）' },
  { group: '网络', cmd: 'tcpdump -i any -nn port 80 -c 20', hint: '抓 20 个包看看' },
  { group: '网络', cmd: 'dig +short example.com', hint: 'DNS 解析结果' },
  { group: '网络', cmd: 'ethtool eth0', hint: '网卡速率与链路状态' },
  { group: '网络', cmd: 'nc -zv 10.0.0.1 3306', hint: '测某个端口通不通' },

  // --- SSH ---
  { group: 'SSH', cmd: 'ssh -i ~/.ssh/id_rsa -p 22 user@host', hint: '指定私钥与端口登录' },
  { group: 'SSH', cmd: 'ssh -v user@host', hint: '带调试日志登录，连不上时看这个' },
  { group: 'SSH', cmd: 'ssh -L 8080:127.0.0.1:80 user@host', hint: '本地端口转发：本机 8080 → 对端能访问的 80' },
  { group: 'SSH', cmd: 'ssh -N -f -L 3306:127.0.0.1:3306 user@host', hint: '后台常驻的端口转发' },
  { group: 'SSH', cmd: 'ssh -R 9000:127.0.0.1:3000 user@host', hint: '反向转发：把本机服务暴露到对端' },
  { group: 'SSH', cmd: 'ssh-add -l', hint: '当前 agent 里加载了哪些密钥' },
  { group: 'SSH', cmd: 'ssh-keyscan -t ed25519 host >> ~/.ssh/known_hosts', hint: '提前记录主机指纹，脚本里免交互' },
  { group: 'SSH', cmd: 'ssh -o ConnectTimeout=5 -o BatchMode=yes user@host true', hint: '非交互探测能不能连上' },

  // --- 日志 ---
  { group: '日志', cmd: 'journalctl -xe --no-pager | tail -50', hint: '最近的错误与解释' },
  { group: '日志', cmd: "journalctl --since '1 hour ago' -p err", hint: '一小时内的错误级别日志' },
  { group: '日志', cmd: 'journalctl -b -p err', hint: '本次启动以来的错误' },
  { group: '日志', cmd: 'journalctl -u nginx -f', hint: '跟踪某个服务的日志' },
  { group: '日志', cmd: 'tail -f /var/log/nginx/access.log', hint: '实时访问日志' },
  { group: '日志', cmd: 'tail -n 200 /var/log/syslog', hint: '系统日志（RHEL 上是 messages）' },
  { group: '日志', cmd: 'grep -i error /var/log/nginx/error.log | tail -50', hint: '过滤出错误行' },
  { group: '日志', cmd: 'less +F app.log', hint: '跟 tail -f 一样，但随时能停下来翻' },

  // --- 文件 ---
  { group: '文件', cmd: 'ls -alh --time-style=long-iso', hint: '长列表：大小、时间、权限' },
  { group: '文件', cmd: 'find . -type f -mtime -1', hint: '一天内改动过的文件' },
  { group: '文件', cmd: 'find . -type f -name "*.log" -mtime +7 -delete', hint: '清理 7 天前的日志（先去掉 -delete 跑一遍）' },
  { group: '文件', cmd: 'grep -rn "Timeout" /etc/nginx', hint: '递归搜文件内容' },
  { group: '文件', cmd: "sed -i.bak 's/old/new/g' file.conf", hint: '就地替换，.bak 留底' },
  { group: '文件', cmd: 'tar -czf backup.tar.gz -C /var/www .', hint: '打包压缩一个目录' },
  { group: '文件', cmd: 'tar -xzf backup.tar.gz -C /tmp', hint: '解包到指定目录' },
  { group: '文件', cmd: 'rsync -avz --progress ./ user@host:/data/', hint: '增量同步，带进度' },
  { group: '文件', cmd: 'scp -r ./dir user@host:/data/', hint: '递归拷贝到远端' },
  { group: '文件', cmd: 'sha256sum file.tar.gz', hint: '校验文件完整性' },
  { group: '文件', cmd: 'stat -c "%s %y %n" file', hint: '文件大小、修改时间与路径' },
  { group: '文件', cmd: 'chmod 600 ~/.ssh/id_rsa', hint: '私钥权限不对时 ssh 会拒绝使用' },

  // --- 文本处理 ---
  { group: '文本处理', cmd: "grep -rn 'keyword' --include='*.conf' .", hint: '只搜某种类型的文件' },
  { group: '文本处理', cmd: "grep -c 'error' app.log", hint: '统计匹配的行数' },
  { group: '文本处理', cmd: "grep -v '^#' nginx.conf", hint: '去掉注释行，看清配置本来的样子' },
  { group: '文本处理', cmd: "grep -A 3 -B 3 'error' app.log", hint: '连上下文一起看' },
  { group: '文本处理', cmd: "sed -n '100,200p' app.log", hint: '只看第 100 到 200 行' },
  { group: '文本处理', cmd: "sed -i.bak '/^$/d' file", hint: '删掉空行并留一份 .bak' },
  { group: '文本处理', cmd: "awk '{print $1}' access.log | sort | uniq -c | sort -rn | head", hint: '按第一列统计出现次数排行' },
  { group: '文本处理', cmd: "awk -F: '{print $1}' /etc/passwd", hint: '按冒号分列取第一列' },
  { group: '文本处理', cmd: 'cut -d, -f1,3 data.csv', hint: '取 CSV 的第 1、3 列' },
  { group: '文本处理', cmd: "tr -d '\\r' < win.txt > unix.txt", hint: '去掉 Windows 换行符' },

  // --- Docker ---
  { group: 'Docker', cmd: "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'", hint: '容器一览' },
  { group: 'Docker', cmd: 'docker stats --no-stream', hint: '一次资源占用快照' },
  { group: 'Docker', cmd: 'docker logs -f --tail 200 $(docker ps -lq)', hint: '跟踪最近创建的容器日志' },
  { group: 'Docker', cmd: 'docker exec -it $(docker ps -lq) sh', hint: '进入最近的容器' },
  { group: 'Docker', cmd: 'docker system df', hint: '镜像、容器、卷各占多少' },
  { group: 'Docker', cmd: 'docker system prune -af', hint: '清理未使用的镜像与缓存（不可恢复）' },
  { group: 'Docker', cmd: 'docker compose ps', hint: 'compose 服务状态' },
  { group: 'Docker', cmd: 'docker compose logs -f --tail 100', hint: '跟踪 compose 全部日志' },
  { group: 'Docker', cmd: 'docker inspect -f "{{.State.Status}} {{.RestartCount}}" $(docker ps -lq)', hint: '状态与重启次数' },

  // --- 容器运行时 ---
  { group: '容器运行时', cmd: 'crictl ps -a', hint: 'containerd 下面的容器（K8s 节点常用）' },
  { group: '容器运行时', cmd: 'crictl pods', hint: '节点上的静态 Pod' },
  { group: '容器运行时', cmd: 'crictl logs --tail 100 $(crictl ps -q | head -1)', hint: '容器的日志' },
  { group: '容器运行时', cmd: 'nerdctl ps -a', hint: 'containerd 的 docker 风格命令行' },
  { group: '容器运行时', cmd: 'ctr -n k8s.io containers list', hint: 'k8s.io 命名空间下的容器' },
  { group: '容器运行时', cmd: 'systemctl status containerd -l --no-pager', hint: '运行时自身是否健康' },
  { group: '容器运行时', cmd: 'journalctl -u docker -n 100 --no-pager', hint: 'Docker 守护进程最近日志' },

  // --- Kubernetes ---
  { group: 'Kubernetes', cmd: 'kubectl get pods -A -o wide', hint: '所有 Pod 及其所在节点' },
  { group: 'Kubernetes', cmd: 'kubectl get pods -A --field-selector=status.phase!=Running', hint: '不正常的 Pod' },
  { group: 'Kubernetes', cmd: 'kubectl get nodes -o wide', hint: '节点状态与版本' },
  { group: 'Kubernetes', cmd: 'kubectl top pods -A', hint: 'Pod 资源占用（需 metrics-server）' },
  { group: 'Kubernetes', cmd: 'kubectl get events -A --sort-by=.lastTimestamp | tail -30', hint: '最近的集群事件' },
  { group: 'Kubernetes', cmd: 'kubectl logs -f deploy/app --tail=200', hint: '跟应用日志' },
  { group: 'Kubernetes', cmd: 'kubectl logs --previous deploy/app --tail=100', hint: '看崩溃前那个容器的日志' },
  { group: 'Kubernetes', cmd: 'kubectl exec -it deploy/app -- sh', hint: '进容器' },
  { group: 'Kubernetes', cmd: 'kubectl rollout restart deploy/app', hint: '滚动重启' },
  { group: 'Kubernetes', cmd: 'kubectl rollout status deploy/app', hint: '滚动更新进度' },
  { group: 'Kubernetes', cmd: 'kubectl describe pod app-0', hint: 'Pod 详情，排障先看事件那一节' },

  // --- Helm ---
  { group: 'Helm', cmd: 'helm list -A', hint: '所有 release 与状态' },
  { group: 'Helm', cmd: 'helm history app -n default', hint: '某个 release 的发布历史' },
  { group: 'Helm', cmd: 'helm rollback app 3 -n default', hint: '回滚到第 3 个版本' },
  { group: 'Helm', cmd: 'helm get values app -n default', hint: '当前实际生效的 values' },
  { group: 'Helm', cmd: 'helm upgrade --install app ./chart -n default', hint: '装或升级，一条命令覆盖两种情况' },
  { group: 'Helm', cmd: 'helm diff upgrade app ./chart -n default', hint: '先看改动了什么（需 helm-diff 插件）' },

  // --- Nginx ---
  { group: 'Nginx', cmd: 'nginx -t', hint: '检查配置语法' },
  { group: 'Nginx', cmd: 'nginx -T | less', hint: '查看生效的完整配置（含 include）' },
  { group: 'Nginx', cmd: 'nginx -s reload', hint: '平滑重载配置' },
  { group: 'Nginx', cmd: "awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -20", hint: '访问最多的 IP' },
  { group: 'Nginx', cmd: "awk '{print $7}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -20", hint: '访问最多的 URL' },
  { group: 'Nginx', cmd: "grep -c ' 500 ' /var/log/nginx/access.log", hint: '统计 500 的条数' },
  { group: 'Nginx', cmd: 'tail -f /var/log/nginx/error.log', hint: '实时错误日志' },

  // --- MySQL / Redis ---
  { group: 'MySQL / Redis', cmd: "mysql -uroot -p -e 'show processlist'", hint: '当前连接与正在执行的语句' },
  { group: 'MySQL / Redis', cmd: 'mysqladmin -uroot -p status', hint: '一次运行状态与 QPS' },
  { group: 'MySQL / Redis', cmd: 'mysqladmin -uroot -p processlist', hint: '连接清单' },
  { group: 'MySQL / Redis', cmd: "mysql -uroot -p -e 'show engine innodb status\\G'", hint: 'InnoDB 状态与锁等待' },
  { group: 'MySQL / Redis', cmd: 'mysqldump -uroot -p --single-transaction db > db.sql', hint: '不锁表地逻辑备份' },
  { group: 'MySQL / Redis', cmd: 'redis-cli info memory', hint: 'Redis 内存占用与碎片率' },
  { group: 'MySQL / Redis', cmd: 'redis-cli --bigkeys', hint: '找出大的 key（扫全库，别在高峰期跑）' },
  { group: 'MySQL / Redis', cmd: 'redis-cli info stats | grep -E "keyspace|hit|miss"', hint: '命中率相关统计' },

  // --- 性能 / 压测 ---
  { group: '性能 / 压测', cmd: 'ab -n 1000 -c 100 http://127.0.0.1/', hint: 'ApacheBench：1000 请求 / 100 并发' },
  { group: '性能 / 压测', cmd: 'wrk -t4 -c100 -d30s http://127.0.0.1/', hint: 'wrk 压 30 秒（需 wrk）' },
  { group: '性能 / 压测', cmd: 'stress-ng --cpu 4 --timeout 60s', hint: '压 4 个核 60 秒（需 stress-ng）' },
  { group: '性能 / 压测', cmd: 'sysbench cpu --threads=4 run', hint: 'CPU 基准测试（需 sysbench）' },
  { group: '性能 / 压测', cmd: 'iperf3 -c 10.0.0.2', hint: '测两台机器之间的带宽（需 iperf3）' },

  // --- GPU ---
  { group: 'GPU', cmd: 'nvidia-smi', hint: 'GPU 使用率、显存与进程' },
  { group: 'GPU', cmd: 'watch -n1 nvidia-smi', hint: '每秒刷新一次' },
  { group: 'GPU', cmd: 'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv', hint: '关键指标表格' },
  { group: 'GPU', cmd: 'nvidia-smi -q -d MEMORY', hint: '显存细节' },

  // --- 安全 / 审计 ---
  { group: '安全 / 审计', cmd: 'ss -tunlp | grep LISTEN', hint: '只看监听端口，确认没多开服务' },
  { group: '安全 / 审计', cmd: 'lastb -n 20', hint: '失败的登录尝试（需 root）' },
  { group: '安全 / 审计', cmd: "grep 'Failed password' /var/log/secure | tail -20", hint: '密码爆破痕迹（Debian 上是 auth.log）' },
  { group: '安全 / 审计', cmd: 'find / -xdev -perm -4000 -type f 2>/dev/null', hint: '找 SUID 程序，排查提权面' },
  { group: '安全 / 审计', cmd: 'cat ~/.ssh/authorized_keys', hint: '已授权登录的公钥' },
  { group: '安全 / 审计', cmd: 'firewall-cmd --list-all', hint: 'firewalld 生效规则' },
  { group: '安全 / 审计', cmd: 'ufw status verbose', hint: 'Ubuntu 防火墙规则' },
  { group: '安全 / 审计', cmd: 'iptables -L -n --line-numbers', hint: 'iptables 规则（带序号便于删除）' },
  { group: '安全 / 审计', cmd: 'chage -l root', hint: '账号密码有效期' },
  { group: '安全 / 审计', cmd: 'awk -F: \'$3==0 {print $1}\' /etc/passwd', hint: '列出所有 UID 为 0 的账号' },

  // --- 备份 / 恢复 ---
  { group: '备份 / 恢复', cmd: 'tar -czf /backup/etc-$(date +%F).tar.gz /etc', hint: '带日期的配置备份' },
  { group: '备份 / 恢复', cmd: 'mysqldump -uroot -p --all-databases > all.sql', hint: '全库备份' },
  { group: '备份 / 恢复', cmd: 'rsync -avz --delete /data/ backup@host:/data/', hint: '镜像同步（--delete 会删掉对端多余文件）' },
  { group: '备份 / 恢复', cmd: 'cp -a /etc/nginx /etc/nginx.bak', hint: '改配置前先整体复制一份' },
  { group: '备份 / 恢复', cmd: 'dd if=/dev/sda of=/backup/mbr.bin bs=512 count=1', hint: '备份引导扇区' },
  { group: '备份 / 恢复', cmd: 'find /backup -mtime +30 -delete', hint: '清理 30 天前的备份' },
  { group: '备份 / 恢复', cmd: 'zstd -T0 -19 data.sql -o data.sql.zst', hint: '多核高压缩比备份（需 zstd）' },

  // --- 日志轮转 ---
  { group: '日志轮转', cmd: 'du -sh /var/log', hint: '日志总共占了多少' },
  { group: '日志轮转', cmd: 'journalctl --disk-usage', hint: 'systemd journal 占了多少' },
  { group: '日志轮转', cmd: 'journalctl --vacuum-size=500M', hint: '把 journal 压到 500MB 以内' },
  { group: '日志轮转', cmd: 'logrotate -d /etc/logrotate.conf', hint: '干跑一遍，看会不会出问题' },
  { group: '日志轮转', cmd: 'logrotate -f /etc/logrotate.d/nginx', hint: '立刻强制轮转（磁盘要满了用）' },
  { group: '日志轮转', cmd: 'cat /etc/logrotate.d/nginx', hint: '某个服务的轮转策略' },

  // --- 定时任务 ---
  { group: '定时任务', cmd: 'crontab -l', hint: '当前用户的计划任务' },
  { group: '定时任务', cmd: 'systemctl list-timers', hint: 'systemd 定时任务与下次触发时间' },
  { group: '定时任务', cmd: 'atq', hint: '待执行的 at 任务' },

  // --- 证书 / 密钥 ---
  { group: '证书 / 密钥', cmd: 'openssl x509 -in cert.pem -noout -dates -subject', hint: '证书有效期与主体' },
  { group: '证书 / 密钥', cmd: 'openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null | openssl x509 -noout -dates', hint: '线上证书什么时候过期' },
  { group: '证书 / 密钥', cmd: 'ssh-keygen -l -f ~/.ssh/id_rsa.pub', hint: '公钥指纹' },
  { group: '证书 / 密钥', cmd: 'ssh-keygen -y -f ~/.ssh/id_rsa > id_rsa.pub', hint: '从私钥还原公钥' },

  // --- 软件包 ---
  { group: '软件包', cmd: 'apt list --upgradable', hint: '可升级的包（Debian / Ubuntu）' },
  { group: '软件包', cmd: 'yum check-update', hint: '可升级的包（RHEL / CentOS）' },
  { group: '软件包', cmd: 'rpm -qa --last | head -20', hint: '最近安装的包' }
]

/**
 * All words must appear somewhere in the entry, so "磁盘 排序" narrows rather
 * than widens. Empty query returns the whole list — the palette's default view.
 */
export function searchCommands(query: string): CommandEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return PALETTE
  return PALETTE.filter((e) => {
    const hay = `${e.group}\n${e.cmd}\n${e.hint}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Description for a line the user kept, whether it came from the palette or not. */
export function hintFor(cmd: string): string | undefined {
  return PALETTE.find((e) => e.cmd === cmd)?.hint
}

/**
 * Follow-ups for a command whose name is already settled. COMMON gets you to
 * `systemctl `; this is what makes the next word worth completing too. Entries
 * are whole lines — a verb that does not exist is worse than no suggestion, so
 * these are checked against the real tool. A trailing space means "carry on
 * typing, the argument goes here".
 */
const SUBCOMMANDS: Record<string, [string, string][]> = {
  systemctl: [
    ['status ', '看服务状态，服务名跟在后面'],
    ['restart ', '重启服务'],
    ['reload ', '只重读配置，不断开连接'],
    ['start ', '启动'],
    ['stop ', '停止'],
    ['enable --now ', '设为开机自启并立刻启动'],
    ['list-units --failed', '哪些服务起挂了'],
    ['status -l --no-pager ', '长输出不分页'],
    ['daemon-reload', '改完 unit 文件后重载']
  ],
  journalctl: [
    ['-u nginx -f', '跟踪某个服务的日志'],
    ['-u nginx -n 200 --no-pager', '最近 200 行'],
    ['-xe --no-pager', '最近的错误及解释'],
    ["--since '1 hour ago'", '按时间范围看'],
    ['-b -p err', '本次启动以来的错误'],
    ['--disk-usage', 'journal 占了多少磁盘'],
    ['--vacuum-time=7d', '只保留 7 天']
  ],
  docker: [
    ['ps -a', '所有容器'],
    ['logs -f --tail 200 ', '跟踪容器日志（跟容器名）'],
    ['exec -it ', '进容器（跟容器名 sh）'],
    ['images', '本地镜像'],
    ['stats --no-stream', '一次资源占用快照'],
    ['inspect ', '容器详情 JSON'],
    ['system df', '镜像与卷各占多少'],
    ['compose ps', 'compose 服务状态'],
    ['compose logs -f --tail 100', '跟踪 compose 全部日志'],
    ['compose up -d', '后台拉起 compose'],
    ['compose restart ', '重启某个服务']
  ],
  kubectl: [
    ['get pods -A -o wide', '所有 Pod 及所在节点'],
    ['get pods -A --field-selector=status.phase!=Running', '不正常的 Pod'],
    ['get nodes -o wide', '节点状态与版本'],
    ['get events -A --sort-by=.lastTimestamp | tail -30', '最近的集群事件'],
    ['top pods -A', 'Pod 资源占用'],
    ['logs -f deploy/app --tail=200', '跟应用日志（改 deploy/app）'],
    ['exec -it deploy/app -- sh', '进容器'],
    ['describe pod app-0', 'Pod 详情，先看 Events'],
    ['rollout restart deploy/app', '滚动重启'],
    ['rollout status deploy/app', '滚动更新进度'],
    ['apply -f deploy.yaml', '应用清单'],
    ['delete pod app-0', '删 Pod 触发重建']
  ],
  git: [
    ['status', '工作区状态'],
    ['diff', '未暂存的改动'],
    ['diff --staged', '已暂存的改动'],
    ['log --oneline --graph -20', '紧凑的历史图'],
    ['add -A', '暂存全部改动'],
    ["commit -m ''", '提交，引号里写说明'],
    ['push', '推到远端'],
    ['pull --rebase', '拉取并变基，历史更干净'],
    ['stash', '暂存当前改动'],
    ['stash pop', '把暂存的改回来'],
    ['switch -c feature/x', '新建并切到分支'],
    ['branch -a', '本地与远端分支'],
    ['remote -v', '远端地址'],
    ['restore .', '丢弃工作区改动'],
    ['reset --hard HEAD', '丢弃全部未提交改动']
  ],
  apt: [
    ['update', '刷新包索引'],
    ['upgrade', '升级已安装的包'],
    ['install ', '安装，跟包名'],
    ['remove --purge ', '卸载并清掉配置'],
    ['list --upgradable', '可升级的包'],
    ['autoremove', '清理不再需要的依赖'],
    ['search ', '搜索包'],
    ['show ', '包的详情与依赖']
  ],
  yum: [
    ['check-update', '可升级的包'],
    ['update', '升级'],
    ['install ', '安装，跟包名'],
    ['remove ', '卸载'],
    ['search ', '搜索包'],
    ['info ', '包的详情'],
    ['clean all', '清空缓存']
  ],
  tar: [
    ['-czf backup.tar.gz ', '打包压缩，跟要打包的目录'],
    ['-xzf ', '解压 .tar.gz'],
    ['-tzf ', '只看压缩包里有啥，不解开'],
    ['-czf backup.tar.gz --exclude=.git .', '排除 .git 打包'],
    ['-xzf x.tar.gz -C /tmp', '解到指定目录'],
    ['-cJf backup.tar.xz ', '用 xz 压，体积最小'],
    ['-cjf backup.tar.bz2 ', '用 bzip2 压']
  ],
  find: [
    ['. -type f -name "*.log"', '按名字找文件'],
    ['. -type d -name node_modules', '按名字找目录'],
    ['. -type f -mtime -1', '一天内改动过的'],
    ['. -type f -size +100M', '大于 100MB 的文件'],
    ['/var -type f -mtime +30 -delete', '清理 30 天前的文件'],
    ['. -perm -4000 -type f', 'SUID 程序'],
    ['. -type f -exec grep -l "keyword" {} +', '在找到的文件里搜内容']
  ],
  grep: [
    ["-rn 'keyword' .", '递归搜索并显示行号'],
    ["-i -n 'error' app.log", '忽略大小写'],
    ["-v '^#' nginx.conf", '反向匹配，去掉注释行'],
    ["-A 3 -B 3 'error' app.log", '带前后三行上下文'],
    ["-c 'error' app.log", '只数匹配行数'],
    ['-E "a|b" file', '扩展正则，用 | 并列'],
    ["-l 'keyword' *.log", '只列文件名']
  ],
  sed: [
    ["-n '100,200p' app.log", '打印指定行区间'],
    ["-i.bak 's/old/new/g' file", '就地替换并留一份备份'],
    ["'/^$/d' file", '删掉空行'],
    ["'/^#/d' file", '删掉注释行'],
    ["'s/\\t/ /g' file", '把制表符换成空格']
  ],
  awk: [
    ["'{print $1}' file", '打印第一列'],
    ["-F: '{print $1}' /etc/passwd", '指定分隔符'],
    ["'{print $NF}' file", '打印最后一列'],
    ["'$3 > 100 {print $0}' file", '按条件过滤'],
    ["'{sum+=$5} END {print sum}' file", '把第五列求和'],
    ["'NR==10' file", '只看第 10 行']
  ],
  ps: [
    ['aux', 'BSD 风格的全量进程'],
    ['-ef', 'System V 风格的全量进程'],
    ['aux --sort=-%mem | head', '按内存排序'],
    ['-eo pid,ppid,etime,cmd', '只挑关心的列'],
    ['-ef | grep java', '按关键字找进程']
  ],
  ls: [
    ['-alh', '长列表，大小好读'],
    ['-alh --time-style=long-iso', '时间格式规整的长列表'],
    ['-lt', '按修改时间排序'],
    ['-lhS', '按大小排序'],
    ['-alh /var/log', '看指定目录']
  ],
  df: [
    ['-h', '人类可读的用量'],
    ['-hT', '带文件系统类型'],
    ['-i', 'inode 用量，磁盘没满却写不进去时看它'],
    ['-h /var', '只看某个目录所在的分区'],
    ['--total', '末尾给一行总计']
  ],
  du: [
    ['-sh *', '当前目录下每项的总占用'],
    ['-sh .', '当前目录总占用'],
    ['-h --max-depth=1', '只看一层'],
    ['-sh * | sort -rh | head', '占用排行前几']
  ],
  ss: [
    ['-tunlp', '监听的端口与对应进程'],
    ['-s', '连接数总览'],
    ['-tnp', '已建立的连接与进程'],
    ['-tan state established | wc -l', '统计并发连接数'],
    ['-tunlp | grep :80', '谁占了 80 端口']
  ],
  ip: [
    ['-br a', '所有网卡与地址，简洁'],
    ['-s link', '网卡收发与错误统计'],
    ['route', '路由表'],
    ['link', '链路层状态'],
    ['neigh', 'ARP 邻居表']
  ],
  curl: [
    ['-I ', '只看响应头'],
    ['-L -s -o /dev/null -w "%{http_code} %{time_total}s\\n" ', '测响应码与总耗时'],
    ["-X POST -H 'Content-Type: application/json' -d '{}' ", '发一个 JSON POST'],
    ['-k ', '跳过证书校验，自签证书调试用'],
    ['-O ', '下载到当前目录'],
    ['--resolve example.com:443:10.0.0.1 ', '不改 DNS，直接指定解析结果']
  ],
  ssh: [
    ['-i ~/.ssh/id_rsa ', '指定私钥'],
    ['-p 2222 ', '指定端口'],
    ['-L 8080:127.0.0.1:80 ', '本地端口转发'],
    ['-N -f -L 3306:127.0.0.1:3306 ', '后台常驻转发'],
    ['-v ', '调试日志，连不上时看它'],
    ['-o ConnectTimeout=5 -o BatchMode=yes ', '非交互探测能不能连上']
  ],
  scp: [
    ['-r ./dir user@host:/data/', '递归上传目录'],
    ['user@host:/data/file ./', '下载到当前目录'],
    ['-P 2222 ', '指定端口，注意是大写 P'],
    ['-C user@host:/big.tar.gz .', '传输时顺便压缩']
  ],
  rsync: [
    ['-avz --progress ./ user@host:/data/', '增量同步并显示进度'],
    ['-avz --delete ./ user@host:/data/', '镜像同步，对端多余文件会删掉'],
    ['-avz --exclude=.git --exclude=node_modules ./ user@host:/data/', '排除目录同步'],
    ['-avz --dry-run ./ user@host:/data/', '先空跑一遍看会动哪些文件'],
    ['-avz --bwlimit=2m ./ user@host:/data/', '限速 2MB/s']
  ],
  dig: [
    ['+short example.com', '只要解析结果'],
    ['@8.8.8.8 example.com', '指定 DNS 服务器'],
    ['+trace example.com', '跟着递归看每一跳'],
    ['-x 8.8.8.8', '反查 PTR'],
    ['ANY example.com', '要所有记录类型']
  ],
  lsof: [
    ['-i:80', '谁占着 80 端口'],
    ['-i -P -n', '所有网络文件与进程'],
    ['-p $(pgrep -f java | head -1)', '某个进程打开了哪些文件'],
    ['+L1', '已删除但仍被占用的文件'],
    ['-u root', '某个用户打开的文件'],
    ['-c nginx', '某个进程名打开的文件']
  ],
  tcpdump: [
    ['-i any -nn port 80 -c 20', '抓 20 个包'],
    ['-i eth0 -w cap.pcap', '存到文件里慢慢看'],
    ['-nn host 10.0.0.1', '只看某台主机'],
    ['-nn -A port 80', '按 ASCII 显示内容'],
    ['-i any -nn icmp', '只看 ICMP']
  ],
  nginx: [
    ['-t', '检查配置语法'],
    ['-T', '打印生效的完整配置'],
    ['-s reload', '平滑重载'],
    ['-s stop', '停止'],
    ['-V', '编译参数，看装了哪些模块']
  ],
  mysql: [
    ['-uroot -p', '用 root 连接，会提示输密码'],
    ['-uroot -p -e ', '直接执行一条语句'],
    ['-h 10.0.0.1 -uroot -p', '连远程实例'],
    ['-uroot -p db < backup.sql', '把备份导回库里，先建好库'],
    ['-uroot -p -e "show processlist"', '当前连接与正在执行的语句'],
    ['-uroot -p --default-character-set=utf8mb4', '指定字符集，避免中文乱码']
  ],
  'redis-cli': [
    ['ping', '看还活着没'],
    ['info', '全部运行信息'],
    ['info memory', '内存占用与碎片率'],
    ['--bigkeys', '扫出大 key，别在高峰期跑'],
    ['dbsize', '当前库有多少 key'],
    ['-h 10.0.0.1 -p 6379', '连远程实例'],
    ['slowlog get 10', '最近 10 条慢查询']
  ],
  npm: [
    ['run build', '跑构建脚本'],
    ['run dev', '起开发服务'],
    ['install', '按 package.json 装依赖'],
    ['ci', '严格按 lock 文件干净安装'],
    ['ls -g --depth=0', '全局装了什么'],
    ['view react version', '查远端的包版本']
  ],
  pm2: [
    ['list', '进程清单与重启次数'],
    ['logs --lines 200 ', '看某个应用的日志'],
    ['restart all', '全量重启'],
    ['reload all', '零停机重载'],
    ['monit', '实时面板'],
    ['save', '存下进程列表，开机自启靠它']
  ],
  supervisorctl: [
    ['status', '所有进程的状态'],
    ['restart all', '全量重启'],
    ['tail -f ', '跟踪某个进程的日志'],
    ['update', '重读配置并热加载'],
    ['reread', '只重读配置，不重启']
  ],
  'firewall-cmd': [
    ['--list-all', '当前生效的规则'],
    ['--reload', '重载配置'],
    ['--add-port=8080/tcp --permanent', '永久放行端口，记得 reload'],
    ['--remove-port=8080/tcp --permanent', '撤掉放行'],
    ['--add-service=https --permanent', '放行预定义服务']
  ]
}

/**
 * @param line    what is currently on the terminal prompt
 * @param history this connection's commands, oldest first
 * @returns at most `limit` entries, history first — never including `line` itself
 */
export function suggest(line: string, history: string[], limit: number): Suggestion[] {
  const prefix = line.trimStart()
  // Nothing typed, nothing to complete; don't pop a menu at an empty prompt.
  if (!prefix || limit <= 0) return []

  const out: Suggestion[] = []
  const seen = new Set([prefix])
  // Newest first: the command you ran five minutes ago beats the one from Tuesday.
  for (const cmd of [...history].reverse()) {
    if (out.length >= limit) break
    if (seen.has(cmd) || !cmd.startsWith(prefix)) continue
    seen.add(cmd)
    out.push({ cmd })
  }

  const space = prefix.indexOf(' ')
  if (space > 0) {
    // The name is settled — a bare dictionary name here would wipe what's typed.
    // Whatever comes next belongs to that command, so offer its own follow-ups.
    const head = prefix.slice(0, space)
    for (const [sub, hint] of SUBCOMMANDS[head] ?? []) {
      if (out.length >= limit) break
      const cmd = `${head} ${sub}`
      if (seen.has(cmd) || !cmd.startsWith(prefix)) continue
      seen.add(cmd)
      out.push({ cmd, hint })
    }
    return out
  }

  for (const [cmd, hint] of COMMON) {
    if (out.length >= limit) break
    if (seen.has(cmd) || !cmd.startsWith(prefix)) continue
    seen.add(cmd)
    out.push({ cmd, hint })
  }
  return out
}
