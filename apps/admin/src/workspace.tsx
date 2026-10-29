import { useEffect, useRef, useState, type ReactNode } from "react";
import { date, money, statusNames, useResource } from "./api";
import { Icon } from "./appearance";
import "./workspace.css";
import type {
  CaseRecord,
  TradeRisk,
  Workspace as WorkspaceData,
} from "../../../packages/contracts/src/workspace";

export type WorkspaceContext = {
  user: { id: string; name: string; roles: string[] };
  app: { id: string; [key: string]: any };
  url: (path: string, extra?: Record<string, string>) => string;
  mutate: (path: string, body?: unknown) => Promise<any>;
  notify: (text: string) => void;
  openTrade?: (id: string) => void;
};
const categoryNames: Record<string, string> = {
  follow_up: "交易跟进",
  after_sales: "售后服务",
  dispute: "交易争议",
  other: "其他事项",
};
const stageNames: Record<string, string> = {
  pending: "待处理",
  in_progress: "处理中",
  waiting_customer: "待用户反馈",
  pending_review: "待核验",
  resolved: "已解决",
};
const priorityNames: Record<string, string> = {
  normal: "普通",
  high: "优先",
  urgent: "紧急",
};
const reviewNames: Record<string, string> = {
  none: "未提交核验",
  pending: "待独立核验",
  accepted: "核验通过",
  returned: "已退回补充",
};
const scopeNames = {
  all: "全部工单",
  mine: "我负责的",
  unassigned: "待领取",
  overdue: "已超时",
  review: "待核验",
};
type Scope = keyof typeof scopeNames;
const canManage = (c: WorkspaceContext) => c.user.roles.includes("operator");
const isOverdue = (item: CaseRecord) =>
  item.state === "open" &&
  !!item.due_at &&
  Date.parse(item.due_at) < Date.now();
const shortDate = (value?: string | null) =>
  value
    ? new Date(value).toLocaleDateString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
      })
    : "未设期限";
function isoFromLocal(value: string) {
  return value ? new Date(value).toISOString() : null;
}
function localFromIso(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : "操作失败，请稍后重试";
}

