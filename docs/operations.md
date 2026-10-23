# 运行、备份与恢复

## 本地

`npm run local:setup` 初始化独立 PostgreSQL 和随机账号，`npm run build` 编译界面，`npm run local:start` 启动 API 和 Worker。全部状态在本仓库 `.local/` 和 `data/`，不会共用 Prompt Guard 的凭据、数据库或进程。

```sh
npm run local:status
npm run local:restart  # 重启 API/Worker，保留 PostgreSQL
npm run local:stop     # 停止本仓库全部本地进程
```

本地启动器使用固定 8920/8922 端口并检查占用；需要自定义端口时直接通过进程管理器运行 `npm start`、`npm run worker`，连接自行提供的 PostgreSQL。首次初始化生成的 `TRADE_ENCRYPTION_KEY` 为后续逐应用加密凭据保留；当前读取来源密钥来自环境变量，没有明文写入数据库。

## 容器模板

```sh
cp compose.env.example .env.compose
# 修改 .env.compose 中数据库密码，使用随机十六进制值。
docker compose --env-file .env.compose up --build -d
docker compose --env-file .env.compose logs -f api worker
```

API 默认只绑定本机 8920，正式部署在前方配置 HTTPS 反向代理并设置 `COOKIE_SECURE=1`。API 和 Worker 必须共享 `files` 卷，以便后台下载 Worker 产出的文件；数据库使用独立卷。初始化账号文件位于 `local` 卷，通过 `docker compose ... exec api cat /app/.local/credentials.json` 在本地受控终端查看，随后为实际人员建号。

Dockerfile、Compose 已提供，但当前机器验收使用的是原生 Node/PostgreSQL，**没有把容器模板标记为已实机验收**。镜像构建、宿主卷权限、反向代理、告警和重启策略在目标部署环境再验证。

## 运行状态

- `/health` 检查 API 与 PostgreSQL；并不证明 Worker 或来源同步健康。
- 应用接入页面显示上次来源检查、接收/应用游标、未应用事件、冲突和来源错误；超过 15 秒未检查会提示延迟。
- Worker 的同步、命令、导入/对账、导出分别循环；大导出不会在同一循环中挡住命令执行。
- 普通任务 45 秒租约、10 秒续约，崩溃后重新领取，最多 5 次租约恢复；业务失败保留任务与错误。导出重试创建新任务，保留旧任务证据。
- 命令使用原命令 ID 查询来源结果，明确失败与结果未知区分。业务申请不暂停原平台自动交易流程。
- 数据和审计没有自动删除策略；导出文件 24 小时到期，已失败/取消的旧文件也会清理。
- 本版对账由人工发起。自动增量/每日对账调度、外部告警、历史分区和磁盘配额监控尚待真实接入阶段补充。

日志只记录操作类别、对象 ID 和错误代码，不输出密码、服务 token 或完整业务请求。

## 备份

```sh
npm run backup
npm run backup:verify -- /absolute/backup/directory
```

备份生成 PostgreSQL custom-format 文件和 SHA-256 清单，目录 0700、文件 0600。工具优先使用 `PG_DUMP_PATH` / `PG_RESTORE_PATH`，其次寻找本机 PostgreSQL 客户端；本地嵌入式服务不保证包含备份客户端。客户端版本须兼容服务器。

数据库含来源副本、模拟来源、事件、审批、任务和审计。导出下载文件不备份，可以重新生成；`.env`、来源密钥和本地初始账号文件需单独安全备份。不要提交这些文件到 Git。

恢复验证先检查清单摘要，在随机命名的临时数据库中恢复并检查分录守恒，报告订单/分录/审计数量，最后删除临时数据库。它不会覆盖运行中的数据库。测试账号需要创建临时数据库权限。

## 灾难恢复步骤

1. 停止 API/Worker，保留旧数据；恢复到新数据库，禁止直接覆盖唯一现存副本。
2. 使用匹配版本的迁移代码和独立保存的配置。确认来源写操作仍关闭。
3. 作废旧 Session。未备份的成功导出任务标记到期；重新生成下载文件。不得伪造旧文件仍可用。
4. 保留原管理命令 ID、申请摘要和来源回执。结果未知必须向原来源确认；禁止另建命令“重试退款”。
5. 比较来源当前游标和事件保留窗口。还可补拉时继续消费；已过期时本版停止同步并提示，需要新建隔离应用重新初始导入，不能静默跳过历史。
6. 完整对账、抽查订单及审批回执，通过后再恢复后台访问。实际来源写入的恢复验收需要在下一阶段完成。

备份频率、外部保存位置、恢复时间目标和保留期限应在部署时确定。当前工具提供手动备份与验证，不代表已建立自动异地备份。
