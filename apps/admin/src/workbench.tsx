import { useEffect, useState } from "react";
import { date, money, useResource } from "./api";
import {
  Alert,
  Badge,
  Empty,
  Panel,
  Modal,
  ActionForm,
  type Context,
} from "./shared";
import { href, pageNumber, useQuery, previousListPage } from "./navigation";

export function Workbench({ c }: { c: Context }) {
  const r = useResource<Record<string, string | null>>(
    c.url("/admin/workbench"),
    10000,
  );
  const tasks: [string, string, string, Record<string, string>][] = [
    [
      "pending_approvals",
      "待我审批",
      "operations",
      { inbox: "approval", tab: "requests" },
    ],
    [
      "my_cases",
      "我的开放工单",
      "operations",
      { owner: "me", state: "open", tab: "cases" },
    ],
    [
      "unassigned_cases",
      "待领取工单",
      "operations",
      { owner: "unassigned", state: "open", tab: "cases" },
    ],
    [
      "unknown_results",
      "结果待确认",
      "operations",
      { inbox: "unknown", tab: "requests" },
    ],
    ["open_findings", "开放对账差异", "reconciliation", { state: "open" }],
  ];
  return (
    <Panel
      title="运营待办"
      action={<span className="caption">当前应用 · 不受图表日期筛选影响</span>}
    >
      <Alert>{r.error}</Alert>
      <div className="workbench-grid">
        {tasks
          .filter(
            ([key]) =>
              (key !== "pending_approvals" ||
                c.user.roles.includes("approver")) &&
              (key !== "my_cases" || c.user.roles.includes("operator")) &&
              r.data?.[key] !== null,
          )
          .map(([key, label, page, params]) => (
            <a
              className="workbench-card"
              key={key}
              href={href(page, c.app.id, params)}
            >
              <span>{label}</span>
              <strong>{r.data ? money(r.data[key]) : "—"}</strong>
              <small>查看待办 →</small>
            </a>
          ))}
      </div>
      <p className="caption">
        {r.data
          ? `统计于 ${date(r.data.updated_at)} · 每 10 秒更新`
          : "正在读取待办…"}
        。结果待确认时由系统查询原命令，请勿另建重复申请。
      </p>
    </Panel>
  );
}
export function WorklistPager({
  data,
  params,
  update,
}: {
  data: any;
  params: Record<string, string>;
  update: (patch: Record<string, unknown>) => void;
}) {
  const page = pageNumber(params.page),
    [jump, setJump] = useState(String(page));
  useEffect(() => setJump(String(page)), [page]);
  return (
    <div className="pagination">
      <span>
        共 {money(data?.total)} 条 ·{" "}
        {params.cursor ? "游标分页" : `第 ${page} 页`}
      </span>
      <div className="inline">
        <button
          disabled={page <= 1 && !params.cursor}
          onClick={() =>
            params.cursor
              ? previousListPage(params.app)
              : update({ page: page - 1, cursor: undefined })
          }
        >
          上一页
        </button>
        <button
          disabled={!data?.next_cursor}
          onClick={() =>
            update({ page: Math.min(1000, page + 1), cursor: data.next_cursor })
          }
        >
          下一页
        </button>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            update({ page: pageNumber(jump), cursor: undefined });
          }}
        >
          <input
            aria-label="工作列表跳转页码"
            type="number"
            min="1"
            max="1000"
            value={jump}
            onChange={(e) => setJump(e.target.value)}
          />
          <button>跳转</button>
        </form>
        <button onClick={() => update({ page: undefined, cursor: undefined })}>
          回到首页
        </button>
      </div>
    </div>
  );
}
export function Cases({ c }: { c: Context }) {
  const { params, update } = useQuery(c.app.id),
    filters = Object.fromEntries(
      ["q", "state", "owner", "trade_id", "cursor"]
        .filter((k) => params[k])
        .map((k) => [k, params[k]]),
    ),
    r = useResource<any>(
      c.url("/admin/case-worklist", {
        ...filters,
        page: String(pageNumber(params.page)),
      }),
    ),
    detail = useResource<any>(
      params.case_id
        ? c.url("/admin/cases/" + encodeURIComponent(params.case_id))
        : null,
    ),
    [q, setQ] = useState(params.q || ""),
    [state, setState] = useState(params.state || ""),
    [owner, setOwner] = useState(params.owner || ""),
    [newCase, setNewCase] = useState(false),
    [title, setTitle] = useState(""),
    [trade, setTrade] = useState(""),
    [action, setAction] = useState<{ id: string; type: string } | null>(null);
  useEffect(() => {
    setQ(params.q || "");
    setState(params.state || "");
    setOwner(params.owner || "");
  }, [params.q, params.state, params.owner]);
  const record = (x: any) => (
    <article className="operation" key={x.id}>
      <div className="record-row">
        <h3>{x.title}</h3>
        <Badge value={x.state} />
      </div>
      <p>
        <a
          className="text-button mono"
          href={href("operations", c.app.id, {
            ...params,
            tab: "cases",
            case_id: x.id,
          })}
        >
          {x.id}
        </a>
      </p>
      <p className="caption">
        关联订单{" "}
        {x.trade_id ? (
          <a
            className="text-button mono"
            href={href("trades", c.app.id, {
              q: x.trade_id,
              detail: x.trade_id,
            })}
          >
            {x.trade_id}
          </a>
        ) : (
          "无"
        )}{" "}
        · 处理人 {x.owner_name || "待领取"} · 更新 {date(x.updated_at)}
      </p>
      {(params.case_id === x.id ? x.notes : x.notes.slice(-2)).map(
        (n: any, i: number) => (
          <div className="note" key={i}>
            {n.note}
            <small>{date(n.at)}</small>
          </div>
        ),
      )}
      {x.notes.length > 2 && params.case_id !== x.id && (
        <p className="caption">共 {x.notes.length} 条记录，打开工单查看全部</p>
      )}
      {x.state === "open" && c.user.roles.includes("operator") && (
        <div className="form-actions">
          {!x.owner_id && (
            <button onClick={() => setAction({ id: x.id, type: "claim" })}>
              领取任务
            </button>
          )}
          <button onClick={() => setAction({ id: x.id, type: "note" })}>
            补充记录
          </button>
          {x.owner_id === c.user.id && (
            <button onClick={() => setAction({ id: x.id, type: "close" })}>
              关闭工单
            </button>
          )}
        </div>
      )}
    </article>
  );
  return (
    <Panel
      title="异常工单"
      action={
        c.user.roles.includes("operator") && (
          <button onClick={() => setNewCase(true)}>新建工单</button>
        )
      }
    >
      <form
        className="filter-bar"
        onSubmit={(e) => {
          e.preventDefault();
          update({
            q,
            state,
            owner,
            tab: "cases",
            page: undefined,
            cursor: undefined,
            case_id: undefined,
            trade_id: undefined,
          });
        }}
      >
        <input
          aria-label="工单搜索"
          placeholder="工单 / 订单编号，或部分工单标题"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          aria-label="工单状态"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="open">待处理</option>
          <option value="closed">已关闭</option>
        </select>
        <select
          aria-label="工单负责人"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        >
          <option value="">全部负责人</option>
          <option value="me">我领取的</option>
          <option value="unassigned">待领取</option>
        </select>
        <button className="primary">查询工单</button>
        <button
          type="button"
          onClick={() =>
            update({
              q: undefined,
              owner: undefined,
              state: undefined,
              trade_id: undefined,
              page: undefined,
              cursor: undefined,
              case_id: undefined,
            })
          }
        >
          重置
        </button>
      </form>
      <Alert>{r.error}</Alert>
      {r.data?.items.length ? (
        r.data.items.map(record)
      ) : (
        <Empty>{r.loading ? "正在读取工单…" : "没有符合条件的工单"}</Empty>
      )}
      <WorklistPager data={r.data} params={params} update={update} />
      {params.case_id && (
        <Modal title="工单详情" onClose={() => update({ case_id: undefined })}>
          <Alert>{detail.error}</Alert>
          {detail.data ? (
            record(detail.data)
          ) : (
            <Empty>{detail.loading ? "正在读取工单…" : "工单不可访问"}</Empty>
          )}
        </Modal>
      )}
      {action && (
        <ActionForm
          title={
            { claim: "领取工单", note: "补充处理记录", close: "关闭工单" }[
              action.type
            ]!
          }
          description="填写处理说明，记录将追加保存。"
          onClose={() => setAction(null)}
          onSubmit={async (note) => {
            await c.mutate("/admin/cases/" + action.id, {
              action: action.type,
              note,
            });
            r.refresh();
            detail.refresh();
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
                  required
                  minLength={5}
                  maxLength={200}
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
            const created = await c.mutate("/admin/cases", {
              application_id: c.app.id,
              title,
              trade_id: trade || undefined,
              note,
            });
            r.refresh();
            setTitle("");
            setTrade("");
            update({
              q: created.id,
              state: undefined,
              owner: undefined,
              trade_id: undefined,
              page: undefined,
              cursor: undefined,
              case_id: undefined,
            });
            c.notify("工单已创建");
          }}
        />
      )}
    </Panel>
  );
}
export function Findings({ c }: { c: Context }) {
  const { params, update } = useQuery(c.app.id),
    [q, setQ] = useState(params.q || ""),
    [state, setState] = useState(params.state || ""),
    [error, setError] = useState("");
  const filters = Object.fromEntries(
    ["q", "state", "owner", "cursor"]
      .filter((k) => params[k])
      .map((k) => [k, params[k]]),
  );
  const r = useResource<any>(
    c.url("/admin/finding-worklist", {
      ...filters,
      page: String(pageNumber(params.page)),
    }),
  );
  useEffect(() => {
    setQ(params.q || "");
    setState(params.state || "");
  }, [params.q, params.state]);
  return (
    <Panel title="差异跟进">
      <form
        className="filter-bar"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q, state, page: undefined, cursor: undefined });
        }}
      >
        <input
          aria-label="差异对象编号"
          placeholder="差异或对象完整编号"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          aria-label="差异状态"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="open">待处理</option>
          <option value="resolved">已消除</option>
        </select>
        <button>查询差异</button>
      </form>
      <Alert>{error || r.error}</Alert>
      {r.data?.items.length ? (
        r.data.items.map((f: any) => (
          <article className="operation" key={f.id}>
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
            <a
              className="text-button"
              href={href(
                "journal-transactions",
                c.app.id,
                f.rule === "account_balance"
                  ? { account_id: f.object_id }
                  : { q: f.object_id },
              )}
            >
              查关联流水
            </a>
            {f.state === "open" &&
              !f.owner_id &&
              c.user.roles.includes("operator") && (
                <button
                  onClick={async () => {
                    try {
                      await c.mutate(
                        "/admin/reconciliation-findings/" + f.id + "/claim",
                      );
                      r.refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  领取差异
                </button>
              )}
          </article>
        ))
      ) : (
        <Empty>{r.loading ? "正在读取差异…" : "暂无差异记录"}</Empty>
      )}
      <WorklistPager data={r.data} params={params} update={update} />
    </Panel>
  );
}