function Notice({ children }: { children: ReactNode }) {
  return children ? (
    <div className="ws-error" role="alert">
      {children}
    </div>
  ) : null;
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="ws-empty">
      <span className="ws-empty-mark">
        <Icon name="reviews" />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`ws-panel ${className}`}>
      <div className="ws-panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Stat({
  label,
  value,
  description,
  href,
  tone = "",
}: {
  label: string;
  value: number | string | undefined;
  description: string;
  href?: string;
  tone?: string;
}) {
  const content = (
    <>
      <span className="ws-stat-label">
        {label}
        {href && <span aria-hidden="true">↗</span>}
      </span>
      <strong>
        {value === undefined
          ? "—"
          : typeof value === "string" && value.includes(" / ")
            ? value
            : money(value)}
      </strong>
      <small>{description}</small>
    </>
  );
  return href ? (
    <a href={href} className={`ws-stat ${tone}`}>
      {content}
    </a>
  ) : (
    <div className={`ws-stat ${tone}`}>{content}</div>
  );
}
function CaseTags({ item }: { item: CaseRecord }) {
  return (
    <div className="ws-tags">
      <span className={`ws-tag stage-${item.stage}`}>
        {stageNames[item.stage] || item.stage}
      </span>
      {item.priority !== "normal" && (
        <span className={`ws-tag priority-${item.priority}`}>
          {priorityNames[item.priority]}
        </span>
      )}
      {isOverdue(item) && (
        <span className="ws-tag priority-urgent">已超时</span>
      )}
    </div>
  );
}
function CaseRows({
  items,
  onOpen,
}: {
  items: CaseRecord[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="ws-case-rows">
      {items.map((item) => (
        <button
          key={item.id}
          className="ws-case-row"
          onClick={() => onOpen(item.id)}
        >
          <span className={`ws-case-indicator priority-${item.priority}`} />
          <span className="ws-case-copy">
            <span className="ws-case-title">{item.title}</span>
            <span className="ws-case-meta">
              {categoryNames[item.category]}
              <span>·</span>
              {item.owner_name || "待领取"}
              <span>·</span>
              {item.trade_id ? `订单 ${item.trade_id}` : "未关联订单"}
            </span>
          </span>
          <span className="ws-case-end">
            <CaseTags item={item} />
            <small>
              {item.due_at ? `${shortDate(item.due_at)} 截止` : "未设期限"}
            </small>
          </span>
          <span className="ws-row-arrow" aria-hidden="true">
            ›
          </span>
        </button>
      ))}
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const items = Array.from(
        root.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ) || [],
      );
      const first = items[0],
        last = items.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === root.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <section
        ref={root}
        tabIndex={-1}
        className={`modal ws-modal ${wide ? "ws-modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function NewCase({
  c,
  category = "after_sales",
  trade,
  onClose,
  onDone,
}: {
  c: WorkspaceContext;
  category?: string;
  trade?: any;
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(
    trade ? `跟进订单：${trade.asset_title || trade.id}` : "",
  );
  const [tradeId, setTradeId] = useState(trade?.id || "");
  const [kind, setKind] = useState(category),
    [priority, setPriority] = useState("normal"),
    [due, setDue] = useState(""),
    [note, setNote] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="新建服务工单" onClose={onClose}>
      <p className="ws-form-intro">
        记录问题、关联交易并设置跟进期限。创建后可领取处理或由管理员分派。
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await c.mutate("/admin/cases", {
              application_id: c.app.id,
              title,
              trade_id: tradeId.trim() || undefined,
              category: kind,
              priority,
              due_at: isoFromLocal(due),
              note,
            });
            c.notify("工单已创建，可在队列中领取处理");
            onDone();
            onClose();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          工单标题
          <input
            required
            minLength={5}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="简要说明需要解决的问题"
          />
        </label>
        <div className="ws-form-grid">
          <label>
            问题类型
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(categoryNames).map(([v, n]) => (
                <option key={v} value={v}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            优先级
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            >
              {Object.entries(priorityNames).map(([v, n]) => (
                <option key={v} value={v}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          关联订单编号（可选）
          <input
            value={tradeId}
            maxLength={160}
            onChange={(e) => setTradeId(e.target.value)}
            placeholder="填写完整订单编号"
          />
        </label>
        <label>
          跟进截止时间（本机时间，可选）
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        <label>
          问题与当前情况
          <textarea
            required
            minLength={5}
            maxLength={2000}
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="记录用户诉求、已核实的信息和下一步安排"
          />
        </label>
        <p className="ws-form-note">
          此处保存内部工作记录，不会向买家或卖家发送消息。
        </p>
        <Notice>{error}</Notice>
        <div className="ws-form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "创建中…" : "创建工单"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CaseAction({
  c,
  item,
  onDone,
}: {
  c: WorkspaceContext;
  item: CaseRecord;
  onDone: () => void;
}) {
  const owner = item.owner_id === c.user.id,
    operator = canManage(c),
    admin = c.user.roles.includes("admin"),
    reviewer = c.user.roles.includes("approver");
  const choices: [string, string][] = [];
  if (item.stage !== "pending_review") {
    if (operator && !item.owner_id) choices.push(["claim", "领取并跟进"]);
    if (operator && (owner || !item.owner_id))
      choices.push(["note", "补充内部记录"]);
    if (operator && owner) {
      choices.push(
        ["update", "更新处理安排"],
        ["submit_review", "提交独立核验"],
      );
      if (!item.requires_review || item.review_status === "accepted")
        choices.push(["close", "解决并关闭"]);
    }
    if (admin) choices.push(["assign", "分派 / 转交负责人"]);
  }
  if (
    reviewer &&
    item.stage === "pending_review" &&
    !owner &&
    item.review_submitted_by !== c.user.id
  )
    choices.push(["review", "核验处理意见"]);
  const [selected, setSelected] = useState(choices[0]?.[0] || "note"),
    [note, setNote] = useState("");
  const action = choices.some(([key]) => key === selected)
    ? selected
    : choices[0]?.[0];
  const [category, setCategory] = useState<string>(item.category),
    [priority, setPriority] = useState<string>(item.priority),
    [stage, setStage] = useState<string>(
      ["in_progress", "waiting_customer"].includes(item.stage)
        ? item.stage
        : "in_progress",
    ),
    [due, setDue] = useState(localFromIso(item.due_at)),
    [assignee, setAssignee] = useState(item.owner_id || ""),
    [decision, setDecision] = useState("accept");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const people = useResource<{ id: string; name: string }[]>(
    admin ? c.url("/admin/case-assignees") : null,
    30000,
  );
  if (item.state !== "open")
    return (
      <div className="ws-completion">
        <Icon name="reviews" />
        <div>
          <strong>工单已解决</strong>
          <p>{item.resolution || "处理结论已保存在记录中。"}</p>
          <small>{date(item.closed_at || item.updated_at)}</small>
        </div>
      </div>
    );
  if (!choices.length)
    return (
      <p className="ws-form-note">
        {item.stage === "pending_review"
          ? "工单正在等待独立核验，核验完成后继续跟进。"
          : "当前角色可查看工单；处理与核验操作由授权人员完成。"}
      </p>
    );
  return (
    <form
      className="ws-action-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await c.mutate(`/admin/cases/${encodeURIComponent(item.id)}`, {
            action,
            note,
            ...(action === "update"
              ? { category, priority, stage, due_at: isoFromLocal(due) }
              : {}),
            ...(action === "assign" ? { owner_id: assignee } : {}),
            ...(action === "review" ? { decision } : {}),
          });
          setNote("");
          c.notify(
            action === "review"
              ? "核验结论已记录，资金操作仍需独立申请和审批"
              : "工单已更新",
          );
          onDone();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>下一步处理</h3>
      {item.requires_review && item.review_status !== "accepted" && (
        <p className="ws-form-note">争议工单须通过独立核验后才能关闭。</p>
      )}
      {item.review_status === "accepted" &&
        ["note", "update", "assign"].includes(action || "") && (
          <p className="ws-form-note">
            补充记录、修改安排或转交后，原核验结论失效，需要重新核验。
          </p>
        )}
      <label>
        处理动作
        <select
          value={action}
          onChange={(e) => {
            const next = e.target.value;
            // Refresh editable metadata when choosing an action, without
            // overwriting an in-progress draft during background polling.
            if (next === "update") {
              setCategory(item.category);
              setPriority(item.priority);
              setStage(
                item.stage === "waiting_customer"
                  ? "waiting_customer"
                  : "in_progress",
              );
              setDue(localFromIso(item.due_at));
            } else if (next === "assign") {
              setAssignee(item.owner_id || "");
            }
            setSelected(next);
            setError("");
          }}
        >
          {choices.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {action === "update" && (
        <>
          <div className="ws-form-grid">
            <label>
              问题类型
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {Object.entries(categoryNames).map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              优先级
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                {Object.entries(priorityNames).map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ws-form-grid">
            <label>
              处理阶段
              <select value={stage} onChange={(e) => setStage(e.target.value)}>
                {["in_progress", "waiting_customer"].map((v) => (
                  <option key={v} value={v}>
                    {stageNames[v]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              跟进截止时间
              <input
                type="datetime-local"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </label>
          </div>
        </>
      )}
      {action === "assign" && (
        <>
          <label>
            负责人
            <select
              value={assignee}
              required
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">选择有权限的处理人员</option>
              {people.data?.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Notice>{people.error}</Notice>
        </>
      )}
      {action === "review" && (
        <>
          <label>
            核验结论
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
            >
              <option value="accept">核验通过，交回负责人跟进</option>
              <option value="return">退回补充材料 / 说明</option>
            </select>
          </label>
          <p className="ws-form-note">
            核验用于记录处理依据，不会直接裁决订单、退款或调整积分。
          </p>
        </>
      )}
      {action === "submit_review" && (
        <p className="ws-form-note">
          请写明双方诉求、已核验事实、凭证位置和处理建议，交由另一位审核人员核验。
        </p>
      )}
      {action === "close" && (
        <p className="ws-form-note">
          请填写解决结果。存在待处理操作、结果不明或有效暂停时，工单不能关闭。
        </p>
      )}
      <label>
        {action === "close"
          ? "解决结果"
          : action === "review"
            ? "核验意见"
            : "内部记录"}
        <textarea
          value={note}
          required
          minLength={5}
          maxLength={2000}
          rows={4}
          onChange={(e) => setNote(e.target.value)}
          placeholder="至少 5 个字，请保留清楚的处理依据"
        />
      </label>
      <span className="ws-form-note">记录仅供内部协作，不会发送给用户。</span>
      <Notice>{error}</Notice>
      <div className="ws-form-actions">
        <button className="primary" disabled={busy || !action}>
          {busy ? "保存中…" : "确认并保存"}
        </button>
      </div>
    </form>
  );
}

function CaseDetail({
  c,
  id,
  onClose,
  onDone,
}: {
  c: WorkspaceContext;
  id: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const resource = useResource<CaseRecord>(
    c.url(`/admin/cases/${encodeURIComponent(id)}`),
    10000,
  );
  const item = resource.data;
  return (
    <Modal title="工单详情" onClose={onClose} wide>
      <Notice>{resource.error}</Notice>
      {!item ? (
        <p className="ws-loading">
          {resource.loading ? "正在加载工单…" : "暂时无法读取工单"}
        </p>
      ) : (
        <>
          <div className="ws-detail-heading">
            <span className="ws-eyebrow">
              {categoryNames[item.category]} · {item.id}
            </span>
            <h2>{item.title}</h2>
            <CaseTags item={item} />
          </div>
          <div className="ws-detail-grid">
            <div>
              <dl className="ws-facts">
                <div>
                  <dt>负责人</dt>
                  <dd>{item.owner_name || "待领取"}</dd>
                </div>
                <div>
                  <dt>跟进期限</dt>
                  <dd className={isOverdue(item) ? "ws-danger" : ""}>
                    {item.due_at ? date(item.due_at) : "未设置"}
                  </dd>
                </div>
                <div>
                  <dt>关联订单</dt>
                  <dd>
                    {item.trade_id ? (
                      <>
                        <code>{item.trade_id}</code>
                        <button
                          className="ws-link-button"
                          onClick={() =>
                            c.openTrade
                              ? c.openTrade(item.trade_id!)
                              : window.location.assign(
                                  `#trades?q=${encodeURIComponent(item.trade_id!)}`,
                                )
                          }
                        >
                          查看订单 ↗
                        </button>
                      </>
                    ) : (
                      "未关联"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>核验情况</dt>
                  <dd>
                    {reviewNames[item.review_status || "none"]}
                    {item.reviewer_name ? ` · ${item.reviewer_name}` : ""}
                  </dd>
                </div>
              </dl>
              <h3 className="ws-timeline-title">处理记录</h3>
              <ol className="ws-timeline">
                {item.notes?.map((note, i) => (
                  <li key={i}>
                    <div>
                      <strong>{note.actor_name || "工作记录"}</strong>
                      <time>{date(note.at)}</time>
                    </div>
                    <p>{note.note}</p>
                  </li>
                ))}
                {!item.notes?.length && (
                  <li>
                    <p>暂无处理记录</p>
                  </li>
                )}
              </ol>
            </div>
            <aside>
              <CaseAction
                c={c}
                item={item}
                onDone={() => {
                  resource.refresh();
                  onDone();
                }}
              />
            </aside>
          </div>
        </>
      )}
    </Modal>
  );
}

