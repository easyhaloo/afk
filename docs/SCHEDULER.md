# AFK Scheduler - 自动获取 Issue 并编码验证

## 概述

`scheduler.sh` 是一个后台调度器，自动监控 GitLab issues，当发现满足条件的 issue 时自动触发 `afk-implement` 进行编码和验证。

## 功能特性

### 1. 自动 Issue 发现
- 定期轮询 GitLab API（默认 60s 间隔）
- 查找标签为 `stage::ready-for-implement` 的 issues
- 自动检查前置条件

### 2. 前置条件验证
在触发实现前，自动检查：
- ✅ AC section 存在 (`## Acceptance Criteria`)
- ✅ Base label 存在 (`base::prd-<N>` 或 `base::direct`)
- ✅ 无 open blockers（检查 `blocks-<iid>` label）

### 3. 并发控制
- 限制同时运行的 sessions 数量（默认 3 个）
- 避免系统资源耗尽
- 自动排队等待

### 4. 日志记录
- 所有活动记录到 `~/.claude/logs/afk/scheduler-YYYYMMDD.log`
- 每个 issue 的详细日志：`issue-<iid>.log`

## 使用方法

### 基本用法

```bash
# 使用默认配置运行
./scripts/scheduler.sh

# 指定项目和轮询间隔
./scripts/scheduler.sh --project mygroup/myproject --interval 120

# 试运行（只检查，不实际触发）
./scripts/scheduler.sh --dry-run

# 自定义并发数
./scripts/scheduler.sh --max-concurrent 5
```

### 环境变量

```bash
# 设置默认项目
export AFK_PROJECT="mygroup/myproject"

# 设置轮询间隔（秒）
export AFK_POLL_INTERVAL=120

# 设置最大并发数
export AFK_MAX_CONCURRENT=5

# 运行 scheduler
./scripts/scheduler.sh
```

### Git 配置

```bash
# 在项目中设置默认 project
cd /path/to/project
git config afk.project "mygroup/myproject"

# Scheduler 会自动读取
./scripts/scheduler.sh
```

## 作为系统服务运行

### macOS (launchd)

创建 `~/Library/LaunchAgents/com.afk.scheduler.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.afk.scheduler</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.claude/skills/afk-implement/scripts/scheduler.sh</string>
        <string>--interval</string>
        <string>60</string>
    </array>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>AFK_PROJECT</key>
        <string>mygroup/myproject</string>
        <key>AFK_MAX_CONCURRENT</key>
        <string>3</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.claude/logs/afk/scheduler-stdout.log</string>
    
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.claude/logs/afk/scheduler-stderr.log</string>
</dict>
</plist>
```

加载服务：

```bash
# 替换 YOUR_USERNAME
sed -i '' "s/YOUR_USERNAME/$(whoami)/g" ~/Library/LaunchAgents/com.afk.scheduler.plist

# 加载服务
launchctl load ~/Library/LaunchAgents/com.afk.scheduler.plist

# 查看状态
launchctl list | grep afk

# 停止服务
launchctl unload ~/Library/LaunchAgents/com.afk.scheduler.plist
```

### Linux (systemd)

创建 `/etc/systemd/system/afk-scheduler.service`:

```ini
[Unit]
Description=AFK Auto-Implement Scheduler
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/.claude/skills/afk-implement
ExecStart=/home/YOUR_USERNAME/.claude/skills/afk-implement/scripts/scheduler.sh --interval 60
Environment="AFK_PROJECT=mygroup/myproject"
Environment="AFK_MAX_CONCURRENT=3"
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
Restart=always
RestartSec=10

StandardOutput=append:/home/YOUR_USERNAME/.claude/logs/afk/scheduler-stdout.log
StandardError=append:/home/YOUR_USERNAME/.claude/logs/afk/scheduler-stderr.log

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
# 重载配置
sudo systemctl daemon-reload

# 启动服务
sudo systemctl start afk-scheduler

# 开机自启
sudo systemctl enable afk-scheduler

# 查看状态
sudo systemctl status afk-scheduler

# 查看日志
sudo journalctl -u afk-scheduler -f
```

## 工作流程

