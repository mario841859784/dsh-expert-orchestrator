## 命令参考

### 认证

#### login

登录 NAS 并保存 session。

```
trim-cli --host <host> --port <port> login [-u <username>] [-p <password>]
```

- `-u, --username <username>`：用户名；省略则交互输入
- `-p, --password <password>`：密码；省略则交互输入

#### logout

清除本地 session，并尝试远端登出。

```
trim-cli --host <host> --port <port> logout
```

### Shortcut

#### +status

聚合系统信息、CPU、内存和存储总览，输出单个 JSON 对象。

```
trim-cli --host <host> --port <port> +status
```

#### +ls [path]

`file ls [path]` 的快捷入口。参数与路径规则保持一致。

```
trim-cli --host <host> --port <port> +ls
trim-cli --host <host> --port <port> +ls /vol1/downloads
```

#### +search <key> [paths...]

`file search <key> [paths...]` 的快捷入口。参数与路径规则保持一致。

```
trim-cli --host <host> --port <port> +search report
trim-cli --host <host> --port <port> +search report /vol1/1000 /vol2/1000/docs
```

### 系统与监控

#### system info

查看 NAS 机器类型和系统信息。

```
trim-cli --host <host> --port <port> system info
```

#### monitor cpu

查看 CPU 使用率。

```
trim-cli --host <host> --port <port> monitor cpu
```

#### monitor memory

查看内存使用率。

```
trim-cli --host <host> --port <port> monitor memory
```

### 文件操作

#### file ls [path]

列出文件。无参数或 `/` 都会发送不带 `path` 的 `file.ls` 请求；传 `/vol{v}/...` 列出具体目录。

```
trim-cli --host <host> --port <port> file ls
trim-cli --host <host> --port <port> file ls /vol1/downloads
```

#### file search <key> [paths...]

用 finder 在一个或多个具体路径下搜索文件。未传路径时，会先做一次不带 `path` 的 `file.ls` 探测，再按返回条目推导当前用户目录。

```
trim-cli --host <host> --port <port> file search report
trim-cli --host <host> --port <port> file search report /vol1/1000 /vol2/1000/docs
```

#### file search-others <key>

搜索“其他用户共享给当前用户”的文件。

```
trim-cli --host <host> --port <port> file search-others .txt
```

#### file acl get <path>

查看指定路径的 ACL。可选 `--prop` 额外带出文件属性信息。

```
trim-cli --host <host> --port <port> file acl get /vol1/1000/docs
trim-cli --host <host> --port <port> file acl get /vol1/1000/docs --prop
```

#### file share info <path>

查看指定路径当前的共享目录信息。

说明：这里的 `file share ...` 指的是共享目录（shared folder）能力，不是 `appcgi.sharesvr.share.link.*` 那套共享链接（share link）管理接口。

```
trim-cli --host <host> --port <port> file share info /vol1/1000/share
```

#### file share list [uid]

列出当前用户可见的共享目录；可选按源用户 `uid` 过滤。

```
trim-cli --host <host> --port <port> file share list
trim-cli --host <host> --port <port> file share list 1001
```

#### file share list-others

列出有哪些用户向当前用户共享了目录。

```
trim-cli --host <host> --port <port> file share list-others
```

#### file share admin-list [uid]

以管理员视角列出共享目录；可选按 owner `uid` 过滤。

```
trim-cli --host <host> --port <port> file share admin-list
trim-cli --host <host> --port <port> file share admin-list 1001
```

#### file share admin-list-others

以管理员视角列出有哪些 owner 拥有共享目录。

```
trim-cli --host <host> --port <port> file share admin-list-others
```

#### file share add <path> <shareName>

把具体路径创建为共享目录。`--permset` 必填，推荐直接复用 `file acl get` 返回的原始 `permset`。

```
trim-cli --host <host> --port <port> file share add /vol1/1000/share team-share --permset '[{"id":1000,"perm":7}]'
trim-cli --host <host> --port <port> file share add /vol1/1000/share team-share --permset '[...]' --sub --acl-mode 2
```

#### file share del <path>

移除指定路径的共享目录状态。

```
trim-cli --host <host> --port <port> file share del /vol1/1000/share
trim-cli --host <host> --port <port> file share del /vol1/1000/share --sub --acl-mode 2
```

#### file mkdir <path>

在指定路径创建目录。路径必须为 `/vol{v}/...` 格式。

```
trim-cli --host <host> --port <port> file mkdir /vol2/1106/new-dir
```

#### file check-upload <path> <size>

上传前检查目标文件路径是否可用。路径必须是完整目标文件路径，`size` 为字节数。

```
trim-cli --host <host> --port <port> file check-upload /vol2/1106/new.jpg 12345 --overwrite rename
```

#### file upload <remoteDir> <localFile>