function useInitialScope(defaultScope: Scope): Scope {
  const get = () => {
    const s = new URLSearchParams(window.location.hash.split("?")[1] || "").get(
      "scope",
    );
    return s && s in scopeNames ? (s as Scope) : defaultScope;
  };
  const [scope, setScope] = useState(get);
  useEffect(() => {
    const change = () => setScope(get());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, [defaultScope]);
  return scope;
}

function CaseBoard({
  c,
  title = "服务工单",
  subtitle = "从受理到解决，让每个问题有人负责。",
  fixedCategory,
  defaultScope = "all",
  showCreate = true,
}: {
  c: WorkspaceContext;
  title?: string;
  subtitle?: string;
  fixedCategory?: string;
  defaultScope?: Scope;
  showCreate?: boolean;
}) {
  const initialScope = useInitialScope(defaultScope);
  const [scope, setScope] = useState<Scope>(initialScope),
    [category, setCategory] = useState(fixedCategory || ""),
    [stage, setStage] = useState(""),
    [priority, setPriority] = useState(""),
    [q, setQ] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const [creating, setCreating] = useState(
      () =>
        showCreate &&
        canManage(c) &&
        new URLSearchParams(window.location.hash.split("?")[1] || "").get(
          "create",
        ) === "1",
    ),
    [detail, setDetail] = useState<string | null>(null);
  const initialTradeId = new URLSearchParams(
    window.location.hash.split("?")[1] || "",
  ).get("trade");
  useEffect(() => {
    setScope(initialScope);
    setPage(1);
  }, [initialScope]);
  const filters: Record<string, string> = {
    scope,
    page: String(page),
    ...(category ? { category } : {}),
    ...(stage ? { stage } : {}),
    ...(priority ? { priority } : {}),
    ...(search ? { q: search } : {}),
  };
  const resource = useResource<{
    items: CaseRecord[];
    total: number;
    page: number;
    pages: number;
  }>(c.url("/admin/workspace/cases", filters), 10000);
  const changeFilter = (fn: () => void) => {
    fn();
    setPage(1);
  };
  return (
    <>
      <Panel
        title={title}
        subtitle={subtitle}
        action={
          showCreate && canManage(c) ? (
            <button className="primary" onClick={() => setCreating(true)}>
              ＋ 新建工单
            </button>
          ) : undefined
        }
      >
        <div className="ws-queue-tabs" role="group" aria-label="工单队列">
          {Object.entries(scopeNames).map(([key, name]) => (
            <button
              key={key}
              aria-pressed={scope === key}
              className={scope === key ? "active" : ""}
              onClick={() => changeFilter(() => setScope(key as Scope))}
            >
              {name}
            </button>
          ))}
        </div>
        <form
          className="ws-filters"
          onSubmit={(e) => {
            e.preventDefault();
            changeFilter(() => setSearch(q.trim()));
          }}
        >
          <input
            aria-label="搜索工单"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标题、工单或订单编号"
          />
          <button type="submit">搜索</button>
          {!fixedCategory && (
            <select
              aria-label="问题类型筛选"
              value={category}
              onChange={(e) => changeFilter(() => setCategory(e.target.value))}
            >
              <option value="">全部类型</option>
              {Object.entries(categoryNames).map(([v, n]) => (
                <option key={v} value={v}>
                  {n}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="处理阶段筛选"
            value={stage}
            onChange={(e) => changeFilter(() => setStage(e.target.value))}
          >
            <option value="">全部阶段</option>
            {Object.entries(stageNames).map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
          <select
            aria-label="优先级筛选"
            value={priority}
            onChange={(e) => changeFilter(() => setPriority(e.target.value))}
          >
            <option value="">全部优先级</option>
            {Object.entries(priorityNames).map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
        </form>
        <Notice>{resource.error}</Notice>
        {resource.loading && !resource.data ? (
          <p className="ws-loading">正在加载工单队列…</p>
        ) : resource.data?.items.length ? (
          <CaseRows items={resource.data.items} onOpen={setDetail} />
        ) : !resource.error ? (
          <Empty title="当前队列没有工单">
            可以调整筛选条件，或创建工单开始记录与跟进。
          </Empty>
        ) : null}
        <div className="ws-pagination">
          <span>共 {resource.data?.total ?? "—"} 条 · 每页 25 条</span>
          <div>
            <button
              disabled={page <= 1 || resource.loading}
              onClick={() => setPage((p) => p - 1)}
            >
              上一页
            </button>
            <span>
              {page} / {Math.max(1, resource.data?.pages || 1)}
            </span>
            <button
              disabled={page >= (resource.data?.pages || 1) || resource.loading}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </Panel>
      {creating && (
        <NewCase
          c={c}
          category={
            fixedCategory || (initialTradeId ? "follow_up" : "after_sales")
          }
          trade={initialTradeId ? { id: initialTradeId } : undefined}
          onClose={() => setCreating(false)}
          onDone={resource.refresh}
        />
      )}
      {detail && (
        <CaseDetail
          c={c}
          id={detail}
          onClose={() => setDetail(null)}
          onDone={resource.refresh}
        />
      )}
    </>
  );
}

export function WorkspaceHome({ c }: { c: WorkspaceContext }) {
  const resource = useResource<WorkspaceData>(c.url("/admin/workspace"), 10000),
    data = resource.data;
  const [detail, setDetail] = useState<string | null>(null),
    [creating, setCreating] = useState(false);
  const isAdmin = c.user.roles.includes("admin");
  const reviewOnly =
    c.user.roles.includes("approver") && !isAdmin && !canManage(c);
  const reviews = useResource<{ items: CaseRecord[]; total: number }>(
    reviewOnly ? c.url("/admin/workspace/cases", { scope: "review" }) : null,
    10000,
  );
  const priorityCases = reviewOnly
    ? reviews.data?.items.slice(0, 12)
    : data?.cases;
  const role = c.user.roles.includes("admin")
    ? "管理者"
    : c.user.roles.includes("approver")
      ? "审核人员"
      : canManage(c)
        ? "运营与客服"
        : "数据查看";
  const shortcuts = [
    {
      href: "#followups",
      icon: "submissions" as const,
      title: "运营跟进",
      note: "关注待交付、待验收与争议订单",
      roles: true,
    },
    {
      href: "#service",
      icon: "audit" as const,
      title: "客服工单",
      note: "领取问题、记录进展、跟进解决",
      roles: true,
    },
    {
      href: "#reviews",
      icon: "reviews" as const,
      title: "审核与审批",
      note: "核验处理依据，独立审批操作",
      roles: true,
    },
    {
      href: "#team",
      icon: "applications" as const,
      title: "团队管理",
      note: "查看工作量、超时与处理分布",
      roles: !!data?.capabilities.view_team,
    },
  ].filter((item) => item.roles);
  return (
    <div className="ws-page">
      <div className="ws-hero">
        <div>
          <span className="ws-eyebrow">
            {new Date().toLocaleDateString("zh-CN", {
              timeZone: "Asia/Shanghai",
              month: "long",
              day: "numeric",
              weekday: "long",
            })}{" "}
            <span> / </span> {role}工作台
          </span>
          <h2>从今天的待办开始。</h2>
          <p>
            {c.user.name}，
            {reviewOnly
              ? "核验队列由有权限人员共同处理，请先核实事实与处理依据。"
              : isAdmin
                ? "关注团队积压与处理进度，及时安排下一步。"
                : "这里汇集你负责的事项与需要团队关注的交易。"}
          </p>
        </div>
        {canManage(c) && (
          <button className="primary" onClick={() => setCreating(true)}>
            ＋ 新建服务工单
          </button>
        )}
      </div>
      <Notice>{resource.error || reviews.error}</Notice>
      <div className="ws-stat-grid">
        {reviewOnly ? (
          <>
            <Stat
              label="待核验工单"
              value={data?.summary.review}
              description="等待独立核验处理意见"
              href="#reviews"
              tone="accent"
            />
            <Stat
              label="待操作审批"
              value={data?.summary.pending_approvals}
              description="等待审批的操作申请"
              href="#reviews"
            />
            <Stat
              label="开放工单"
              value={data?.summary.open}
              description="当前应用尚未解决事项"
              href="#service"
            />
            <Stat
              label="已超时"
              value={data?.summary.overdue}
              description="超过工单跟进期限"
              href="#service?scope=overdue"
              tone={Number(data?.summary.overdue) > 0 ? "danger" : ""}
            />
          </>
        ) : (
          <>
            <Stat
              label={isAdmin ? "团队待解决" : "我负责的"}
              value={isAdmin ? data?.summary.open : data?.summary.mine}
              description={isAdmin ? "当前应用所有开放工单" : "尚未解决的工单"}
              href={isAdmin ? "#team" : "#service?scope=mine"}
              tone="accent"
            />
            <Stat
              label="待领取"
              value={data?.summary.unassigned}
              description="等待处理人员接手"
              href="#service?scope=unassigned"
            />
            <Stat
              label="已超时"
              value={data?.summary.overdue}
              description="超过工单跟进期限"
              href="#service?scope=overdue"
              tone={Number(data?.summary.overdue) > 0 ? "danger" : ""}
            />
            <Stat
              label="待核验 / 待审批"
              value={
                data
                  ? `${data.summary.review} / ${data.summary.pending_approvals}`
                  : undefined
              }
              description="处理意见 / 操作申请"
              href="#reviews"
            />
          </>
        )}
      </div>
      <div className="ws-home-grid">
        <Panel
          title={reviewOnly ? "待核验工单" : "优先处理"}
          subtitle={
            reviewOnly
              ? `当前应用核验队列，共 ${reviews.data?.total ?? "—"} 条，最多展示 12 条`
              : "个人待办优先展示，最多 12 条"
          }
          action={
            <a
              className="ws-text-link"
              href={reviewOnly ? "#reviews" : "#service?scope=mine"}
            >
              {reviewOnly ? "查看全部核验" : "查看我的工单"}{" "}
              <Icon name="arrow" />
            </a>
          }
        >
          {priorityCases?.length ? (
            <CaseRows items={priorityCases} onOpen={setDetail} />
          ) : (
            <Empty
              title={
                (reviewOnly ? reviews.loading : resource.loading)
                  ? "正在整理待办…"
                  : reviewOnly
                    ? "暂无待核验工单"
                    : "暂无待处理工单"
              }
            >
              {reviewOnly
                ? "新的核验申请会自动出现在这里。资金操作申请可在审核中心查看。"
                : "遇到需要持续跟进的问题时，建立工单并明确负责人和期限。"}
            </Empty>
          )}
        </Panel>
        <Panel
          title="工作入口"
          subtitle="按当前任务进入对应流程"
          className="ws-shortcuts"
        >
          <div>
            {shortcuts.map((item) => (
              <a key={item.href} href={item.href}>
                <span className="ws-shortcut-icon">
                  <Icon name={item.icon} />
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.note}</small>
                </span>
                <span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
        </Panel>
      </div>
      <div className="ws-focus-strip">
        <div>
          <span className="ws-eyebrow">交易关注</span>
          <h3>关注履约中的订单</h3>
          <p>基于当前订单状态筛选，状态本身不代表违规或超时。</p>
        </div>
        <a href="#followups">
          <strong>{data?.summary.awaiting_delivery ?? "—"}</strong>
          <span>待交付</span>
        </a>
        <a href="#followups">
          <strong>{data?.summary.awaiting_acceptance ?? "—"}</strong>
          <span>待验收</span>
        </a>
        <a href="#followups">
          <strong>{data?.summary.disputed_trades ?? "—"}</strong>
          <span>争议中</span>
        </a>
        <a className="ws-text-link" href="#followups">
          查看跟进清单 <Icon name="arrow" />
        </a>
      </div>
      {detail && (
        <CaseDetail
          c={c}
          id={detail}
          onClose={() => setDetail(null)}
          onDone={() => {
            resource.refresh();
            reviews.refresh();
          }}
        />
      )}
      {creating && (
        <NewCase
          c={c}
          onClose={() => setCreating(false)}
          onDone={() => {
            resource.refresh();
            reviews.refresh();
          }}
        />
      )}
    </div>
  );
}

export function OperationsWorkspace({ c }: { c: WorkspaceContext }) {
  const resource = useResource<WorkspaceData>(c.url("/admin/workspace"), 10000),
    data = resource.data;
  const [creating, setCreating] = useState<TradeRisk | null>(null);
  const [boardKey, setBoardKey] = useState(0);
  return (
    <div className="ws-page">
      <div className="ws-page-intro">
        <span className="ws-eyebrow">运营跟进</span>
        <h2>发现问题，安排跟进，推动履约。</h2>
        <p>先关注正在进行的交易，再把需要协同解决的问题变成有负责人的工单。</p>
      </div>
      <div className="ws-stat-grid ws-stat-grid-three">
        <Stat
          label="待交付订单"
          value={data?.summary.awaiting_delivery}
          description="已托管，等待卖家交付"
        />
        <Stat
          label="待验收订单"
          value={data?.summary.awaiting_acceptance}
          description="已交付，等待买家验收"
        />
        <Stat
          label="争议订单"
          value={data?.summary.disputed_trades}
          description="需要核实双方诉求"
          tone={Number(data?.summary.disputed_trades) > 0 ? "danger" : ""}
        />
      </div>
      <Panel
        title="交易关注清单"
        subtitle="最多展示 12 笔进行中订单；不把正常履约直接标记为异常"
        action={
          <a href="#trades" className="ws-text-link">
            全部订单 <Icon name="arrow" />
          </a>
        }
      >
        <Notice>{resource.error}</Notice>
        {data?.risks.length ? (
          <div className="ws-table-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>订单 / 资产</th>
                  <th>当前状态</th>
                  <th>交易积分</th>
                  <th>跟进</th>
                </tr>
              </thead>
              <tbody>
                {data.risks.map((trade) => (
                  <tr key={trade.id}>
                    <td>
                      <strong>{trade.asset_title || "未命名资产"}</strong>
                      <code>{trade.id}</code>
                    </td>
                    <td>
                      <span
                        className={`ws-tag ${trade.status === "DISPUTED" ? "priority-urgent" : ""}`}
                      >
                        {statusNames[trade.status] || trade.status}
                      </span>
                    </td>
                    <td>
                      {money(trade.price)} <small>CREDIT</small>
                    </td>
                    <td>
                      {trade.open_cases > 0 && (
                        <span className="ws-open-case-count">
                          已有 {trade.open_cases} 个跟进工单
                        </span>
                      )}
                      <div className="ws-inline-actions">
                        <button
                          onClick={() =>
                            c.openTrade
                              ? c.openTrade(trade.id)
                              : window.location.assign(
                                  `#trades?q=${encodeURIComponent(trade.id)}`,
                                )
                          }
                        >
                          查看订单
                        </button>
                        {canManage(c) && (
                          <button onClick={() => setCreating(trade)}>
                            建立跟进
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={resource.loading ? "正在读取订单…" : "目前没有进行中的订单"}
          >
            已完成交易可在经营分析中查看，后续问题可以手动创建跟进工单。
          </Empty>
        )}
      </Panel>
      <CaseBoard
        key={boardKey}
        c={c}
        title="运营跟进任务"
        subtitle="把跟进原因、负责人和处理结果留在同一条记录里"
        fixedCategory="follow_up"
      />
      <div className="ws-hint">
        <Icon name="overview" />
        <p>
          <strong>经营结果可在“经营分析”查看。</strong>{" "}
          浏览、咨询与复购路径尚未完整接入，当前不展示转化率或推断用户流失原因。
        </p>
        <a href="#overview" className="ws-text-link">
          查看分析 ↗
        </a>
      </div>
      {creating && (
        <NewCase
          c={c}
          category={creating.status === "DISPUTED" ? "dispute" : "follow_up"}
          trade={creating}
          onClose={() => setCreating(null)}
          onDone={() => {
            resource.refresh();
            setBoardKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

export function ServiceWorkspace({ c }: { c: WorkspaceContext }) {
  return (
    <div className="ws-page">
      <div className="ws-page-intro">
        <span className="ws-eyebrow">客服与争议</span>
        <h2>每个问题都有负责人和下一步。</h2>
        <p>受理诉求、核实交易、追加记录，必要时提交独立核验。</p>
      </div>
      <div className="ws-flow" aria-label="工单处理流程">
        {["受理与领取", "跟进与核实", "必要时独立核验", "记录结论并解决"].map(
          (step, index) => (
            <span key={step}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              {step}
              {index < 3 && <i aria-hidden="true">→</i>}
            </span>
          ),
        )}
      </div>
      <CaseBoard c={c} />
      <div className="ws-hint">
        <Icon name="lock" />
        <p>
          当前支持内部协作记录。用户在线咨询、证据文件上传和消息通知尚未接入，请在记录中注明已有凭证位置与沟通结果。
        </p>
      </div>
    </div>
  );
}

export function ReviewWorkspace({
  c,
  children,
}: {
  c: WorkspaceContext;
  children?: ReactNode;
}) {
  return (
    <div className="ws-page">
      <div className="ws-page-intro">
        <span className="ws-eyebrow">审核与审批</span>
        <h2>先核实处理依据，再审批执行动作。</h2>
        <p>工单核验保留调查意见；退款、补偿等操作继续经过现有独立审批流程。</p>
      </div>
      <div className="ws-review-explainer">
        <div>
          <span>01 / 工单核验</span>
          <h3>事实与处理意见</h3>
          <p>
            检查内部记录、双方诉求和凭证位置。核验通过后交回负责人继续处理；材料不足时退回补充。
          </p>
        </div>
        <div>
          <span>02 / 操作审批</span>
          <h3>对象、积分与执行条件</h3>
          <p>
            独立审批人确认具体操作。资金变动由来源系统校验执行，工单核验本身不会修改交易结果。
          </p>
        </div>
      </div>
      <CaseBoard
        c={c}
        title="待核验工单"
        subtitle="由另一名具有审核权限的人员核验；处理人不能审核自己的申请"
        defaultScope="review"
        showCreate={false}
      />
      {children && (
        <section className="ws-approval-section">
          <div className="ws-section-label">
            <span>独立操作审批</span>
            <p>沿用现有权限、身份验证、限额与执行回执。</p>
          </div>
          {children}
        </section>
      )}
    </div>
  );
}

export function TeamWorkspace({ c }: { c: WorkspaceContext }) {
  const resource = useResource<WorkspaceData>(c.url("/admin/workspace"), 10000),
    data = resource.data;
  if (data && !data.capabilities.view_team)
    return (
      <Empty title="当前角色没有团队管理查看权限">
        请联系管理员分配相应权限。
      </Empty>
    );
  return (
    <div className="ws-page">
      <div className="ws-page-intro">
        <span className="ws-eyebrow">团队管理</span>
        <h2>看清待办分布，及时调配处理力量。</h2>
        <p>关注积压、负责人和跟进期限。统计范围为当前应用中的服务工单。</p>
      </div>
      <Notice>{resource.error}</Notice>
      <div className="ws-stat-grid">
        <Stat
          label="待解决工单"
          value={data?.summary.open}
          description="所有未关闭事项"
        />
        <Stat
          label="尚未分派"
          value={data?.summary.unassigned}
          description="需要明确负责人"
          href="#service?scope=unassigned"
        />
        <Stat
          label="超时待处理"
          value={data?.summary.overdue}
          description="按工单设置的跟进期限"
          href="#service?scope=overdue"
          tone={Number(data?.summary.overdue) > 0 ? "danger" : ""}
        />
        <Stat
          label="待独立核验"
          value={data?.summary.review}
          description="等待处理意见核验"
          href="#reviews"
        />
      </div>
      <Panel
        title="人员工作量"
        subtitle="按当前负责人统计；结合事项复杂度分派，避免只按数量评估人员"
        action={
          c.user.roles.includes("admin") ? (
            <a href="#operators" className="ws-text-link">
              管理账号与权限 <Icon name="arrow" />
            </a>
          ) : undefined
        }
      >
        {data?.team.length ? (
          <div className="ws-table-scroll">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>处理人员</th>
                  <th>待解决</th>
                  <th>已超时</th>
                  <th>待核验</th>
                  <th>近 7 天解决</th>
                </tr>
              </thead>
              <tbody>
                {data.team.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <span className="ws-member">
                        <span className="ws-person-avatar">
                          {person.name?.slice(0, 1) || "员"}
                        </span>
                        <strong>{person.name}</strong>
                      </span>
                    </td>
                    <td>{person.open ?? "—"}</td>
                    <td
                      className={Number(person.overdue) > 0 ? "ws-danger" : ""}
                    >
                      {person.overdue ?? "—"}
                    </td>
                    <td>{person.review ?? "—"}</td>
                    <td>{person.closed_7d ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={
              resource.loading ? "正在汇总工作量…" : "暂无可展示的处理人员"
            }
          >
            为当前应用分配处理人员后，可在工单详情中分派与转交。
          </Empty>
        )}
      </Panel>
      <div className="ws-manager-links">
        <a href="#service?scope=overdue">
          <Icon name="audit" />
          <div>
            <strong>优先处理超时事项</strong>
            <p>检查原因，补充进展或调整负责人。</p>
          </div>
          <span>↗</span>
        </a>
        <a href="#overview">
          <Icon name="overview" />
          <div>
            <strong>查看经营分析</strong>
            <p>结合成交、退款和分账理解业务情况。</p>
          </div>
          <span>↗</span>
        </a>
      </div>
    </div>
  );
}
