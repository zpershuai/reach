# Gateway 控制台

控制台与 Gateway 共用监听端口，入口为 `/console/`，管理 API 位于 `/api/console/`。它管理一个 owner 账户，使用密码与 TOTP 登录；Controller/Engine token 不提供控制台权限，控制台 cookie 也不提供 RPC 权限。客户端标签均为自报、未验证的审计信息。

## 启用与首次设置

已有部署先备份自己的私有配置，并复用原来的 Controller token、Engine token 和 Engine ID。不要用本文示例替换正在使用的凭证。

在独立部署目录（例如 `/srv/reach`，应位于源码仓库之外）准备数据目录：

```sh
cd /srv/reach
sudo install -d -m 700 -o 1000 -g 1000 data
```

Compose 挂载 `./data:/var/lib/reach:rw` 并设置 `REACH_DATA_DIR=/var/lib/reach`。保持 `read_only: true`、`cap_drop: [ALL]` 和 `no-new-privileges`。在私有 `gateway.env` 中加入外部 origin，不带路径或尾部斜线：

```dotenv
REACH_PUBLIC_ORIGIN=https://gateway.example.com
REACH_AUDIT_RETENTION_DAYS=30
```

直接运行 Gateway 时自行设置 `REACH_DATA_DIR`，目录须可写。省略该变量则关闭控制台，原有数据面接口继续运行。非回环监听启用控制台时必须配置 `REACH_PUBLIC_ORIGIN`；不可写目录和非法保留天数会在监听前报错。

构建发布包的脚本会构建前端并将资产放入 Gateway 镜像。源码开发参见 [console README](../../packages/gateway-console/README.md)。部署后：

```sh
docker compose up -d gateway
docker compose logs gateway
```

只在没有管理员且未显式配置 `REACH_ADMIN_SETUP_TOKEN` 时，Gateway 将随机 setup token 写入 `REACH_DATA_DIR/admin-setup-token`，文件必须是本用户所有的 `0600` 普通文件；数据目录不能是符号链接，也不能对所有用户可写（带 sticky 位的除外），组可写的卷（如 Kubernetes `fsGroup`）可以使用。重启复用该文件；symlink、不安全权限或损坏文件会拒绝启动，不会覆盖它们。已有管理员时残留的 setup 文件已无法使用；若无法安全删除，Gateway 照常启动并记录 `CONSOLE_SETUP_TOKEN_NOT_REMOVED`，请手动删除该文件。日志只提示私有读取方式，不打印 token。可在自己的私有终端读取，例如 Compose 中运行 `docker compose exec -T gateway sh -c 'cat "$REACH_DATA_DIR/admin-setup-token"'`；直接运行时读取自己配置数据目录中的该文件。不要将输出转入服务日志、公开工单或仓库。也可预先在私有 env 中设置 `REACH_ADMIN_SETUP_TOKEN`。打开 `https://gateway.example.com/console/`，输入 token、扫描验证器二维码、设置至少 12 字符的密码并确认 TOTP。保存只显示一次的十个单次恢复码。管理员创建后 setup token 立即失效，自动文件被删除。已有管理员不会重新生成 token。旧版本只写日志的临时 token 不再有效；首次设置改用私有文件或显式 env 凭据。

会话 cookie 使用 HttpOnly、SameSite=Strict、Path=/；HTTPS origin 下增加 Secure。会话空闲十二小时或创建七天后过期，退出立即撤销。添加/删除设备、轮换 token、断开客户端和改变保留期需要十分钟内重新输入过密码。更换浏览器后使用密码与新鲜 TOTP 登录；恢复码可代替一次 TOTP。

## 反向代理与限流

TLS 由现有 Caddy 提供；保持 Gateway 宿主端口绑定回环地址。不要额外启动会争用 80/443 的代理。SSE 路由 `/api/console/events` 应直通，关闭额外缓冲；Gateway 已发送 `X-Accel-Buffering: no`，Caddy 默认可以流式转发。

`REACH_TRUSTED_PROXIES` 是逗号分隔的代理 IP/CIDR，仅当 socket 对端受信时才解析 `X-Forwarded-For`，从右向左跳过受信代理。用实际观察到的对端设置最小范围，不要把所有地址都设为可信。示例：

```dotenv
REACH_TRUSTED_PROXIES=192.0.2.10,2001:db8::10/128
```

宿主 Caddy 经 Docker 转发时，对端可能是 bridge gateway；应检查本机网络配置并仅把该代理地址写入私有 env。未配置时使用 socket 地址，转发头不能伪造限流来源，但所有请求可能共享一个限额，Overview 会提示。登录、setup 和重新认证均有单地址与全局退避限流。

可选 Caddy IP 白名单示例；将文档地址替换成自己的授权范围，并避免把真实拓扑提交到仓库：