上传单个本地文件到远端目录。`remoteDir` 必须为 `/vol{v}/...` 目录路径，CLI 会自动使用本地文件名拼出远端目标文件路径。

```
trim-cli --host <host> --port <port> file upload /vol2/1106/photos ./new.jpg --overwrite rename
```

#### file rm <path>

删除文件或目录。路径必须为 `/vol{v}/...` 格式。

```
trim-cli --host <host> --port <port> file rm /vol2/1106/old-dir
```

#### file cp <src> <destDir>

复制到目标目录。源路径和目标目录都必须为 `/vol{v}/...` 格式。同名冲突时当前请求策略为保留两者。

```
trim-cli --host <host> --port <port> file cp /vol1/a.txt /vol2/backup
```

#### file mv <src> <destDir>

移动到目标目录。源路径和目标目录都必须为 `/vol{v}/...` 格式。

```
trim-cli --host <host> --port <port> file mv /vol1/a.txt /vol2/archive
```

### 应用中心

应用中心命令复用普通登录态。写操作必须显式传 `--yes`。

#### app list

列出已安装应用。

```
trim-cli --host <host> --port <port> app list
```

#### app status <appName>

查看单个已安装应用记录。

```
trim-cli --host <host> --port <port> app status trim.alist
```

#### app install <appName>

下载并安装应用中心指定版本。`--volume-id` 必填，默认安装后立即启动。知道应用中心 `sourceID` 时建议传 `--source-id`。

```
trim-cli --host <host> --port <port> app install trim.alist --version 3.0.13 --source-id 265 --volume-id 2 --yes
```

#### app install-fpk <localFile>

上传并安装本地 `.fpk` 文件。需要选择安装卷。

```
trim-cli --host <host> --port <port> app install-fpk ~/Downloads/demo.fpk --volume-id 2 --dry-run --yes
trim-cli --host <host> --port <port> app install-fpk ~/Downloads/demo.fpk --volume-id 2 --yes
```

`--dry-run` 会上传并解析本地 FPK、读取安装信息和安全 guard，但不会启动真正的安装任务；输出 JSON 计划，适合危险写操作前检查。

#### app update <appName>

下载并更新应用到指定版本。CLI 会从已安装列表解析 `sourceID`。

```
trim-cli --host <host> --port <port> app update trim.alist --version 3.0.14 --volume-id 2 --yes
```

#### app start / stop / uninstall

启动、停用或卸载应用。

```
trim-cli --host <host> --port <port> app start trim.alist --yes
trim-cli --host <host> --port <port> app stop trim.alist --yes
trim-cli --host <host> --port <port> app uninstall trim.alist --yes
```

### 下载任务

下载命令复用普通登录态。执行过一次 `login` 后即可使用。

#### download ls [keyword]

列出下载任务。传 keyword 按关键字搜索。

```
trim-cli --host <host> --port <port> download ls
trim-cli --host <host> --port <port> download ls ubuntu
```

#### download info <id>

查看单个下载任务详情。`id` 为正整数。

```
trim-cli --host <host> --port <port> download info 42
```

#### download files <id>

查看下载任务的文件列表（BT 类任务）。

```
trim-cli --host <host> --port <port> download files 42
```

#### download add-uri <uri> <saveDir>

从 URI（HTTP/HTTPS/FTP/SFTP）或磁力链接创建下载任务。`saveDir` 必须为 `/vol{v}/...`。

```
trim-cli --host <host> --port <port> download add-uri 'magnet:?xt=urn:btih:...' /vol1/downloads
trim-cli --host <host> --port <port> download add-uri 'https://example.com/file.zip' /vol1/downloads
```

#### download add-path <path> <saveDir>

从 NAS 上已有的 `.torrent` 文件创建下载任务。`path` 和 `saveDir` 都必须为 `/vol{v}/...`。

```
trim-cli --host <host> --port <port> download add-path /vol1/torrents/demo.torrent /vol1/downloads
```

#### download pause <id...>

暂停一个或多个下载任务。

```
trim-cli --host <host> --port <port> download pause 42 43
```

#### download resume <id...>

恢复暂停的下载任务。

```
trim-cli --host <host> --port <port> download resume 42 43
```

#### download retry <id...>

重试失败的下载任务。

```
trim-cli --host <host> --port <port> download retry 42
```

#### download rm <id...>

删除下载任务，但不删除已下载文件。

```
trim-cli --host <host> --port <port> download rm 42 43
```

#### download stat

查看下载中心汇总统计。

```
trim-cli --host <host> --port <port> download stat
```

### 日志中心

#### logger list

按页列出日志中心记录。

```
trim-cli --host <host> --port <port> logger list [--page <n>] [--page-size <n>] [--level <n>] [--module <n>] [--locale <locale>]
```

