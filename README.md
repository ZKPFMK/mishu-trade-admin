# MiShu Trade Admin · 交易管理后台

独立于 MiShu 主平台、Prompt 审核服务的交易管理系统。提供订单、积分账户、完整流水、实际分账、生成扣费、对账、工单、双人审批和异步导出。

新版以岗位工作为入口：默认进入 **我的工作台**，支持交易跟进、客服工单、独立核验和团队管理。原有图表位于“经营分析”，账务和受控资金审批继续保留。产品流程与首版范围见 [交易服务工作台设计](docs/workspace-design.md)。

**已支持主平台历史与增量同步，以及独立审批后的真实积分订单退款、到期结算重试、暂停、补偿和冲正。管理命令需两端显式开启，业务仍由主平台原子执行。新安装默认模拟来源。**

操作流程、配置与恢复详见 [真实交易运营处理](docs/management.md)。

## 本地启动

需要 Node.js 22.12+（本机使用 26.5）、npm。首次安装需要网络；本地 PostgreSQL 随开发依赖安装，和其他仓库的数据库独立。

```sh
npm install
npm run local:setup
npm run build
npm run local:start
```

打开 **http://localhost:8920**。首次 Worker 启动后导入 128 笔模拟订单及配套积分、分账、生成任务数据。

| 服务            | 默认端口 |
| --------------- | -------- |
| API / 后台      | 8920     |
| Vite 开发服务   | 8921     |
| 独立 PostgreSQL | 8922     |

账号密码在 `.local/credentials.json`，随机生成，不进入 Git。运行 `npm run credentials` 可在本地交互终端查看。

| 账号                         | 用途                                           |
| ---------------------------- | ---------------------------------------------- |
| `admin@trade-admin.local`    | 管理、查看、创建处理申请、审计；不具备审批角色 |
| `approver@trade-admin.local` | 查看、独立审批；不能审批自己的申请             |
| `auditor@trade-admin.local`  | 查看、导出、审计；不能申请或审批               |

本地演示时可以用两个浏览器会话切换申请人和审批人。上线需要为不同实际人员分配账号；仅使用两个账号不能替代组织上的职责分离。

```sh
npm run local:status
npm run local:stop
# 只更新前端：npm run build；更改服务代码后重启 API/Worker。
npm run dev:admin
```

初始化可以重复执行，已有数据和密码不会重置。日志位于 `.local/api.log`、`.local/worker.log`。本地启动脚本仅管理本仓库记录且核验过身份的进程。

## 当前可以测试什么

1. **数据概览**：订单环形图、成交/退款趋势、实际分账、交易类型、作品排行、当前积分分布；支持日期与指标切换、前期对比和自动刷新。见 [分析口径](docs/analytics.md)。
2. **订单查询**：编号、用户、资产编号或完整名称精确搜索，状态和日期筛选；页码跳转、游标翻页和订单时间线。
3. **账目查看**：用户余额、托管、生成冻结；按记账事务展开完整分录，查看实际分账与版税。
4. **演示退款闭环**：管理账号打开托管中订单（如 `trade_00005`），填写退款理由；用审批账号审批。Worker 向模拟来源执行，由来源原子记账和写入事件，再同步回来。页面自动更新。
5. **异常工单**：新建、领取、追加说明、关闭；领取会明确显示处理人。
6. **对账**：发起完整对账，检查余额、托管、分账、退款和生成扣费；缺口或来源异常时显示数据不完整。
7. **导出**：当前页或当前筛选、Excel 或压缩 JSONL、后台生成、进度、取消、重试、分包下载和 24 小时失效。下载重新检查当前权限。
8. **接入管理**：同步事件、初始导入、隔离事件重试、按用途创建与撤销服务凭证。
9. **真实运营**：工单核验、权威预览、密码与 MFA 验证、独立审批、来源执行与未知结果恢复。
10. **权限审计**：角色与应用范围、创建操作员、停用账号、修改本人密码和审计记录。

所有交易金额均为 `CREDIT` 积分，支付模式为 `simulated`，不是现金收付。金额在 API 和 Excel 中以字符串保留精度。

## 开发与验证

```sh
npm run build
npm test
npm run test:ui
npm run test:mishu -- /absolute/path/to/mishu-platform
npm run test:management -- /absolute/path/to/mishu-platform
# 只验证隔离的主平台 HTTP 管理链路（不启动浏览器）：
npm run test:management -- /absolute/path/to/mishu-platform --api-only
```

测试创建随机 PostgreSQL Schema 和临时文件夹，结束后删除；不会操作本地演示数据或其他系统数据。浏览器测试需要 Chromium；非当前机器可设置 `CHROMIUM_PATH`。截图在 `.local/ui-tests/`。

## 接入真实平台

主平台已实现专用读取端点和事务内变动跟踪。运行 `npm run connect:mishu -- --platform /absolute/path/to/mishu-platform` 配置来源，再重启两端并执行 `npm run connect:mishu -- --import` 导入历史。完整步骤见 [本地接入说明](docs/mishu-local.md)。后台默认优先显示主平台应用，按约 2 秒间隔同步新变化。

接入契约见 [source-contract.md](docs/source-contract.md)，当前边界和后续工作见 [acceptance.md](docs/acceptance.md)。不直接读取或写入 MiShu SQLite，不从相邻仓库导入运行时代码。

## 部署与备份

本地运行已验证。Docker 部署模板见 [operations.md](docs/operations.md)，实际目标环境部署需单独验收。

```sh
npm run backup
npm run backup:verify -- /absolute/path/to/backup
```

备份使用 PostgreSQL 客户端工具；可设置 `PG_DUMP_PATH`、`PG_RESTORE_PATH`。恢复验证在临时数据库完成并删除，不覆盖正在使用的数据。

## 代码结构

```text
apps/admin          React 管理界面
apps/api            Fastify 接入与管理 API
apps/worker         同步、命令、导入/对账、导出独立工作循环
packages/contracts  Zod 事件、快照、命令 Schema
packages/core       权限、查询、审批、同步、对账、导出
packages/database   PostgreSQL 连接与迁移
packages/adapters   持久化模拟来源 / MiShu HTTP 查询与管理命令
migrations          SQL 迁移
scripts             本地启动、账号初始化、备份和验收
tests               隔离环境集成测试
```

新仓库独立管理版本，每次完成改动后验证并本地提交。远程地址尚未配置，不会自动推送到 Prompt 审核仓库。
