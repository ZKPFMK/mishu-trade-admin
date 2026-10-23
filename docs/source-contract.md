# 来源接入与 API 契约（v1）

后台默认运行独立模拟来源；MiShu 主平台已实现下述 HTTP 读取端点，配置与历史导入步骤见 [本地接入](mishu-local.md)。**不要把现有用户交易接口、Prompt 审核凭证或 SQLite 路径当作来源接入配置。**

运行时 Schema 位于 `packages/contracts/src/index.ts`；`npm run openapi` 生成 `packages/contracts/openapi.json`，服务启动后可访问 `/openapi.json`。OpenAPI 列出路由和接入数据 Schema；管理接口的字段说明见本文。金额与版本都是字符串，额外字段会被拒绝。

## 1. 认证与环境

- `/auth/login`：`{email,password}`；返回 CSRF token 并设置 8 小时 HttpOnly、SameSite=Strict Cookie。
- `/auth/me`：返回操作员、角色、应用范围和当前 CSRF token。
- `/auth/logout`、`/auth/password` 及所有后台写操作：Cookie + `X-CSRF-Token`；修改密码正文 `{current,password}`，新密码至少 12 字符，修改后注销该用户全部会话。
- `/admin/*` 的应用列表以外查询通常需要 `?application_id=...`；数据权限从当前账号范围校验。
- `/v1/*`：`Authorization: Bearer <service token>`。应用、环境由凭证确定，不接受正文指定身份。用途区分 `events:write`、`imports:write`、`sync:read`。
- 数据键为应用 ID + 来源 ID；每个应用行具有确定的 `environment`（test/production）。同一来源在不同环境必须建立不同应用及凭证。

来源地址和读取密钥仅由部署配置提供，普通操作员不能填写任意 URL。适配器只允许 HTTPS 或回环 HTTP，不跟随重定向，请求 15 秒超时，响应最多 50 MiB。首版每个部署配置一个真实 HTTP 来源；后续多真实来源需扩展逐应用连接配置。

## 2. 来源必须提供的只读端点

| 接口                                              | 当前 HTTP 适配器所需返回值                                      |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `POST /internal/trade-admin/snapshots`            | `{ "snapshot_id": "snapshot_..." }`，正文 `{}`                  |
| `GET /internal/trade-admin/snapshots/:id`         | 下述完整不可变快照；本版要求创建后可立即读取                    |
| `GET /internal/trade-admin/events?after=<cursor>` | `{from_cursor,through_cursor,has_more,events}`，最多 100 个事件 |
| `GET /internal/trade-admin/trades/:id`            | `Trade` Schema 的权威订单对象                                   |

读取来源的配置为 `SOURCE_URL`、`SOURCE_READ_TOKEN`。当前真实来源 **不实现调用命令接口**，即使授予后台审批权限也不能打开真实写操作。

事件页必须严格覆盖从 `from_cursor` 到 `through_cursor` 的来源提交区间。游标是不透明字符串，不假设数值相邻。首个事件 `previous_cursor=from_cursor`，后续前后衔接，最后一个事件的 `source_cursor=through_cursor`；没有事件时两者相同。`has_more` 表示仍有后续事件，由下一轮继续拉取。游标已过保留期必须返回错误，不能返回一个伪造的空页。

## 3. 数据包

`Bundle` 包含四个数组：

| 字段       | 内容                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| `trades`   | 订单、来源版本、买卖方、资产 ID 和标题、价格、许可类型、交付核验摘要、状态时间线 |
| `accounts` | 账户、来源版本、类型、所属用户、余额、期初余额                                   |
| `journals` | 完整记账事务、发生时间、关联业务 ID、全部分录、规则版本                          |
| `jobs`     | 生成任务、来源版本、用户、冻结/实扣积分、收费状态                                |

完整字段以运行时 Schema 为准，不接收资产密钥、封装密文或无关 Prompt。首版固定 `unit=CREDIT`、`payment_mode=simulated`，不会把真实货币误当积分。