#### logger modules

列出可用日志模块。

```
trim-cli --host <host> --port <port> logger modules [--locale <locale>]
```

#### logger clear

按日志级别和模块清空记录。

```
trim-cli --host <host> --port <port> logger clear --level <level> --module <module>
```

#### logger export

按日志级别和模块导出记录。

```
trim-cli --host <host> --port <port> logger export --level <level> --module <module> [--locale <locale>]
```

#### logger archive set

设置日志归档策略。

```
trim-cli --host <host> --port <port> logger archive set --switch <0|1> --file-path <path> [--size-gt <n>] [--date-unit <n>] [--date-before <n>]
```

说明：

- `--switch 0` 表示关闭归档，`--switch 1` 表示开启归档
- `--date-unit`：`0` 天，`1` 周，`2` 月，`3` 年
- 禁用归档时可传空路径，例如 `--file-path ''`

#### logger archive query

查看当前日志归档配置。

```
trim-cli --host <host> --port <port> logger archive query
```

### 用户与用户组

用户/用户组写操作默认会要求确认；传 `-y, --yes` 可跳过确认。

#### user list

列出用户；可选传 `--uver` 复用缓存版本号。

```
trim-cli --host <host> --port <port> user list
trim-cli --host <host> --port <port> user list --uver 0
```

#### user frozen-list

列出被冻结用户。该命令本质上是先调用 `user.list`，再按 `bannedTime` 做本地过滤。

```
trim-cli --host <host> --port <port> user frozen-list
```

#### user info [user]

查看当前用户或指定用户的信息。

```
trim-cli --host <host> --port <port> user info
trim-cli --host <host> --port <port> user info alice
```

#### user list-ug

列出用户/用户组名称到 ID 的映射。默认同时请求 users 和 groups。

```
trim-cli --host <host> --port <port> user list-ug
trim-cli --host <host> --port <port> user list-ug --users
trim-cli --host <host> --port <port> user list-ug --groups --uver 0
```

#### user group-list

列出用户组。

```
trim-cli --host <host> --port <port> user group-list
```

#### user group-info <group>

查看指定用户组详情。

```
trim-cli --host <host> --port <port> user group-info Administrators
```

#### user group-users

列出各组及其成员用户 ID。

```
trim-cli --host <host> --port <port> user group-users
trim-cli --host <host> --port <port> user group-users --uver 0
```

#### user list-login-device

列出当前用户的登录设备。

```
trim-cli --host <host> --port <port> user list-login-device
```

#### user add <user>

新增用户。

```
trim-cli --host <host> --port <port> user add <user> [--password <password>] [--groups <group> ...] [--comment <comment>] [--email <email>] [--mobile <mobile>] [--disable-change-password] [--set-admin] [-y]
```

#### user mod <user>

修改用户。

```
trim-cli --host <host> --port <port> user mod <user> [--new-name <user>] [--password <password>] [--groups <group> ...] [--comment <comment>] [--email <email>] [--mobile <mobile>] [--disable-change-password|--enable-change-password] [--disable-user <n>] [--allow-ssh|--disallow-ssh] [-y]
```

说明：

- `--allow-ssh` 只允许对管理员用户生效；CLI 会先做校验
- 组参数支持重复传入或逗号分隔

#### user del <user>

删除用户。

```
trim-cli --host <host> --port <port> user del <user> [-y]
```

#### user set-admin <user>

授予或撤销管理员权限。

```
trim-cli --host <host> --port <port> user set-admin <user> --on [-y]
trim-cli --host <host> --port <port> user set-admin <user> --off [-y]
```

#### user unfreeze <user>

解冻用户。

```
trim-cli --host <host> --port <port> user unfreeze <user> [-y]
```

#### user change-password [user]

修改当前用户或指定用户密码。

```
trim-cli --host <host> --port <port> user change-password [user] [--old-password <password>] [--new-password <password>] [--remove-token] [-y]
```

#### user group-add <group>

新增用户组。

```
trim-cli --host <host> --port <port> user group-add <group> [--comment <comment>] [-y]
```

#### user group-mod <group>

修改用户组。

```
trim-cli --host <host> --port <port> user group-mod <group> [--new-name <group>] [--comment <comment>] [-y]
```

#### user group-del <group>

删除用户组。

```
trim-cli --host <host> --port <port> user group-del <group> [-y]
```

#### user group-set-users <group>

整体替换用户组成员。

```
trim-cli --host <host> --port <port> user group-set-users <group> --users <user> [--users <user> ...] [-y]
```

#### user group-add-users <group>

向用户组增加成员。

```
trim-cli --host <host> --port <port> user group-add-users <group> --users <user> [--users <user> ...] [-y]
```

#### user group-del-users <group>

从用户组移除成员。