```
┌─────────────────────────────────────────────────────────┐
│                    Scheduler Loop                       │
└─────────────────────────────────────────────────────────┘
                          │
                          ↓
          ┌───────────────────────────────┐
          │  Poll GitLab for ready issues │
          │  (stage::ready-for-implement) │
          └───────────────────────────────┘
                          │
                          ↓
          ┌───────────────────────────────┐
          │   Check concurrent sessions   │
          │   (active < MAX_CONCURRENT?)  │
          └───────────────────────────────┘
                          │
                   Yes    │    No
          ┌───────────────┴───────────┐
          ↓                           ↓
┌──────────────────────┐    ┌─────────────────┐
│ For each ready issue │    │ Wait & continue │
└──────────────────────┘    └─────────────────┘
          │
          ↓
┌──────────────────────────────┐
│  Check preconditions:        │
│  • AC section exists         │
│  • base:: label exists       │
│  • No open blockers          │
└──────────────────────────────┘
          │
    Pass  │  Fail
          ↓
┌──────────────────────────────┐
│ Trigger afk-implement <iid>  │
│ (background tmux session)    │
└──────────────────────────────┘
          │
          ↓
┌──────────────────────────────┐
│  Sleep for poll interval     │
└──────────────────────────────┘
          │
          └─────────┐
                    ↓
              (loop back)
```

## 监控和调试

### 查看日志

```bash
# 查看 scheduler 主日志
tail -f ~/.claude/logs/afk/scheduler-$(date +%Y%m%d).log

# 查看特定 issue 的日志
tail -f ~/.claude/logs/afk/issue-123.log

# 查看所有今天的日志
ls -lh ~/.claude/logs/afk/scheduler-$(date +%Y%m%d)*
```

### 检查状态

```bash
# 查看当前运行中的 sessions
glab issue list --label "stage::afk-in-progress"

# 查看 ready issues
glab issue list --label "stage::ready-for-implement"

# 查看 tmux sessions
tmux list-sessions | grep afk
```

### 常见问题

**Q: Scheduler 没有触发任何 issue？**
- 检查 label 是否正确：`stage::ready-for-implement`
- 检查前置条件：AC section、base:: label、无 blocker
- 查看日志：`tail -f ~/.claude/logs/afk/scheduler-*.log`

**Q: 达到并发上限怎么办？**
- 增加 `--max-concurrent` 参数
- 或等待当前 sessions 完成
- 检查是否有卡住的 sessions：`tmux ls`

**Q: 如何临时停止 scheduler？**
```bash
# 找到进程
ps aux | grep scheduler.sh

# 停止进程
kill <PID>

# 或使用 systemd/launchd
sudo systemctl stop afk-scheduler  # Linux
launchctl unload ~/Library/LaunchAgents/com.afk.scheduler.plist  # macOS
```

## 最佳实践

### 1. 合理设置轮询间隔
- **开发环境**: 60s（快速响应）
- **生产环境**: 300s（减少 API 调用）
- **高负载**: 600s+（避免 rate limit）

### 2. 并发数控制
- **单机**: 3-5 个
- **多核服务器**: 10+ 个
- **考虑因素**: CPU、内存、GitLab API rate limit

### 3. 日志管理
```bash
# 定期清理旧日志（保留 7 天）
find ~/.claude/logs/afk/ -name "*.log" -mtime +7 -delete

# 或使用 logrotate
```

### 4. 监控告警
- 监控日志中的 ERROR 行
- 监控 active sessions 数量
- 监控 ready issues 积压数量

## 与手动触发的区别

| 特性 | Scheduler 自动触发 | 手动 `/afk-implement` |
|------|-------------------|----------------------|
| 触发方式 | 自动（轮询） | 手动命令 |
| 前置检查 | 自动 | 需要手动检查 |
| 并发控制 | 内置 | 需要手动管理 |
| 日志 | 统一记录 | 分散 |
| 适用场景 | 持续集成/夜间批处理 | 临时/特殊任务 |

## 安全考虑

1. **GitLab Token**: 确保有 read/write issue 权限
2. **并发限制**: 避免 DoS 自己的 GitLab instance
3. **日志权限**: 日志可能包含敏感信息，设置合适的文件权限
4. **Rate Limit**: GitLab API 有速率限制，合理设置轮询间隔

## 示例场景

### 场景 1: 夜间批处理
```bash
# 每晚 22:00 启动 scheduler，处理积压的 issues
# 凌晨 6:00 停止

# crontab -e
0 22 * * * /path/to/scheduler.sh --max-concurrent 10
0 6 * * * pkill -f scheduler.sh
```

### 场景 2: CI/CD 集成
```yaml
# .gitlab-ci.yml
auto-implement:
  stage: implement
  script:
    - ./scripts/scheduler.sh --dry-run  # 先检查
    - ./scripts/scheduler.sh --max-concurrent 5
  only:
    - schedules
```

### 场景 3: 开发环境
```bash
# 开发时实时触发
./scripts/scheduler.sh --interval 30 --max-concurrent 2
```