订单许可类型保留 `ownership/usage/display`，兼容既有演示 `license`。分录可带原始 `source_kind`、`memo`，详情导出保留这些字段。

许可报价托管 `escrow:lrq_*` 对应 `license_escrow` 及 `license_hold/settle/refund`；检索托管 `lookup:hold:*` 对应 `lookup_hold/settle/refund`。这些流水不计入作品订单成交与退回。生成结算支持原来源账户 `platform:revenue`，按 `generation` 分录角色对账，不改写账户名。

账户命名约定与当前平台一致：`user:<user_id>`、`escrow:<trade_id>`、`jobs:hold:<job_id>`、`platform:*`、`external:*`。接入来源需要按此归一化，否则托管/生成对账规则无法关联。

每个记账事务必须有完整的平衡分录，带稳定事务 ID 和分录 ID；`reference_id` 只是业务关联，不能替代唯一 ID。`seller`、`fee`、`creator_royalty`、`upstream_royalty` 表示实际入账分配。历史规则缺失填写 `rule_version=null`。

## 4. 一致快照

```json
{
  "schema_version": 1,
  "snapshot_id": "snapshot_example",
  "cursor": "source_commit_W",
  "created_at": "2026-10-23T00:00:00Z",
  "history": "full",
  "bundle": { "trades": [], "accounts": [], "journals": [], "jobs": [] },
  "checksum": "sha256:<canonical bundle SHA-256>"
}
```

以上 checksum 是格式占位值，调用时必须替换。摘要算法在 `packages/core/src/security.ts` 的 `canonical` / `digest`：对象键按字典顺序排列，数组保留顺序，排除 undefined，JSON 序列化后计算 UTF-8 SHA-256，并加 `sha256:` 前缀。

来源应先启用事务发件箱，再在同一一致性读中确定完整数据和截止游标 W。快照创建期间的变化留在 W 之后的事件中。后台先核验摘要、唯一性、完整分录、零期初全历史余额，在一个 PostgreSQL 事务中激活；失败不暴露半成品。

当前实现只接受**首次完整导入**，不可对已初始化应用执行覆盖式重建。单快照上限 50 MiB；Bundle 最多 10,000 订单、50,000 账户、50,000 记账事务、10,000 生成摘要，每个事务最多 1,000 分录。大规模来源分块快照、分块续传及在线重新建副本属于后续接入阶段，未假装支持。

入站来源可以直接 `POST /v1/imports` 提交快照；后台创建持久化任务，`GET /v1/imports/:id` 查询验证结果。HTTP 成功不代表导入已完成。

## 5. 增量事件

```json
{
  "schema_version": 1,
  "event_id": "evt_unique_123",
  "source_cursor": "source_commit_X",
  "previous_cursor": "source_commit_W",
  "occurred_at": "2026-10-23T00:01:00Z",
  "bundle": { "trades": [], "accounts": [], "journals": [], "jobs": [] }
}
```

示例为空包，只展示封套。实际事件必须包含本次业务事务影响的完整订单、账户和新增记账事务；每个发布事件中内容变化的账户版本加一，订单和任务同理。若多个业务事务合并后账户净值和其他字段未变，可省略该账户，但新流水必须完整保留。时间戳不能替代单调版本。新增对象版本从 `"1"` 开始，快照可以从更高版本开始。

来源必须保证变动跟踪与业务更新、余额和完整分录在**同一业务事务**提交。MiShu 使用 SQLite 触发器记录变动编号，再在来源内部的一致事务中合并已提交变动、生成不可变事件并更新读模型版本。合并保留每笔完整记账事务和完整订单时间线；该版本是已发布读模型修订号，不能用于未来资金命令的并发控制。后台收到事件时先持久化；Worker 再在一个本地事务内应用。任何验证失败都回滚该事件的全部副本变化。

