import React, {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Brand,
  Icon,
  ThemeToggle,
  useAppearance,
  type IconName,
} from "./appearance";
import {
  request,
  useResource,
  money,
  date,
  statusNames,
  errorText,
} from "./api";
import "./style.css";
type User = {
  id: string;
  email: string;
  name: string;
  roles: string[];
  scopes: string[];
  csrf: string;
};
type Context = {
  user: User;
  app: any;
  url: (path: string, extra?: Record<string, string>) => string;
  mutate: (path: string, body?: unknown) => Promise<any>;
  notify: (text: string) => void;
};
const pages: [string, string, IconName][] = [
  ["overview", "工作概览", "overview"],
  ["trades", "全部订单", "submissions"],
  ["accounts", "积分账户", "policies"],
  ["journal-transactions", "全部流水", "submissions"],
  ["settlements", "分账与版税", "policies"],
  ["generation-jobs", "生成扣费", "playground"],
  ["operations", "异常与审批", "reviews"],
  ["reconciliation", "对账中心", "reviews"],
  ["exports", "导出中心", "submissions"],
  ["applications", "应用接入", "applications"],
  ["operators", "操作员", "applications"],
  ["audit", "操作审计", "audit"],
];
function Badge({ value }: { value: string }) {
  return (
    <span
      className={
        "badge " +
        ([
          "COMPLETED",
          "RESOLVED_SELLER",
          "succeeded",
          "passed",
          "applied",
          "resolved",
          "settled",
        ].includes(value)
          ? "ok"
          : [
                "failed",
                "execution_failed",
                "DISPUTED",
                "differences",
                "quarantined",
              ].includes(value)
            ? "danger"
            : [
                  "pending_approval",
                  "approved",
                  "FUNDED",
                  "DELIVERED",
                  "running",
                  "blocked",
                  "execution_unknown",
                  "incomplete",
                ].includes(value)
              ? "warn"
              : "")
      }
    >
      {statusNames[value] || value}
    </span>
  );
}
function Alert({ children }: { children: ReactNode }) {
  return children ? (
    <div className="alert" role="alert">
      {children}
    </div>
  ) : null;
}
function Empty({ children = "暂无记录" }: { children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name="submissions" />
      <p>{children}</p>
    </div>
  );
}
function Panel({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-heading">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <div className="panel-heading">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭弹窗"
          >
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function ActionForm({
  title,
  description,
  label = "确认",
  onClose,
  onSubmit,
}: {
  title: string;
  description: ReactNode;
  label?: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{description}</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(reason);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          处理理由
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={5}
            maxLength={1000}
            rows={4}
            placeholder="请填写至少 5 个字，作为操作与审批依据"
          />
        </label>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "正在提交…" : label}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const appearance = useAppearance(),
    [email, setEmail] = useState("admin@trade-admin.local"),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-shell">
      <div className="login-top">
        <Brand />
        <ThemeToggle {...appearance} />
      </div>
      <div className="login-content">
        <div className="eyebrow">MISHU · TRADE CONSOLE</div>
        <h1>
          每一笔交易，
          <br />
          <span>清晰可追溯。</span>
        </h1>
        <p className="muted">
          订单、积分、分账与异常处理，
          <br />
          在独立的管理工作台中协同完成。
        </p>
        <div className="login-features">
          <span>独立部署</span>
          <span>双人审批</span>
          <span>全程留痕</span>
        </div>
      </div>
      <Panel title="登录交易管理工作台">
        <p className="muted">使用独立后台账号登录</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await request("/auth/login", {
                method: "POST",
                body: JSON.stringify({ email, password }),
              });
              onLogin();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            账号邮箱
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <Alert>{error}</Alert>
          <button className="primary full" disabled={busy}>
            {busy ? "登录中…" : "登录工作台"} <Icon name="arrow" />
          </button>
        </form>
        <p className="caption">
          本地初始化凭据位于仓库
          .local/credentials.json。首次使用后可在右上角修改密码。
        </p>
      </Panel>
      <footer>密树科技 MiShu · 交易管理</footer>
    </div>
  );
}
function Dashboard({ c }: { c: Context }) {
  const [range, setRange] = useState({ from: "", to: "" }),
    r = useResource(
      c.url(
        "/admin/overview",
        Object.fromEntries(Object.entries(range).filter(([, v]) => v)),
      ),
    );
  const d = r.data;
  return (
    <>
      <div className="section-tools">
        <p className="muted">掌握交易与积分动向</p>
        <div className="inline">
          <label className="compact-label">
            从
            <input
              aria-label="概览开始日期"
              type="date"
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
            />
          </label>
          <label className="compact-label">
            至
            <input
              aria-label="概览结束日期"
              type="date"
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
            />
          </label>
        </div>
      </div>
      <Alert>{r.error}</Alert>
      {d ? (
        <>
          <div className="stats">
            {[
              ["成交积分", d.totals.settled, "已实际结算"],
              ["退回积分", d.totals.refunded, "实际退款分录"],
              [
                "托管积分",
                d.balances.find((b: any) => b.kind === "escrow")?.balance,
                "当前托管余额",
              ],
              [
                "服务费 / 版税",
                money(d.totals.fees) + " / " + money(d.totals.royalties),
                "来源实际分账",
              ],
            ].map(([label, value, note], i) => (
              <div className="stat" key={label}>
                <div className="stat-label">
                  {label}
                  <span>◦</span>
                </div>
                <strong>{i === 3 ? value : money(value)}</strong>
                <small>{note} · CREDIT</small>
              </div>
            ))}
          </div>
          <div className="two-columns">
            <Panel
              title="成交趋势"
              action={<span className="caption">最近 14 个有成交的日期</span>}
            >
              <div className="chart">
                {d.trend.length ? (
                  d.trend.map((p: any) => {
                    const max = d.trend.reduce(
                      (v: bigint, x: any) =>
                        BigInt(x.amount) > v ? BigInt(x.amount) : v,
                      1n,
                    );
                    return (
                      <div
                        className="bar-column"
                        key={p.day}
                        title={p.day + " · " + money(p.amount) + " 积分"}
                      >
                        <span>{money(p.amount)}</span>
                        <div className="bar-track">
                          <div
                            className="bar"
                            style={{
                              height:
                                Number((BigInt(p.amount) * 100n) / max) + "%",
                            }}
                          />
                        </div>
                        <small>{p.day.slice(5)}</small>
                      </div>
                    );
                  })
                ) : (
                  <Empty />
                )}
              </div>
            </Panel>
            <Panel title="订单分布">
              <div className="status-list">
                {d.statuses.map((s: any) => (
                  <div key={s.status}>
                    <Badge value={s.status} />
                    <strong>
                      {money(s.count)} <small>笔</small>
                    </strong>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
          <Panel title="数据口径">
            <p className="muted">{d.basis}</p>
            <div className="facts">
              <span>
                计量单位<strong>CREDIT 积分</strong>
              </span>
              <span>
                支付模式<strong>模拟支付</strong>
              </span>
              <span>
                统计时区<strong>Asia/Shanghai</strong>
              </span>
              <span>
                最近应用数据
                <strong>{date(d.application.last_applied_at)}</strong>
              </span>
            </div>
          </Panel>
        </>
      ) : r.loading ? (
        <Empty>正在加载概览…</Empty>
      ) : null}
    </>
  );
}
const datasetNames: Record<string, string> = {
  trades: "订单",
  accounts: "账户",
  "journal-transactions": "流水",
  settlements: "分账",
  "generation-jobs": "生成扣费",
};
function ExportDialog({
  c,
  dataset,
  filters,
  onClose,
}: {
  c: Context;
  dataset: string;
  filters: Record<string, any>;
  onClose: () => void;
}) {
  const [format, setFormat] = useState("auto"),
    [scope, setScope] = useState("filtered"),
    [fields, setFields] = useState("summary"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={"导出" + datasetNames[dataset]} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await c.mutate("/admin/exports", {
              application_id: c.app.id,
              dataset,
              format,
              scope,
              fields,
              filters,
            });
            c.notify("导出任务已创建，可在导出中心查看进度");
            location.hash = "exports";
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          导出范围
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="filtered">所有符合当前筛选的记录</option>
            <option value="page">仅当前页</option>
          </select>
        </label>
        <label>
          文件格式
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="auto">智能选择（超过 10 万行使用压缩 JSONL）</option>
            <option value="xlsx">Excel 分包</option>
            <option value="jsonl.gz">JSONL 压缩分包</option>
          </select>
        </label>
        <label>
          字段
          <select value={fields} onChange={(e) => setFields(e.target.value)}>
            <option value="summary">摘要与完整分录</option>
            <option value="detail">包含来源明细 JSON</option>
          </select>
        </label>
        <p className="caption">
          后台生成，关闭页面后继续。每包最多 5 万行或约 32 MiB，单任务上限 2
          GiB，下载文件保留 24 小时。积分按文本导出，保留完整精度。
        </p>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <button className="primary" disabled={busy}>
            {busy ? "创建中…" : "创建导出任务"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Journal({ tx }: { tx: any }) {
  return (
    <details className="journal">
      <summary>
        <span className="mono">{tx.id}</span> <Badge value={tx.kind} />
        <span className="muted">
          {tx.entries.length} 条分录 · {date(tx.occurred_at)}
        </span>
      </summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>账户</th>
              <th>角色</th>
              <th className="numeric">积分变化</th>
            </tr>
          </thead>
          <tbody>
            {tx.entries.map((e: any) => (
              <tr key={e.id}>
                <td className="mono">{e.account_id}</td>
                <td>
                  {
                    (
                      {
                        buyer: "买家",
                        seller: "卖家",
                        fee: "平台服务费",
                        creator_royalty: "创作者版税",
                        upstream_royalty: "上游版税",
                        escrow: "托管",
                        generation: "生成扣费",
                        other: "对手账户",
                      } as any
                    )[e.role]
                  }
                </td>
                <td
                  className={
                    "numeric " + (BigInt(e.amount) > 0n ? "positive" : "")
                  }
                >
                  {BigInt(e.amount) > 0n ? "+" : ""}
                  {money(e.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caption">
        规则版本：{tx.rule_version || "历史未记录"} · 关联编号：
        {tx.reference_id} · 分录合计：
        {money(
          tx.entries.reduce((s: bigint, e: any) => s + BigInt(e.amount), 0n),
        )}{" "}
        CREDIT
      </p>
    </details>
  );
}
function Detail({
  c,
  id,
  onClose,
}: {
  c: Context;
  id: string;
  onClose: () => void;
}) {
  const r = useResource(c.url("/admin/trades/" + encodeURIComponent(id))),
    [apply, setApply] = useState(false),
    d = r.data,
    t = d?.trade;
  return (
    <Modal title="订单详情" onClose={onClose}>
      <Alert>{r.error}</Alert>
      {t ? (
        <>
          <div className="detail-hero">
            <div>
              <span className="eyebrow">
                {t.license_type === "ownership"
                  ? "资产所有权交易"
                  : "资产使用许可"}
              </span>
              <h3>{t.asset_title}</h3>
              <code>{t.id}</code>
            </div>
            <Badge value={t.status} />
          </div>
          <div className="facts">
            <span>
              交易积分<strong>{money(t.price)} CREDIT</strong>
            </span>
            <span>
              托管余额<strong>{money(d.escrow)} CREDIT</strong>
            </span>
            <span>
              买家<strong>{t.buyer_id}</strong>
            </span>
            <span>
              卖家<strong>{t.seller_id}</strong>
            </span>
            <span>
              交付核验
              <strong>{t.delivery_verified ? "已核验" : "未核验"}</strong>
            </span>
            <span>
              来源版本<strong>{t.version}</strong>
            </span>
          </div>
          <h3>状态时间线</h3>
          <ol className="timeline">
            {t.timeline.map((e: any, i: number) => (
              <li key={i}>
                <Badge value={e.status} />
                <small>{date(e.at)}</small>
                <p>{e.note}</p>
              </li>
            ))}
          </ol>
          <h3>关联记账事务</h3>
          {d.journals.map((j: any) => (
            <Journal key={j.id} tx={j} />
          ))}
          <h3>处理申请</h3>
          {d.operations.length ? (
            d.operations.map((o: any) => (
              <div className="record-row" key={o.id}>
                <code>{o.id}</code>
                <Badge value={o.state} />
              </div>
            ))
          ) : (
            <p className="muted">暂无处理申请</p>
          )}
          {c.app.source_mode === "mock" &&
            c.user.roles.includes("operator") &&
            t.status === "FUNDED" &&
            !t.delivery_verified && (
              <button className="primary" onClick={() => setApply(true)}>
                申请退回托管积分
              </button>
            )}
          {apply && (
            <ActionForm
              title="申请全额退回托管积分"
              description={
                <>
                  将申请向买家 {t.buyer_id} 退回 {money(t.price)}{" "}
                  CREDIT。绑定来源版本 {t.version}
                  ，需另一位审批人确认。申请期间交易流程继续。
                </>
              }
              label="提交申请"
              onClose={() => setApply(false)}
              onSubmit={async (reason) => {
                await c.mutate("/admin/operation-requests", {
                  application_id: c.app.id,
                  trade_id: t.id,
                  reason,
                  idempotency_key: crypto.randomUUID(),
                });
                r.refresh();
                c.notify("申请已提交，等待独立审批人确认");
              }}
            />
          )}
        </>
      ) : (
        <Empty>正在加载订单…</Empty>
      )}
    </Modal>
  );
}
function DataPage({ c, dataset }: { c: Context; dataset: string }) {
  const [draft, setDraft] = useState({ q: "", status: "", from: "", to: "" }),
    [filter, setFilter] = useState<Record<string, string>>({}),
    [page, setPage] = useState(1),
    [jump, setJump] = useState("1"),
    [cursor, setCursor] = useState<string | undefined>(),
    [history, setHistory] = useState<Array<{ page: number; cursor?: string }>>(
      [],
    ),
    [exporting, setExporting] = useState(false),
    [detail, setDetail] = useState<string | null>(null);
  const filters = {
      ...filter,
      page: String(page),
      limit: "25",
      ...(cursor ? { cursor } : {}),
    },
    r = useResource(c.url("/admin/" + dataset, filters), 10000),
    data = r.data;
  const statusOptions =
    dataset === "trades"
      ? [
          "FUNDED",
          "DELIVERED",
          "DISPUTED",
          "COMPLETED",
          "REFUNDED",
          "RESOLVED_BUYER",
          "RESOLVED_SELLER",
        ]
      : dataset === "accounts"
        ? ["user", "escrow", "generation_hold", "platform", "external"]
        : dataset === "generation-jobs"
          ? ["held", "settled", "refunded"]
          : [
              "topup",
              "grant",
              "fund",
              "settle",
              "refund",
              "generation_hold",
              "generation_settle",
              "generation_refund",
            ];
  return (
    <>
      <form
        className="filter-bar"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter(
            Object.fromEntries(Object.entries(draft).filter(([, v]) => v)),
          );
          setPage(1);
          setJump("1");
          setCursor(undefined);
          setHistory([]);
        }}
      >
        <input
          aria-label="编号搜索"
          placeholder="精确搜索编号 / 用户 / 资产"
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
        />
        <select
          aria-label="状态筛选"
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
        >
          <option value="">全部状态 / 类型</option>
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {statusNames[s]}
            </option>
          ))}
        </select>
        {!["accounts", "generation-jobs"].includes(dataset) && (
          <>
            <input
              aria-label="开始日期"
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
            <input
              aria-label="结束日期"
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </>
        )}
        <button type="submit" className="primary">
          查询
        </button>
        <button type="button" onClick={() => setExporting(true)}>
          导出记录
        </button>
      </form>
      <Alert>{r.error}</Alert>
      <Panel>
        <div className="panel-heading">
          <h2>
            {datasetNames[dataset]}记录{" "}
            <span className="count">{money(data?.total)}</span>
          </h2>
          <span className="caption">CREDIT · 模拟数据 · 每 10 秒更新</span>
        </div>
        {data?.items?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {(dataset === "trades"
                    ? [
                        "订单 / 资产",
                        "交易积分",
                        "状态",
                        "买家 / 卖家",
                        "创建时间",
                      ]
                    : dataset === "accounts"
                      ? ["账户编号", "类型", "余额（积分）", "用户", "来源版本"]
                      : dataset === "generation-jobs"
                        ? [
                            "生成任务",
                            "用户",
                            "状态",
                            "冻结 / 实扣积分",
                            "更新时间",
                          ]
                        : ["事务 / 完整分录", "关联编号", "记账时间"]
                  ).map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((row: any) => (
                  <tr key={row.id}>
                    {dataset === "trades" ? (
                      <>
                        <td>
                          <button
                            className="text-button mono"
                            onClick={() => setDetail(row.id)}
                          >
                            {row.id}
                          </button>
                          <small className="block">{row.asset_title}</small>
                        </td>
                        <td className="numeric">{money(row.price)}</td>
                        <td>
                          <Badge value={row.status} />
                        </td>
                        <td>
                          {row.buyer_id}
                          <small className="block">{row.seller_id}</small>
                        </td>
                        <td className="date-cell">{date(row.created_at)}</td>
                      </>
                    ) : dataset === "accounts" ? (
                      <>
                        <td className="mono">{row.id}</td>
                        <td>
                          <Badge value={row.kind} />
                        </td>
                        <td className="numeric">{money(row.balance)}</td>
                        <td>{row.owner_id || "—"}</td>
                        <td className="mono">{row.version}</td>
                      </>
                    ) : dataset === "generation-jobs" ? (
                      <>
                        <td className="mono">{row.id}</td>
                        <td>{row.user_id}</td>
                        <td>
                          <Badge value={row.status} />
                        </td>
                        <td>
                          {money(row.held)} / {money(row.charged)}
                        </td>
                        <td>{date(row.updated_at)}</td>
                      </>
                    ) : (
                      <>
                        <td>
                          <Journal tx={row} />
                        </td>
                        <td className="mono">{row.reference_id}</td>
                        <td className="date-cell">{date(row.occurred_at)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{r.loading ? "正在加载…" : "没有符合筛选条件的记录"}</Empty>
        )}
        <div className="pagination">
          <span>
            第 {page} 页 · 共{" "}
            {Math.max(
              1,
              Math.ceil(Number(data?.total || 0) / 25),
            ).toLocaleString()}{" "}
            页
          </span>
          <div className="inline">
            <button
              disabled={page <= 1}
              onClick={() => {
                const prev = history.at(-1);
                setHistory(history.slice(0, -1));
                setPage(prev?.page || page - 1);
                setCursor(prev?.cursor);
                setJump(String(prev?.page || page - 1));
              }}
            >
              上一页
            </button>
            <button
              disabled={!data?.next_cursor}
              onClick={() => {
                setHistory([...history, { page, cursor }]);
                setPage(page + 1);
                setJump(String(page + 1));
                setCursor(data.next_cursor);
              }}
            >
              下一页
            </button>
            <form
              className="inline"
              onSubmit={(e) => {
                e.preventDefault();
                const p = Math.max(
                  1,
                  Math.min(
                    1000,
                    Math.ceil(Number(data?.total || 0) / 25) || 1,
                    Number(jump) || 1,
                  ),
                );
                setPage(p);
                setJump(String(p));
                setCursor(undefined);
                setHistory([]);
              }}
            >
              <input
                type="number"
                min="1"
                max="1000"
                aria-label="跳转页码"
                value={jump}
                onChange={(e) => setJump(e.target.value)}
              />
              <button>跳转</button>
            </form>
          </div>
        </div>
        <p className="caption table-note">
          页码可直达前 1,000 页；后续使用下一页或日期筛选定位。
        </p>
      </Panel>
      {exporting && (
        <ExportDialog
          c={c}
          dataset={dataset}
          filters={filters}
          onClose={() => setExporting(false)}
        />
      )}{" "}
      {detail && <Detail c={c} id={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
function Operations({ c }: { c: Context }) {
  const r = useResource<any[]>(c.url("/admin/operation-requests")),
    cases = useResource<any[]>(c.url("/admin/cases")),
    [action, setAction] = useState<{
      path: string;
      title: string;
      description: string;
    } | null>(null),
    [newCase, setNewCase] = useState(false),
    [title, setTitle] = useState(""),
    [trade, setTrade] = useState("");
  return (
    <>
      <Panel
        title="托管积分退回审批"
        action={<span className="caption">申请人与审批人分离 · 自动更新</span>}
      >
        <p className="muted">
          从订单详情提交申请。仅支持尚未交付、无争议的托管订单全额退回。审批有效期
          30 分钟。
        </p>
        <Alert>{r.error}</Alert>
        {r.data?.length ? (
          r.data.map((o) => (
            <article className="operation" key={o.id}>
              <div className="record-row">
                <code>{o.trade_id}</code>
                <Badge value={o.state} />
                <strong>{money(o.command.amount)} CREDIT</strong>
              </div>
              <p>{o.reason}</p>
              <div className="caption">
                申请人 {o.requester_name} · 审批人 {o.approver_name || "待指定"}{" "}
                · 来源版本 {o.command.expected_version} · {date(o.created_at)}
              </div>
              {o.error && <Alert>{errorText(o.error)}</Alert>}
              {o.state === "succeeded" && (
                <p className="caption">
                  {o.projection_synced
                    ? "来源已执行，查询数据已同步"
                    : "来源执行成功，数据同步中"}{" "}
                  · 回执 {o.receipt?.journal_id}
                </p>
              )}
              <div className="form-actions">
                {o.state === "pending_approval" &&
                  c.user.roles.includes("approver") &&
                  o.requester_id !== c.user.id && (
                    <>
                      <button
                        className="primary"
                        onClick={() =>
                          setAction({
                            path: `/admin/operation-requests/${o.id}/approve`,
                            title: "批准退回托管积分",
                            description: `确认向 ${o.command.buyer_id} 退回 ${money(o.command.amount)} CREDIT。订单 ${o.trade_id}，版本 ${o.command.expected_version}。`,
                          })
                        }
                      >
                        审批通过
                      </button>
                      <button
                        onClick={() =>
                          setAction({
                            path: `/admin/operation-requests/${o.id}/reject`,
                            title: "拒绝申请",
                            description: "拒绝后不会执行此申请。",
                          })
                        }
                      >
                        拒绝
                      </button>
                    </>
                  )}
                {["pending_approval", "approved"].includes(o.state) &&
                  o.requester_id === c.user.id && (
                    <button
                      onClick={() =>
                        setAction({
                          path: `/admin/operation-requests/${o.id}/cancel`,
                          title: "取消申请",
                          description:
                            "取消后需要重新核验来源状态才能再次申请。",
                        })
                      }
                    >
                      取消申请
                    </button>
                  )}
              </div>
            </article>
          ))
        ) : (
          <Empty>暂无申请，可从订单详情提交</Empty>
        )}
      </Panel>
      <Panel
        title="异常工单"
        action={
          c.user.roles.includes("operator") && (
            <button onClick={() => setNewCase(true)}>新建工单</button>
          )
        }
      >
        <Alert>{cases.error}</Alert>
        {cases.data?.length ? (
          cases.data.map((x) => (
            <article className="operation" key={x.id}>
              <div className="record-row">
                <h3>{x.title}</h3>
                <Badge value={x.state} />
              </div>
              <p className="caption">
                关联订单 {x.trade_id || "无"} · 处理人{" "}
                {x.owner_name || "待领取"}
              </p>
              {x.notes.map((n: any, i: number) => (
                <div className="note" key={i}>
                  {n.note}
                  <small>{date(n.at)}</small>
                </div>
              ))}
              {x.state === "open" && c.user.roles.includes("operator") && (
                <div className="form-actions">
                  {!x.owner_id && (
                    <button
                      onClick={() =>
                        setAction({
                          path: `/admin/cases/${x.id}`,
                          title: "领取工单",
                          description: "填写处理说明，领取后可跟进并关闭工单。",
                        })
                      }
                    >
                      领取任务
                    </button>
                  )}
                  <button
                    onClick={() =>
                      setAction({
                        path: `/admin/cases/${x.id}?action=note`,
                        title: "补充处理记录",
                        description: "记录将追加保存，保留处理历史。",
                      })
                    }
                  >
                    补充记录
                  </button>
                  {x.owner_id === c.user.id && (
                    <button
                      onClick={() =>
                        setAction({
                          path: `/admin/cases/${x.id}?action=close`,
                          title: "关闭工单",
                          description:
                            "请填写处理结论。关闭工单不会修改来源账本。",
                        })
                      }
                    >
                      关闭工单
                    </button>
                  )}
                </div>
              )}
            </article>
          ))
        ) : (
          <Empty>暂无异常工单</Empty>
        )}
      </Panel>
      {action && (
        <ActionForm
          {...action}
          onClose={() => setAction(null)}
          onSubmit={async (reason) => {
            const [p, q] = action.path.split("?");
            await c.mutate(p, {
              reason,
              ...(p.startsWith("/admin/cases/")
                ? {
                    reason: undefined,
                    action: new URLSearchParams(q).get("action") || "claim",
                    note: reason,
                  }
                : {}),
            });
            r.refresh();
            cases.refresh();
            c.notify("处理记录已保存");
          }}
        />
      )}
      {newCase && (
        <ActionForm
          title="新建异常工单"
          description={
            <span className="form-stack">
              <label>
                工单标题
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  minLength={5}
                />
              </label>
              <label>
                订单编号（可选）
                <input
                  value={trade}
                  onChange={(e) => setTrade(e.target.value)}
                />
              </label>
            </span>
          }
          onClose={() => setNewCase(false)}
          onSubmit={async (note) => {
            await c.mutate("/admin/cases", {
              application_id: c.app.id,
              title,
              trade_id: trade || undefined,
              note,
            });
            cases.refresh();
            setTitle("");
            setTrade("");
            c.notify("工单已创建");
          }}
        />
      )}
    </>
  );
}
function Reconciliation({ c }: { c: Context }) {
  const runs = useResource<any[]>(c.url("/admin/reconciliation-runs")),
    findings = useResource<any[]>(c.url("/admin/reconciliation-findings")),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <>
      <Panel
        title="完整积分对账"
        action={
          c.user.roles.some((r) => ["operator", "admin"].includes(r)) && (
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await c.mutate("/admin/reconciliation-runs", {
                    application_id: c.app.id,
                  });
                  runs.refresh();
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              发起对账
            </button>
          )
        }
      >
        <p className="muted">
          在同一数据截止位置检查分录平衡、账户余额、订单托管、分账、退款关联和生成扣费。同步缺口不会被判定为通过。
        </p>
        <Alert>{error || runs.error}</Alert>
        {runs.data?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>批次</th>
                  <th>任务状态</th>
                  <th>对账结论</th>
                  <th>差异数</th>
                  <th>截止位置 / 时间</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>
                      <Badge value={r.state} />
                    </td>
                    <td>
                      {r.result?.outcome ? (
                        <Badge value={r.result.outcome} />
                      ) : (
                        errorText(r.error || "等待执行")
                      )}
                    </td>
                    <td>{r.result?.findings ?? "—"}</td>
                    <td className="date-cell">
                      <small>{r.result?.cursor || "—"}</small>
                      <br />
                      {date(r.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>尚未运行对账</Empty>
        )}
      </Panel>
      <Panel title="差异跟进">
        <Alert>{findings.error}</Alert>
        {findings.data?.length ? (
          findings.data.map((f) => (
            <div className="operation" key={f.id}>
              <div className="record-row">
                <code>{f.object_id}</code>
                <Badge value={f.state} />
              </div>
              <p>
                {f.rule} · 实际 {money(f.detail.actual)} / 应为{" "}
                {money(f.detail.expected)} CREDIT
              </p>
              <p className="caption">
                {f.resolution_note ||
                  "需要排查来源数据与同步完整性。对账不会自动补发积分。"}
              </p>
              {f.state === "open" &&
                !f.owner_id &&
                c.user.roles.includes("operator") && (
                  <button
                    onClick={async () => {
                      try {
                        await c.mutate(
                          "/admin/reconciliation-findings/" + f.id + "/claim",
                        );
                        findings.refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    领取差异
                  </button>
                )}
            </div>
          ))
        ) : (
          <Empty>暂无差异记录</Empty>
        )}
      </Panel>
    </>
  );
}
function Exports({ c }: { c: Context }) {
  const r = useResource<any[]>(c.url("/admin/exports")),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false),
    [dataset, setDataset] = useState("trades");
  return (
    <>
      <div className="section-tools">
        <p className="muted">仅显示本人任务 · 文件保留 24 小时 · 自动更新</p>
        <div className="inline">
          <select
            aria-label="导出数据类型"
            value={dataset}
            onChange={(e) => setDataset(e.target.value)}
          >
            {Object.entries(datasetNames).map(([k, n]) => (
              <option key={k} value={k}>
                {n}
              </option>
            ))}
          </select>
          <button className="primary" onClick={() => setCreating(true)}>
            新建导出
          </button>
        </div>
      </div>
      <Alert>{error || r.error}</Alert>
      <Panel>
        {r.data?.length ? (
          r.data.map((j) => (
            <article key={j.id} className="operation">
              <div className="record-row">
                <h3>{datasetNames[j.settings?.dataset]}导出</h3>
                <Badge value={j.state} />
                <span className="caption">{date(j.created_at)}</span>
              </div>
              <p className="mono caption">{j.id}</p>
              <p>
                已写入 {money(j.progress)} 行{" "}
                {j.result?.format && "· " + j.result.format}{" "}
                {j.expires_at && "· 到期 " + date(j.expires_at)}
              </p>
              {j.error && <Alert>{errorText(j.error)}</Alert>}
              <div className="downloads">
                {j.state === "succeeded" &&
                  j.result.parts?.map((p: any) => (
                    <a
                      className="button"
                      key={p.name}
                      href={`/admin/exports/${j.id}/files/${p.name}`}
                      download
                    >
                      {p.name}
                      <small>
                        {money(p.rows)} 行 · {(p.bytes / 1024).toFixed(0)} KB
                      </small>
                    </a>
                  ))}
              </div>
              <div className="form-actions">
                {[
                  "queued",
                  "running",
                  "failed",
                  "canceled",
                  "expired",
                ].includes(j.state) && (
                  <button
                    onClick={async () => {
                      try {
                        await c.mutate(
                          `/admin/exports/${j.id}/${["queued", "running"].includes(j.state) ? "cancel" : "retry"}`,
                        );
                        r.refresh();
                        setError("");
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    {["queued", "running"].includes(j.state)
                      ? "取消任务"
                      : "重新导出"}
                  </button>
                )}
              </div>
            </article>
          ))
        ) : (
          <Empty>暂无导出任务，从数据列表导出可保留当前筛选</Empty>
        )}
      </Panel>
      {creating && (
        <ExportDialog
          c={c}
          dataset={dataset}
          filters={{}}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
function Conflicts({ c }: { c: Context }) {
  const r = useResource<any[]>(c.url("/admin/event-conflicts")),
    [selected, setSelected] = useState<any>(null);
  if (!r.data?.length) return null;
  return (
    <Panel title="同编号内容冲突">
      <Alert>{r.error}</Alert>
      <p className="muted">
        原事件保持不变。请核验来源、原始摘要与冲突摘要，处理来源问题后记录结论。
      </p>
      {r.data.map((x) => (
        <div className="operation" key={x.id}>
          <div className="record-row">
            <code>{x.event_id}</code>
            <Badge value={x.resolved_at ? "已复核" : "待复核"} />
          </div>
          <p className="caption mono">
            原始 {x.original_digest}
            <br />
            冲突 {x.incoming_digest}
          </p>
          {x.resolution_note && <p>{x.resolution_note}</p>}
          {!x.resolved_at &&
            c.user.roles.some((r) => ["operator", "admin"].includes(r)) && (
              <button onClick={() => setSelected(x)}>记录复核结论</button>
            )}
        </div>
      ))}
      {selected && (
        <ActionForm
          title="记录同步冲突复核"
          description="填写核验依据。此操作不会覆盖原事件或修改来源账本；来源仍存在错误时对账仍会显示不完整。"
          onClose={() => setSelected(null)}
          onSubmit={async (reason) => {
            await c.mutate(
              "/admin/event-conflicts/" + selected.id + "/resolve",
              { reason },
            );
            r.refresh();
            c.notify("冲突复核记录已保存");
          }}
        />
      )}
    </Panel>
  );
}
function Applications({ c }: { c: Context }) {
  const events = useResource<any[]>(c.url("/admin/events")),
    imports = useResource<any[]>(c.url("/admin/imports")),
    creds = useResource<any[]>(
      c.user.roles.includes("admin") ? c.url("/admin/credentials") : null,
    ),
    [error, setError] = useState(""),
    [secret, setSecret] = useState(""),
    [label, setLabel] = useState(""),
    [purpose, setPurpose] = useState("events:write");
  async function action(path: string, body?: unknown) {
    try {
      const result = await c.mutate(path, body);
      events.refresh();
      imports.refresh();
      creds.refresh();
      setError("");
      return result;
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Panel title="接入信息">
        <div className="facts">
          <span>
            应用<strong>{c.app.name}</strong>
          </span>
          <span>
            环境
            <strong>{c.app.environment === "test" ? "测试" : "正式"}</strong>
          </span>
          <span>
            来源模式
            <strong>
              {c.app.source_mode === "mock"
                ? "独立模拟来源"
                : "MiShu HTTP · 只读"}
            </strong>
          </span>
          <span>
            初始导入<strong>{c.app.initialized ? "已完成" : "待导入"}</strong>
          </span>
          <span>
            最近来源检查<strong>{date(c.app.last_poll_at)}</strong>
          </span>
          <span>
            管理命令
            <strong>
              {c.app.source_mode === "mock"
                ? "模拟全额托管退款"
                : "关闭（只读）"}
            </strong>
          </span>
        </div>
        <p className="caption mono">
          已接收：{c.app.received_cursor || "—"}
          <br />
          已应用：{c.app.applied_cursor || "—"}
        </p>
        <Alert>{c.app.source_error ? errorText(c.app.source_error) : ""}</Alert>
        {!c.app.initialized &&
          c.user.roles.some((r) => ["operator", "admin"].includes(r)) && (
            <button
              className="primary"
              onClick={() =>
                void action("/admin/imports", { application_id: c.app.id })
              }
            >
              创建初始快照导入
            </button>
          )}
        <p className="caption">
          业务来源通过 HTTP
          接入。后台查询副本与业务记账责任分离，后台不可直接修改业务数据库。
        </p>
      </Panel>
      <Alert>{error}</Alert>
      <Panel title="导入任务">
        {imports.data?.length ? (
          imports.data.map((i) => (
            <div className="record-row" key={i.id}>
              <code>{i.id}</code>
              <Badge value={i.state} />
              <span>
                {i.result?.trades != null
                  ? `${i.result.trades} 笔订单`
                  : errorText(i.error || "等待处理")}
              </span>
            </div>
          ))
        ) : (
          <Empty>暂无导入任务</Empty>
        )}
      </Panel>
      <Panel title="增量同步事件">
        {events.data?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>事件编号</th>
                  <th>状态</th>
                  <th>原因</th>
                  <th>应用时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {events.data.map((e) => (
                  <tr key={e.event_id}>
                    <td className="mono">{e.event_id}</td>
                    <td>
                      <Badge value={e.state} />
                    </td>
                    <td>{errorText(e.error || "—")}</td>
                    <td>{date(e.applied_at)}</td>
                    <td>
                      {["quarantined", "blocked"].includes(e.state) &&
                        c.user.roles.some((r) =>
                          ["operator", "admin"].includes(r),
                        ) && (
                          <button
                            onClick={() =>
                              void action(
                                c.url("/admin/events/" + e.event_id + "/retry"),
                              )
                            }
                          >
                            重试
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>暂无增量事件，初始数据由一致性快照导入</Empty>
        )}
      </Panel>
      <Conflicts c={c} />
      {c.user.roles.includes("admin") && (
        <Panel title="服务凭证">
          <p className="caption">
            凭证按用途隔离。完整密钥只在创建时显示，请妥善保存。
          </p>
          <form
            className="filter-bar"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await action("/admin/credentials", {
                application_id: c.app.id,
                label,
                permissions: [purpose],
              });
              if (r) {
                setSecret(r.token);
                setLabel("");
              }
            }}
          >
            <input
              aria-label="凭证名称"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              placeholder="凭证名称"
            />
            <select
              aria-label="凭证用途"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            >
              <option value="events:write">发送事件</option>
              <option value="sync:read">查询同步进度</option>
              <option value="imports:write">提交初始快照</option>
            </select>
            <button>创建凭证</button>
          </form>
          {secret && (
            <div className="secret">
              <p>请保存密钥，关闭后不再显示</p>
              <code>{secret}</code>
              <button onClick={() => setSecret("")}>我已保存</button>
            </div>
          )}
          {creds.data?.map((k) => (
            <div className="record-row" key={k.id}>
              <strong>{k.label}</strong>
              <span className="caption">{k.permissions.join(", ")}</span>
              {k.revoked_at ? (
                <Badge value="已撤销" />
              ) : (
                <button
                  onClick={() =>
                    void action("/admin/credentials/" + k.id + "/revoke")
                  }
                >
                  撤销
                </button>
              )}
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}
function Operators({ c }: { c: Context }) {
  const r = useResource<any[]>("/admin/operators"),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("viewer"),
    [secret, setSecret] = useState(""),
    [error, setError] = useState("");
  const labels: Record<string, string> = {
    admin: "系统管理员",
    operator: "申请与处理",
    approver: "独立审批",
    viewer: "运营查看",
    auditor: "审计",
  };
  return (
    <Panel title="操作员与访问权限">
      <p className="muted">
        角色与应用范围独立授权。系统管理员角色不自动具备申请或审批权。新建账号仅授予当前应用。
      </p>
      <Alert>{r.error || error}</Alert>
      <form
        className="filter-bar"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const u = await c.mutate("/admin/operators", {
              name,
              email,
              roles: [role],
              scopes: [c.app.id],
            });
            setSecret(u.password);
            setError("");
            r.refresh();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <input
          aria-label="姓名"
          placeholder="姓名"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label="新账号邮箱"
          type="email"
          placeholder="账号邮箱"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          aria-label="角色"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          {Object.entries(labels).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button className="primary">创建账号</button>
      </form>
      {secret && (
        <div className="secret">
          <p>{email} 的初始密码（仅本次显示）</p>
          <code>{secret}</code>
          <button onClick={() => setSecret("")}>我已保存</button>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>角色</th>
              <th>应用范围</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {r.data?.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.name}
                  <small className="block">{u.email}</small>
                </td>
                <td>{u.roles.map((x: string) => labels[x]).join("、")}</td>
                <td className="mono">{u.scopes.join(", ")}</td>
                <td>
                  <Badge value={u.enabled ? "启用" : "停用"} />
                </td>
                <td>
                  {u.id !== c.user.id && (
                    <button
                      onClick={async () => {
                        try {
                          await c.mutate(
                            "/admin/operators/" + u.id + "/access",
                            { enabled: !u.enabled },
                          );
                          r.refresh();
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      {u.enabled ? "停用" : "启用"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
function Audit({ c }: { c: Context }) {
  const [before, setBefore] = useState(""),
    r = useResource<any[]>(
      c.url("/admin/audit-events", before ? { before } : {}),
    );
  return (
    <Panel title="追加式操作审计">
      <Alert>{r.error}</Alert>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>操作</th>
              <th>对象</th>
              <th>操作者</th>
              <th>依据</th>
            </tr>
          </thead>
          <tbody>
            {r.data?.map((a) => (
              <tr key={a.seq}>
                <td className="date-cell">{date(a.created_at)}</td>
                <td>{a.action}</td>
                <td className="mono">{a.object_id}</td>
                <td className="mono">{a.actor_id || "系统 Worker"}</td>
                <td>
                  <details>
                    <summary>查看详情</summary>
                    <pre>{JSON.stringify(a.detail, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <button disabled={!before} onClick={() => setBefore("")}>
          最新记录
        </button>
        <button
          disabled={!r.data?.length}
          onClick={() => setBefore(r.data!.at(-1).seq)}
        >
          更早记录
        </button>
      </div>
    </Panel>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [ready, setReady] = useState(false),
    [appId, setAppId] = useState(""),
    [page, setPage] = useState(location.hash.slice(1) || "overview"),
    [notice, setNotice] = useState(""),
    [password, setPassword] = useState(false),
    [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [error, setError] = useState("");
  const appearance = useAppearance(),
    apps = useResource<any[]>(user ? "/admin/applications" : null),
    app = apps.data?.find((a) => a.id === appId) || apps.data?.[0];
  const me = () => {
    void request<User>("/auth/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  };
  useEffect(() => {
    me();
    const expired = () => {
        setUser(null);
        setReady(true);
      },
      hash = () => setPage(location.hash.slice(1) || "overview");
    window.addEventListener("session-expired", expired);
    window.addEventListener("hashchange", hash);
    return () => {
      window.removeEventListener("session-expired", expired);
      window.removeEventListener("hashchange", hash);
    };
  }, []);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 6000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  if (!ready) return <Empty>正在连接工作台…</Empty>;
  if (!user) return <Login onLogin={me} />;
  const visible = pages.filter(([key]) =>
    key === "operators"
      ? user.roles.includes("admin")
      : key === "audit"
        ? user.roles.some((r) => ["admin", "auditor"].includes(r))
        : true,
  );
  const selected = visible.find((p) => p[0] === page) || visible[0];
  const c: Context = {
    user,
    app,
    url: (path, extra = {}) =>
      path +
      "?" +
      new URLSearchParams({ application_id: app?.id || "", ...extra }),
    mutate: (path, body = {}) =>
      request(path, {
        method: "POST",
        headers: { "X-CSRF-Token": user.csrf },
        body: JSON.stringify(body),
      }),
    notify: setNotice,
  };
  const content = () => {
    switch (selected[0]) {
      case "overview":
        return <Dashboard c={c} />;
      case "operations":
        return <Operations c={c} />;
      case "reconciliation":
        return <Reconciliation c={c} />;
      case "exports":
        return <Exports c={c} />;
      case "applications":
        return <Applications c={c} />;
      case "operators":
        return <Operators c={c} />;
      case "audit":
        return <Audit c={c} />;
      default:
        return <DataPage c={c} dataset={selected[0]} />;
    }
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="nav-label">交易管理</div>
        <nav>
          {visible.map(([key, label, icon]) => (
            <a
              key={key}
              href={"#" + key}
              className={selected[0] === key ? "active" : ""}
              aria-current={selected[0] === key ? "page" : undefined}
            >
              <Icon name={icon} />
              {label}
              {key === "trades" && <span className="nav-dot" />}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" /> 独立管理服务
          <small>MiShu Trade Admin · v0.1</small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="breadcrumb">MiShu / 交易管理</span>
            <h1>{selected[1]}</h1>
          </div>
          <div className="topbar-tools">
            <ThemeToggle {...appearance} />
            <button
              className="user-button"
              onClick={() => setPassword(true)}
              title="修改密码"
            >
              <span className="avatar">{user.name.slice(0, 1)}</span>
              <span>
                {user.name}
                <small>{user.email}</small>
              </span>
            </button>
            <button
              className="icon-button"
              aria-label="退出登录"
              onClick={async () => {
                await c.mutate("/auth/logout");
                setUser(null);
                setAppId("");
              }}
            >
              <Icon name="logout" />
            </button>
          </div>
        </header>
        <main>
          <div className="context-bar">
            <select
              aria-label="当前应用"
              value={app?.id || ""}
              onChange={(e) => setAppId(e.target.value)}
            >
              {apps.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.environment === "test" ? "测试" : "正式"}
                </option>
              ))}
            </select>
            <span className="badge">模拟积分</span>
            <span className="caption sync-status">
              <span
                className={
                  "status-dot " +
                  (app?.source_error ||
                  app?.pending_events ||
                  app?.conflicts ||
                  Date.now() - new Date(app?.last_poll_at || 0).getTime() >
                    15000
                    ? "warn-dot"
                    : "")
                }
              />
              {app?.source_error
                ? "来源连接异常"
                : !app?.initialized
                  ? "等待初始导入"
                  : app?.conflicts
                    ? `${app.conflicts} 个同步冲突待处理`
                    : app?.pending_events
                      ? `${app.pending_events} 个事件待应用`
                      : Date.now() -
                            new Date(app?.last_poll_at || 0).getTime() >
                          15000
                        ? "同步检查已延迟"
                        : "数据同步已连接"}{" "}
              · 最近检查 {date(app?.last_poll_at)}
            </span>
          </div>
          <Alert>{apps.error || error}</Alert>
          {app ? (
            <div key={app.id + selected[0]}>{content()}</div>
          ) : (
            <Empty>
              {apps.loading
                ? "正在加载应用…"
                : "当前账号尚未授权应用，请联系管理员"}
            </Empty>
          )}
          <footer>
            密树科技 MiShu · 积分交易管理 · 数据以来源系统记账结果为准
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          ✓ {notice}
        </div>
      )}
      {password && (
        <Modal title="修改登录密码" onClose={() => setPassword(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await c.mutate("/auth/password", { current, password: next });
                setPassword(false);
                setCurrent("");
                setNext("");
                setUser(null);
                setNotice("密码已更新，请重新登录");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label>
              当前密码
              <input
                type="password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <label>
              新密码（至少 12 位）
              <input
                type="password"
                required
                minLength={12}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <Alert>{error}</Alert>
            <button className="primary">更新密码并退出</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
