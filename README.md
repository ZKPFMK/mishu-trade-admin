# MiShu Trade Admin · 交易管理后台

独立于 MiShu 主平台、Prompt 审核服务的交易管理系统。提供订单、积分账户、完整流水、实际分账、生成扣费、对账、工单、双人审批和异步导出。

**已支持 MiShu 主平台的 HTTP 只读接入，包括历史导入和持续增量同步。新安装仍默认模拟来源；本地连接后真实数据与演示数据分应用保存。真实来源管理命令在代码中关闭。**

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

1. **订单查询**：编号、用户、资产编号或完整名称精确搜索，状态和日期筛选；页码跳转、游标翻页和订单时间线。
2. **账目查看**：用户余额、托管、生成冻结；按记账事务展开完整分录，查看实际分账与版税。
3. **模拟退款闭环**：管理账号打开托管中订单（如 `trade_00005`），填写退款理由；用审批账号审批。Worker 向模拟来源执行，由来源原子记账和写入事件，再同步回来。页面自动更新。
4. **异常工单**：新建、领取、追加说明、关闭；领取会明确显示处理人。
5. **对账**：发起完整对账，检查余额、托管、分账、退款和生成扣费；缺口或来源异常时显示数据不完整。
6. **导出**：当前页或当前筛选、Excel 或压缩 JSONL、后台生成、进度、取消、重试、分包下载和 24 小时失效。下载重新检查当前权限。
7. **接入管理**：同步事件、初始导入、隔离事件重试、按用途创建与撤销服务凭证。
8. **权限审计**：角色与应用范围、创建操作员、停用账号、修改本人密码和审计记录。

所有交易金额均为 `CREDIT` 积分，支付模式为 `simulated`，不是现金收付。金额在 API 和 Excel 中以字符串保留精度。

## 开发与验证

```sh
npm run build
npm test
npm run test:ui
npm run test:mishu -- /absolute/path/to/mishu-platform
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
packages/adapters   持久化模拟来源 / MiShu HTTP 只读来源
migrations          SQL 迁移
scripts             本地启动、账号初始化、备份和验收
tests               隔离环境集成测试
```

新仓库独立管理版本，每次完成改动后验证并本地提交。远程地址尚未配置，不会自动推送到 Prompt 审核仓库。