MiShu 来源另有 `GET /internal/trade-admin/status` 返回来源标识、游标、计数和只读状态。快照保留 24 小时，事件不自动清理。HTTP 拉取每页最多 100 个事件，单事件及事件内容合计最多 40 MiB；与下述推送端点的 2 MiB 限额不同。

- 相同 ID、相同摘要：幂等重复，不再记账。
- 相同 ID 或游标、不同摘要：登记冲突，保留原始内容；同一冲突摘要不会无限重复建单。
- 乱序：缺少前置游标时等待；前置到达后可继续。
- 版本缺口、历史流水变更、金额不平衡：隔离，显示原因；处理来源原因后可重试原事件。
- 旧对象版本不覆盖新版本；同一版本不同内容拒绝。
- 不把“已接收游标”当成“已应用游标”。存在未处理冲突、缺口或来源错误时，对账显示不完整。

`POST /v1/events/batches` 正文 `{events:[...]}`，最多 100 条、2 MiB；按事件返回接收或冲突结果。整个请求先做 Schema 校验，再逐条持久化，因此服务器断线后重发同批安全；完整记账事务不能跨事件拆开。

## 6. 后台写入正文

| 路径                                                         | 主要字段                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `POST /admin/operation-requests`                             | `application_id, trade_id, reason, idempotency_key`；理由 5–1,000 字符，来源决定金额、用户、版本 |
| `POST /admin/operation-requests/:id/{approve,reject,cancel}` | `reason`；审批与申请不可同人                                                                     |
| `POST /admin/cases`                                          | `application_id, title, note, trade_id?`                                                         |
| `POST /admin/cases/:id`                                      | `action` 为 claim、note 或 close；`note` 为说明；仅领取人可关闭                                  |
| `POST /admin/reconciliation-runs`                            | `application_id`                                                                                 |
| `POST /admin/imports`                                        | `application_id`，向配置来源请求初始快照                                                         |
| `POST /admin/exports`                                        | `application_id, dataset, format, scope, fields, filters`                                        |
| `POST /admin/operators`                                      | `email, name, roles[], scopes[]`；随机初始密码仅返回一次                                         |
| `POST /admin/operators/:id/access`                           | `enabled`；禁止修改自己，停用会注销会话                                                          |
| `POST /admin/credentials`                                    | `application_id, label, permissions[]`；随机密钥仅返回一次                                       |
| `POST /admin/event-conflicts/:id/resolve`                    | `reason`；只记录核验依据，不覆盖原事件                                                           |

查询过滤器为 `q`（精确编号、用户、资产编号或完整作品名称）、`status`、`from/to`（上海自然日）、`page`、`limit`、`cursor`。`limit` 1–100，页码直达前 1,000 页，之后继续使用返回的 `next_cursor`。不要在更换筛选时复用旧游标。

导出 `dataset=trades|accounts|journal-transactions|settlements|generation-jobs`；`format=auto|xlsx|jsonl.gz`；`scope=filtered|page`；`fields=summary|detail`。流水、分账每条分录占一行，保留完整事务关联。错误返回 `{error,request_id}`，需要纠正输入/状态后再调用，不应把业务拒绝无限重试。

## 7. 模拟来源命令

模拟来源的全额托管退回接受 `SourceCommand`：`command_id,type=refund_undelivered,trade_id,expected_version,amount,buyer_id,reason`。

来源加锁后在一个事务内检查命令摘要、订单 FUNDED/未核验交付、版本、金额、买家及托管余额，原子写入退款分录、状态、事件、命令回执。所有重试使用同一命令 ID。结果未知先查询回执，再校验审批是否仍有效；已成功的回执不会因为随后过期或撤权而变成“未退款”。

来源状态已经变化时返回明确拒绝，不冒充新退款成功。模拟执行可以测试这些性质，但不能替代真实来源适配的并发、故障和原业务回归验证。