```
trim-cli --host <host> --port <port> user group-del-users <group> --users <user> [--users <user> ...] [-y]
```

### 存储管理

存储命令复用登录态。写操作默认会要求确认；传 `-y, --yes` 可跳过确认。高风险操作可通过 `--password <password>` 传入密码，省略时会按提示交互输入。

当前高风险密码策略：

- 仅确认，无密码校验：`storage mount`
- 先验密再透传密码：`storage umount`、`storage create`、`storage stop`、`storage add-disk`、`storage remove-disk`、`storage replace-disk`、`storage resize`
- 先验密但不透传密码：`storage extend`、`storage format`、`storage eject`

#### storage overview

查看存储总览信息。

```
trim-cli --host <host> --port <port> storage overview
```

#### storage pools

列出存储池。

```
trim-cli --host <host> --port <port> storage pools
```

#### storage disks

列出磁盘。

```
trim-cli --host <host> --port <port> storage disks
```

#### storage removable

列出可移动存储设备。

```
trim-cli --host <host> --port <port> storage removable
```

#### storage space

查看聚合存储空间信息。

```
trim-cli --host <host> --port <port> storage space
```

#### storage health <disk>

查看指定磁盘健康信息。`disk` 必须是纯设备名。

```
trim-cli --host <host> --port <port> storage health sda
```

#### storage smart <disk>

查看指定磁盘 SMART 信息。`disk` 必须是纯设备名。

```
trim-cli --host <host> --port <port> storage smart sda
```

#### storage mount <uuid>

挂载存储池。`uuid` 使用 uuid 或 `trim_*` 标识。

```
trim-cli --host <host> --port <port> storage mount trim_pool [-y]
```

#### storage umount <uuid>

卸载存储池。可传 `--password` 处理受保护操作。

```
trim-cli --host <host> --port <port> storage umount trim_pool [--password <password>] [-y]
```

#### storage create

创建存储池。`--disks` 可重复传入，也可用逗号分隔；`--level` 必填。

```
trim-cli --host <host> --port <port> storage create --level 5 --disks sda --disks sdb --fstype btrfs [--comment <comment>] [--check-disk] [--password <password>] [-y]
```

#### storage stop <uuid>

停止并删除指定存储池。可传 `--password` 处理受保护操作。

```
trim-cli --host <host> --port <port> storage stop trim_pool [--password <password>] [-y]
```

#### storage add-disk <uuid>

向存储池添加磁盘。

```
trim-cli --host <host> --port <port> storage add-disk trim_pool --disks sdc,sdd [--password <password>] [-y]
```

#### storage remove-disk <uuid>

从存储池移除磁盘。

```
trim-cli --host <host> --port <port> storage remove-disk trim_pool --disks sdc [--password <password>] [-y]
```

#### storage replace-disk <uuid>

替换存储池中的磁盘。`--disks` 和 `--new-disks` 的数量必须一致。

```
trim-cli --host <host> --port <port> storage replace-disk trim_pool --disks sdc --new-disks sdd [--password <password>] [-y]
```

#### storage extend <uuid>

扩展存储池。可传 `--password` 处理受保护操作。

```
trim-cli --host <host> --port <port> storage extend trim_pool [--password <password>] [-y]
```

#### storage resize <uuid>

调整存储池。`--disks` 必填，可选传 `--vd-name` 和 `--level`。

```
trim-cli --host <host> --port <port> storage resize trim_pool --disks sdc --vd-name vd1 [--level 6] [--password <password>] [-y]
```

#### storage format <disk>

格式化可移动磁盘或分区。`--fstype` 必填，`--partition` 默认为 `0`。

```
trim-cli --host <host> --port <port> storage format sdz --fstype ext4 [--partition 1] [--password <password>] [-y]
```

#### storage eject <disk>

弹出可移动磁盘。可传 `--password` 处理受保护操作。

```
trim-cli --host <host> --port <port> storage eject sdz [--password <password>] [-y]
```

## 输出格式

- 查询类命令通常输出 JSON 到 stdout
- 成功的变更类命令通常输出人类可读的确认文本到 stdout
- 错误输出到 stderr，进程以非零退出码退出
- Agent 不应假设所有 stdout 都是 JSON；应按具体命令解析

## 错误处理

- session 过期：重新执行 `login`
- 网络错误：检查 `host` / `port` 是否正确，NAS 是否可达
- 连接失败：错误信息会明确指出当前尝试连接的 `host:port`
- 路径或标识校验失败：检查是否满足 `/vol{v}/...`、uuid、磁盘名等约束
- 错误响应通常包含 `errno`（错误码）和 `errmsg`（错误信息）

## API 参考

- API 文档位于 `./reference/`
- 字段级详情遵循 `_conventions.md` 定义的 agent-first 文档格式
