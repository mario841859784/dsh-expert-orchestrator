---
name: trim-cli
description: 当用户需要登录 TRIM NAS / fnOS、列目录、搜索文件、查看共享目录、管理应用中心应用、管理 Docker 镜像或容器、查看存储池和磁盘 SMART、执行真机验证时使用
---

# trim-cli — TRIM NAS 命令行工具

trim-cli 是 TRIM NAS（fnOS）的命令行客户端。通过 WebSocket 与 NAS 通信，提供认证、文件管理、finder 搜索、共享目录、下载中心、应用中心、日志中心、用户/用户组、系统监控和存储管理能力。

## 什么时候使用

当用户提到以下任务时，应优先考虑使用 trim-cli：

- 登录或登出 TRIM NAS / fnOS
- 列目录、定位当前用户目录、按关键字搜索文件
- 查看共享目录、ACL，或排查“别人共享给我”的文件
- 查看系统信息、CPU、内存、日志、下载任务
- 查看或管理应用中心应用、手动安装 fpk、启动/停用/卸载应用
- 查看或管理 Docker 镜像、容器、Compose
- 查看存储池、磁盘、SMART，或执行挂载/卸载、扩容、格式化等操作
- 按仓库约定执行真机验证

## 任务入口

先按任务类型选择入口文档，再按其中的链接下钻到命令与字段细节：

| 任务类型 | 入口文档 |
| --- | --- |
| 登录、session、连接目标、真机验证和通用规则 | `./entries/trim-shared.md` |
| 列目录、搜索文件、共享目录、ACL、路径判断 | `./entries/trim-file.md` |
| 存储池、磁盘、SMART、高风险存储写操作 | `./entries/trim-storage.md` |
| Docker 镜像、容器、Compose、长耗时变更 | `./entries/trim-docker.md` |
| 认证、用户、用户组、权限确认 | `./entries/trim-user.md` |
| 下载任务列表/详情、创建、暂停/恢复/重试/删除、save_dir 路径校验 | `./entries/trim-download.md` |
| 应用中心应用列表、状态、安装、fpk 手动安装、更新、启动、停用、卸载 | `./entries/trim-app.md` |
| 日志列表、模块过滤、清除/导出/归档策略 | `./entries/trim-log.md` |
| 机器类型、系统版本和静态系统信息识别 | `./entries/trim-system.md` |
| 运行态指标监控（CPU、内存）和 resmon 监控入口 | `./entries/trim-monitor.md` |

## 使用顺序

默认顺序：

1. 优先通过 skill 内置 wrapper 调用：macOS / Linux 用 `./scripts/trim-cli`，Windows 用 `.\scripts\trim-cli.cmd` 或 `.\scripts\trim-cli.ps1`（scripts/bin 仅存在于部署副本）
2. 先按 `./reference/_index.md` 找到对应模块、workflow 或正式入口
3. 任务稳定落在单一领域时，先读 `./entries/*.md`
4. 只有路径语义复杂、危险写操作或真机场景，才先读 workflow
5. 需求已经很明确时，可直接查阅 `./reference/commands.md` 完整命令参考

## 前置条件

- 优先通过 skill 内置 wrapper 调用：macOS / Linux 用 `./scripts/trim-cli`，Windows 用 `.\scripts\trim-cli.cmd` 或 `.\scripts\trim-cli.ps1`；如果已自行安装到 PATH，仍可直接调用 `trim-cli`
- 目标 NAS 网络可达
- 首次当前 skill 执行登录或真机操作时，至少提供账户和密码；未提供时不要假设默认凭据
- 首次使用需执行 `login`，后续命令优先复用本地保存的 session

## 连接配置

所有命令支持全局选项：

```
--host <host>    NAS 地址（默认 localhost）
--port <port>    WebSocket 端口（显式传入时优先）
--scheme auto|ws|wss
                 WebSocket 协议选择（默认 auto）
--allow-insecure-ws
                 允许远程明文 ws:// 连接
--tls-insecure   允许 WSS 使用无效或自签证书
```

补充约定：

- 默认连接目标是 loopback `ws://localhost:5666`
- `--scheme auto` 且未显式传 `--port` 时，loopback 默认 `ws:5666`，远程 IP 默认 `wss:5667`，远程域名默认 `wss:443`
- 显式传 `--port` 时端口优先，CLI 只解析协议选择
- 如果命令没有显式传连接参数，CLI 会优先复用本地已保存 session 的 `host`、`port`、`scheme` 和 TLS 设置
- 内网或自签证书 WSS 目标可能需要显式传 `--tls-insecure`
- 远程明文 `ws://` 需要显式传 `--allow-insecure-ws`
- Session 默认使用平台安全存储：macOS Keychain、Linux 加密文件、Windows DPAPI 加密文件
- 可通过 `TRIM_CLI_CONFIG_DIR` 环境变量覆盖配置目录
- 可通过 `TRIM_CLI_SESSION_STORAGE=file` 强制使用文件 session，适合多目标真机测试或 CI 隔离；文件模式属于较低信任模式
- 可通过 `TRIM_CLI_SESSION_STORAGE=ask-file` 在安全存储写失败时人工确认是否降级写入低信任文件；非交互环境不会降级
- Session 会保存 `token`、`longToken`、`backId`、`secret` 等会话材料，不保存明文密码
- CLI 的 JSON 输出和错误输出会对密码、token、secret、授权头、敏感 Docker 环境变量和敏感 URL 字段做脱敏处理

## 参考文档

- `./reference/_index.md` — trim-cli 参考索引：任务与模块索引、连接目标、session 回落与 wrapper 用法
- `./reference/_conventions.md` — API 文档约定：字段级详情的 agent-first 文档格式
- `./reference/file.md` — file 模块：文件操作与共享目录 API
- `./reference/stor.md` — stor 模块：存储池、磁盘、SMART API
- `./reference/dockermgr.md` — dockermgr 模块：Docker 镜像、容器、Compose API
- `./reference/app-center.md` — App Center reference：应用中心 API
- `./reference/download.md` — download 模块：下载中心 API
- `./reference/log.md` — log 模块：日志中心 API
- `./reference/resmon.md` — resmon 模块：资源监控 API
- `./reference/sysinfo.md` — sysinfo 模块：系统信息 API
- `./reference/user.md` — user 模块：用户/用户组 API
- `./reference/workflows/` — file-routing.md（文件路径与共享目录路由）、storage-dangerous-ops.md（存储危险操作）、device-validation.md（真机验证）
- 完整命令参考：./reference/commands.md