```caddyfile
gateway.example.com {
    @console path /console /console/* /api/console/*
    handle @console {
        @owner remote_ip 192.0.2.0/24 2001:db8::/32
        handle @owner {
            reverse_proxy 127.0.0.1:28787
        }
        respond "Forbidden" 403
    }
    handle {
        reverse_proxy 127.0.0.1:28787
    }
}
```

所有变更 API 都要求与配置一致的 Origin 和会话 CSRF 头；自建客户端先获取 `GET /api/console/me`，登录前也使用短期匿名 CSRF cookie。不要关闭这些检查来解决代理配置问题。

## 客户端权限

Clients → Client identities & permissions 可创建、轮换和撤销 delegated 身份，编辑 delegated/OAuth 的资源权限，或明确复核存量 legacy 全局授权。凭据只展示一次，操作需要近期重新认证；权限变更回收旧会话和任务。完整步骤、API 字段与数据库回滚见 [客户端权限](client-access.md)。

## 添加与管理设备

Devices → Add device：输入名称与唯一 ID，选择 Linux、macOS、OpenWrt 或 Docker，保存只返回一次的 token，并在设备上使用匹配的安装器、发布包或静态 Engine 二进制运行显示的命令。命令使用配置的 public origin；OpenWrt 需匹配的 Node bundle，macOS 需构建本机 release Engine。新注册立即可路由，首次有效心跳前显示等待；关闭向导保留注册。

环境变量与 `engines.json` 的设备是 seed。可以改显示名或覆盖设备类型，但控制台不删除或轮换它们。console 设备可轮换 token；旧 token 立即失效，已有会话继续运行。删除会关闭会话、撤销 grant，但保留审计历史。离线设备仍保留在拓扑里。

Engine 报告的硬件字段和类型覆盖见 [Engine 部署](engine.md)。设备详情显示 `session.ready` 报告的工作区及进程执行配置；旧 Engine 未报告该配置时显示 not reported，不以方法列表猜测权限。

Activity 只保存元数据，不保存文件正文、搜索模式、进程参数或输出。可按时间、设备、客户端、方法类和结果筛选，导出 CSV/JSONL；导出本身有审计记录。Settings 的保留期为 1–365 天，默认 30 天，每日清理。Skills 入口仅预留。

## 备份、恢复与回滚

`reach.db` 包含管理员 TOTP secret、会话、恢复码哈希、Engine token 摘要、设备信息和审计路径，须作为私有凭证数据保护。客户端权限与认证 principal 审计字段由前向 migration 保存，旧版本不能打开新 schema。数据库权限为 0600；不要把数据库、备份、真实安装记录或恢复码放入公开仓库。源码 checkout 内仅使用忽略的 `.reach/` 保存私有状态，实际部署状态与备份应在仓库之外。

最简单的一致性备份是停止 Gateway 后复制整个数据目录，包含仍存在的 WAL/SHM 文件。备份目录由操作者配置并置于私有存储：

```sh
cd /srv/reach
: "${REACH_PRIVATE_BACKUP_DIR:?Set a private backup directory outside the repository}"
install -d -m 700 "$REACH_PRIVATE_BACKUP_DIR"
docker compose stop gateway
tar -czf "$REACH_PRIVATE_BACKUP_DIR/reach-data-$(date -u +%Y%m%dT%H%M%SZ).tgz" data
chmod 600 "$REACH_PRIVATE_BACKUP_DIR"/reach-data-*.tgz
docker compose up -d gateway
```

同时另行备份私有 env、`engines.json` 与 Compose 配置。在线备份应使用 SQLite backup API 或一致性快照，不要只复制活动中的 `reach.db` 而忽略 WAL。

恢复时先停止 Gateway，保存当前目录，再解包选定备份，恢复 uid/gid 1000 和目录 0700、数据库 0600，然后启动与数据库版本匹配的 Gateway。验证 owner 登录、设备注册和活动查询。不要用新建空数据目录覆盖原安装来修复登录问题。

自动发布 helper 保留现有 `data/`、env、注册表和 Compose 文件，不自动启用或迁移已有安装。数据库仅前向迁移；旧版本遇到更新的数据库版本会拒绝打开。回滚到没有控制台的版本前，console 设备需以新签发的 token 迁回私有 `engines.json` 并更新对应 Engine 配置，因为旧版本无法恢复摘要中的原 token。保留数据库备份后移除 `REACH_DATA_DIR` 或部署旧镜像；环境和 seed 配置保持原样。重新部署支持的版本并恢复原数据目录后可恢复控制台。

客户端策略和 legacy 迁移的独立恢复要求见 [客户端权限：升级和回滚](client-access.md#升级和回滚)。
