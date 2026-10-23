import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  FinancialTotals,
  Overview as OverviewData,
  TrendPoint,
} from "../../../packages/contracts/src/analytics";
import { date, money, statusNames, useResource } from "./api";
import { Icon, type IconName } from "./appearance";
import "./overview.css";

const colors = {
  COMPLETED: "var(--chart-lime)",
  RESOLVED_SELLER: "var(--chart-violet)",
  FUNDED: "var(--chart-blue)",
  DELIVERED: "var(--chart-teal)",
  DISPUTED: "var(--chart-amber)",
  REFUNDED: "var(--chart-coral)",
  RESOLVED_BUYER: "var(--chart-pink)",
};
const licenseNames: Record<string, string> = {
  ownership: "所有权交易",
  usage: "使用许可",
  display: "展示许可",
  license: "授权许可",
};
const licenseColors: Record<string, string> = {
  ownership: "var(--chart-lime)",
  usage: "var(--chart-blue)",
  display: "var(--chart-violet)",
  license: "var(--chart-teal)",
};
const colorStyle = (color: string) =>
  ({ "--chart-color": color }) as CSSProperties;
/** Only bounded visual ratios become Numbers. Display values always retain integer precision. */
function ratio(n: string | bigint, d: string | bigint) {
  const total = BigInt(d);
  return total > 0n ? Number((BigInt(n) * 1000000n) / total) / 1000000 : 0;
}
function percent(n: string | bigint, d: string | bigint) {
  const value = BigInt(n),
    total = BigInt(d);
  if (!total) return "—";
  if (value > 0n && value * 1000n < total) return "<0.1%";
  const p = (value * 1000n + total / 2n) / total;
  return `${p / 10n}${p % 10n ? "." + (p % 10n) : ""}%`;
}
function compact(value: string | bigint) {
  const n = BigInt(value),
    absolute = n < 0n ? -n : n;
  for (const [unit, divisor] of [
    ["万亿", 1000000000000n],
    ["亿", 100000000n],
    ["万", 10000n],
  ] as const)
    if (absolute >= divisor) {
      const scaled = (absolute * 10n) / divisor;
      return `${n < 0n ? "-" : ""}${scaled / 10n}${scaled % 10n ? "." + (scaled % 10n) : ""}${unit}`;
    }
  return money(n);
}
function difference(value: string, previous: string) {
  const n = BigInt(value),
    p = BigInt(previous);
  if (n === p) return "与上期持平";
  if (!p) return "上期为 0";
  const delta = n - p,
    absolute = delta < 0n ? -delta : delta;
  return `${delta > 0n ? "↑" : "↓"} ${percent(absolute, p)} 较上期`;
}
function presetRange(days: number) {
  const now = new Date(Date.now() + 8 * 3600000),
    to = now.toISOString().slice(0, 10);
  return {
    from: new Date(Date.parse(to + "T00:00:00Z") - (days - 1) * 86400000)
      .toISOString()
      .slice(0, 10),
    to,
  };
}
function Card({
  title,
  note,
  action,
  children,
  className = "",
}: {
  title: string;
  note?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"analytics-card " + className}>
      <div className="analytics-card-head">
        <div>
          <h2>{title}</h2>
          {note && <p>{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function NoData({ children = "所选时间内暂无数据" }: { children?: ReactNode }) {
  return (
    <div className="analytics-empty">
      <Icon name="overview" />
      <span>{children}</span>
    </div>
  );
}
function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly (readonly [T, string])[];
}) {
  return (
    <div className="analytics-segmented" role="group" aria-label={label}>
      {options.map(([key, name]) => (
        <button
          key={key}
          type="button"
          aria-pressed={key === value}
          onClick={() => onChange(key)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
function Metric({
  title,
  value,
  note,
  icon,
  color,
  previous,
  comparison,
}: {
  title: string;
  value: string;
  note: string;
  icon: IconName;
  color: string;
  previous?: string;
  comparison: OverviewData["comparison"];
}) {
  return (
    <article className="analytics-metric" style={colorStyle(color)}>
      <div className="analytics-metric-label">
        <span>{title}</span>
        <span className="analytics-metric-icon">
          <Icon name={icon} />
        </span>
      </div>
      <strong
        title={money(value) + " CREDIT"}
        aria-label={title + " " + money(value) + " 积分"}
      >
        {value.length > 9 ? compact(value) : money(value)}
      </strong>
      <div className="analytics-metric-bottom">
        <small>{note} · CREDIT</small>
        {previous !== undefined && comparison && (
          <span
            title={`${comparison.from} 至 ${comparison.to}：${money(previous)} 积分`}
          >
            {difference(value, previous)}
          </span>
        )}
      </div>
    </article>
  );
}

function OrderDonut({ d }: { d: OverviewData }) {
  const [metric, setMetric] = useState<"count" | "amount">("count"),
    [selected, setSelected] = useState<string | null>(null),
    [hovered, setHovered] = useState<string | null>(null);
  const total = BigInt(d.orders[metric]),
    active = d.statuses.find((s) => s.status === (hovered || selected)),
    circumference = 2 * Math.PI * 78;
  let offset = 0;
  const completed = d.statuses
    .filter((s) => ["COMPLETED", "RESOLVED_SELLER"].includes(s.status))
    .reduce((n, s) => n + BigInt(s.count), 0n);
  return (
    <Card
      title="订单分布"
      note="所选时段下单的订单 · 当前状态"
      action={
        <Segmented
          label="订单分布统计方式"
          value={metric}
          onChange={setMetric}
          options={[
            ["count", "按笔数"],
            ["amount", "按积分"],
          ]}
        />
      }
    >
      <div className="order-donut-layout">
        <div className="order-donut">
          <svg
            viewBox="0 0 200 200"
            role="img"
            aria-label={
              "订单状态环形图，共 " +
              money(total) +
              (metric === "count" ? " 笔" : " 积分")
            }
          >
            <circle
              cx="100"
              cy="100"
              r="78"
              fill="none"
              stroke="var(--color-line)"
              strokeWidth="22"
            />
            {d.statuses.map((s) => {
              const length = ratio(s[metric], total) * circumference,
                start = offset;
              offset += length;
              const color =
                colors[s.status as keyof typeof colors] ||
                "var(--color-ink-faint)";
              return (
                <circle
                  key={s.status}
                  cx="100"
                  cy="100"
                  r="78"
                  fill="none"
                  stroke={color}
                  strokeWidth={active?.status === s.status ? 26 : 22}
                  strokeDasharray={`${Math.max(0, length - (d.statuses.length > 1 ? 2 : 0))} ${circumference}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 100 100)"
                  opacity={active && active.status !== s.status ? 0.25 : 1}
                  onMouseEnter={() => setHovered(s.status)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <title>
                    {statusNames[s.status]}：{money(s[metric])}（
                    {percent(s[metric], total)}）
                  </title>
                </circle>
              );
            })}
          </svg>
          <div className="order-donut-center">
            <small>
              {active
                ? statusNames[active.status]
                : metric === "count"
                  ? "订单总数"
                  : "订单总积分"}
            </small>
            <strong title={money(active?.[metric] || total)}>
              {compact(active?.[metric] || total)}
            </strong>
            <span>
              {active
                ? percent(active[metric], total) + " 占比"
                : metric === "count"
                  ? "笔订单"
                  : "CREDIT"}
            </span>
          </div>
        </div>
        <div className="donut-legend" aria-label="订单分布图例">
          {d.statuses.length ? (
            d.statuses.map((s) => (
              <button
                key={s.status}
                type="button"
                aria-pressed={selected === s.status}
                onClick={() =>
                  setSelected(selected === s.status ? null : s.status)
                }
                onMouseEnter={() => setHovered(s.status)}
                onMouseLeave={() => setHovered(null)}
                style={colorStyle(
                  colors[s.status as keyof typeof colors] ||
                    "var(--color-ink-faint)",
                )}
              >
                <span className="chart-dot" />
                <span className="donut-legend-name">
                  {statusNames[s.status] || s.status}
                </span>
                <strong title={money(s[metric])}>{compact(s[metric])}</strong>
                <small>{percent(s[metric], total)}</small>
              </button>
            ))
          ) : (
            <p className="muted">暂无订单</p>
          )}
        </div>
      </div>
      <div className="analytics-card-summary">
        <span>
          完成占比<strong>{percent(completed, d.orders.count)}</strong>
        </span>
        <span>
          参与买家<strong>{money(d.orders.buyers)}</strong>
        </span>
        <span>
          参与卖家<strong>{money(d.orders.sellers)}</strong>
        </span>
      </div>
    </Card>
  );
}

function Trend({ d }: { d: OverviewData }) {
  const [metric, setMetric] = useState<"amount" | "count">("amount"),
    [position, setPosition] = useState<number | null>(null),
    [width, setWidth] = useState(640);
  const container = useRef<HTMLDivElement>(null),
    gradient = useId().replace(/:/g, "");
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(240, Math.round(entries[0].contentRect.width))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const series: { key: keyof TrendPoint; name: string; color: string }[] =
    metric === "amount"
      ? [
          { key: "settled", name: "成交积分", color: "var(--chart-lime)" },
          { key: "refunded", name: "退回积分", color: "var(--chart-coral)" },
        ]
      : [
          { key: "orders", name: "新增订单", color: "var(--chart-blue)" },
          {
            key: "settled_count",
            name: "结算笔数",
            color: "var(--chart-lime)",
          },
          {
            key: "refund_count",
            name: "退款笔数",
            color: "var(--chart-coral)",
          },
        ];
  const rawMax = d.trend.reduce(
      (n, p) =>
        series.reduce(
          (v, s) => (BigInt(p[s.key]) > v ? BigInt(p[s.key]) : v),
          n,
        ),
      0n,
    ),
    max = rawMax ? ((rawMax + 3n) / 4n) * 4n : 4n;
  const left = 52,
    right = 14,
    top = 24,
    bottom = 222,
    plotWidth = width - left - right,
    at = Math.max(
      0,
      Math.min(position ?? d.trend.length - 1, d.trend.length - 1),
    );
  const x = (i: number) =>
      left +
      (d.trend.length === 1
        ? plotWidth / 2
        : (i / (d.trend.length - 1)) * plotWidth),
    y = (v: string | bigint) => bottom - ratio(v, max) * (bottom - top),
    point = d.trend[at];
  const line = (key: keyof TrendPoint) =>
    d.trend.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p[key])}`).join(" ");
  const labels = [
    ...new Set(
      Array.from(
        { length: Math.min(width < 450 ? 3 : 6, d.trend.length) },
        (_, i) =>
          Math.round(
            (i * (d.trend.length - 1)) /
              (Math.min(width < 450 ? 3 : 6, d.trend.length) - 1 || 1),
          ),
      ),
    ),
  ];
  return (
    <Card
      title="交易趋势"
      note={`${d.range.from} — ${d.range.to} · ${d.range.bucket_days === 1 ? "按天" : `每 ${d.range.bucket_days} 天`}汇总`}
      className="trend-card"
      action={
        <Segmented
          label="交易趋势指标"
          value={metric}
          onChange={(v) => {
            setMetric(v);
            setPosition(null);
          }}
          options={[
            ["amount", "积分"],
            ["count", "笔数"],
          ]}
        />
      }
    >
      <div className="trend-readout">
        <span>
          {point?.day === point?.to
            ? point?.day
            : `${point?.day} ~ ${point?.to}`}
        </span>
        <div>
          {series.map((s) => (
            <span key={s.key} style={colorStyle(s.color)}>
              <i className="chart-dot" />
              {s.name}
              <strong>{money(point?.[s.key] || "0")}</strong>
            </span>
          ))}
        </div>
      </div>
      <div ref={container} className="trend-plot">
        <svg
          viewBox={`0 0 ${width} 258`}
          role="img"
          aria-label={`交易趋势${metric === "amount" ? "积分" : "笔数"}图，左右方向键查看日期`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              setPosition(
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? d.trend.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          d.trend.length - 1,
                          at + (e.key === "ArrowLeft" ? -1 : 1),
                        ),
                      ),
              );
            }
          }}
          onPointerMove={(e) => {
            const bounds = e.currentTarget.getBoundingClientRect(),
              px = ((e.clientX - bounds.left) * width) / bounds.width;
            setPosition(
              Math.max(
                0,
                Math.min(
                  d.trend.length - 1,
                  Math.round(((px - left) / plotWidth) * (d.trend.length - 1)),
                ),
              ),
            );
          }}
          onPointerLeave={() => setPosition(null)}
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series[0].color} stopOpacity=".18" />
              <stop
                offset="100%"
                stopColor={series[0].color}
                stopOpacity=".01"
              />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line
                x1={left}
                x2={width - right}
                y1={y((max * BigInt(i)) / 4n)}
                y2={y((max * BigInt(i)) / 4n)}
                className="chart-grid-line"
              />
              <text
                x={left - 10}
                y={y((max * BigInt(i)) / 4n) + 4}
                textAnchor="end"
                className="chart-axis-label"
              >
                {compact((max * BigInt(i)) / 4n)}
              </text>
            </g>
          ))}
          {rawMax > 0n && (
            <path
              d={`${line(series[0].key)} L${x(d.trend.length - 1)},${bottom} L${x(0)},${bottom} Z`}
              fill={`url(#${gradient})`}
            />
          )}
          {series.map((s) => (
            <path
              key={s.key}
              d={line(s.key)}
              fill="none"
              stroke={s.color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          <line
            x1={x(at)}
            x2={x(at)}
            y1={top}
            y2={bottom}
            className="chart-cursor-line"
          />
          {series.map((s) => (
            <circle
              key={s.key}
              cx={x(at)}
              cy={y(point?.[s.key] || "0")}
              r="4"
              fill={s.color}
              stroke="var(--color-panel)"
              strokeWidth="2"
            />
          ))}
          {labels.map((i) => (
            <text
              key={i}
              x={x(i)}
              y="249"
              textAnchor={
                i === 0 ? "start" : i === d.trend.length - 1 ? "end" : "middle"
              }
              className="chart-axis-label"
            >
              {d.range.days > 365 ? d.trend[i].day : d.trend[i].day.slice(5)}
            </text>
          ))}
        </svg>
        {rawMax === 0n && (
          <div className="trend-no-data">
            所选时段暂无{metric === "amount" ? "成交或退款" : "订单活动"}
          </div>
        )}
      </div>
      <details className="analytics-data-table">
        <summary>
          查看趋势数据 <span>包含无交易日期</span>
        </summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>日期 / 时段</th>
                {series.map((s) => (
                  <th key={s.key}>{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.trend.map((p) => (
                <tr key={p.day}>
                  <td>
                    {p.day}
                    {p.to !== p.day ? " ~ " + p.to : ""}
                  </td>
                  {series.map((s) => (
                    <td key={s.key}>{money(p[s.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

function DistributionBar({
  name,
  value,
  total,
  color,
  sub,
}: {
  name: string;
  value: string;
  total: string | bigint;
  color: string;
  sub?: string;
}) {
  return (
    <div className="distribution-bar" style={colorStyle(color)}>
      <div>
        <span>
          <i className="chart-dot" />
          {name}
        </span>
        <strong>
          {money(value)}
          <small>{percent(value, total)}</small>
        </strong>
      </div>
      <div className="distribution-track">
        <span style={{ width: `${ratio(value, total) * 100}%` }} />
      </div>
      {sub && <small>{sub}</small>}
    </div>
  );
}
function Payout({ d }: { d: OverviewData }) {
  const items: [string, keyof FinancialTotals, string][] = [
    ["卖家到账", "seller_income", "var(--chart-lime)"],
    ["平台服务费", "fees", "var(--chart-blue)"],
    ["作者版税", "creator_royalties", "var(--chart-violet)"],
    ["上游版税", "upstream_royalties", "var(--chart-teal)"],
  ];
  return (
    <Card title="实际分账构成" note="按结算流水统计 · CREDIT">
      <div className="analytics-emphasis">
        <strong title={money(d.totals.settled)}>
          {compact(d.totals.settled)}
        </strong>
        <span>成交积分的分配</span>
      </div>
      {BigInt(d.totals.settled) ? (
        <>
          <div
            className="payout-stack"
            role="img"
            aria-label="结算积分分配比例"
          >
            {items.map(([name, key, color]) => (
              <span
                key={key}
                style={{
                  width: `${ratio(d.totals[key], d.totals.settled) * 100}%`,
                  background: color,
                }}
                title={name + " " + money(d.totals[key]) + " 积分"}
              />
            ))}
          </div>
          <div className="payout-legend">
            {items.map(([name, key, color]) => (
              <div key={key} style={colorStyle(color)}>
                <i className="chart-dot" />
                <span>{name}</span>
                <strong>{money(d.totals[key])}</strong>
                <small>{percent(d.totals[key], d.totals.settled)}</small>
              </div>
            ))}
          </div>
        </>
      ) : (
        <NoData>结算后展示实际分账</NoData>
      )}
      <p className="analytics-footnote">
        版税按实际分录计入，支持作者及上游分成。
      </p>
    </Card>
  );
}
function LicenseDistribution({ d }: { d: OverviewData }) {
  const [metric, setMetric] = useState<"count" | "amount">("count");
  return (
    <Card
      title="交易类型分析"
      note="按下单时间筛选"
      action={
        <Segmented
          label="交易类型统计方式"
          value={metric}
          onChange={setMetric}
          options={[
            ["count", "笔数"],
            ["amount", "积分"],
          ]}
        />
      }
    >
      <div className="license-bars">
        {d.licenses.length ? (
          d.licenses.map((l) => (
            <DistributionBar
              key={l.type}
              name={licenseNames[l.type] || l.type}
              value={l[metric]}
              total={d.orders[metric]}
              color={licenseColors[l.type] || "var(--chart-blue)"}
              sub={
                metric === "count"
                  ? `${money(l.amount)} 订单积分`
                  : `${money(l.count)} 笔订单`
              }
            />
          ))
        ) : (
          <NoData />
        )}
      </div>
      <p className="analytics-footnote">
        涵盖当前全部订单状态，订单积分按订单原价统计。
      </p>
    </Card>
  );
}
function AssetRanking({ d }: { d: OverviewData }) {
  return (
    <Card
      title="作品成交排行"
      note="按实际结算积分排序"
      action={<span className="analytics-tag">TOP 6</span>}
    >
      <div className="asset-ranking">
        {d.top_assets.length ? (
          d.top_assets.map((a, i) => (
            <div key={a.asset_id} className="asset-rank-row">
              <span className={"asset-rank " + (i === 0 ? "first" : "")}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="asset-rank-detail">
                <div>
                  <span title={a.title + " · " + a.asset_id}>
                    {a.title || a.asset_id}
                  </span>
                  <strong title={money(a.amount) + " 积分"}>
                    {compact(a.amount)}
                  </strong>
                </div>
                <div className="asset-rank-bottom">
                  <span>{money(a.count)} 笔结算</span>
                  <div className="distribution-track">
                    <span
                      style={{
                        width: `${ratio(a.amount, d.top_assets[0].amount) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))
        ) : (
          <NoData>结算后展示作品排行</NoData>
        )}
      </div>
    </Card>
  );
}

export function Dashboard({
  c,
}: {
  c: {
    app: { id: string };
    url: (path: string, extra?: Record<string, string>) => string;
  };
}) {
  const [range, setRange] = useState(presetRange(30)),
    [draft, setDraft] = useState(range),
    [preset, setPreset] = useState("30"),
    [validation, setValidation] = useState("");
  const r = useResource<OverviewData>(
      c.url(
        "/admin/overview",
        Object.fromEntries(Object.entries(range).filter(([, v]) => v)),
      ),
      10000,
    ),
    d = r.data;
  return (
    <div className="analytics-dashboard">
      <div className="analytics-toolbar">
        <div>
          <span className="analytics-eyebrow">交易数据分析</span>
          <p>从订单状态到积分流向，了解平台经营情况</p>
        </div>
        <div className="analytics-date-tools">
          <Segmented
            label="统计时间范围"
            value={preset}
            onChange={(v) => {
              const next =
                v === "all" ? { from: "", to: "" } : presetRange(Number(v));
              setPreset(v);
              setRange(next);
              setDraft(next);
              setValidation("");
            }}
            options={[
              ["7", "近 7 天"],
              ["30", "近 30 天"],
              ["90", "近 90 天"],
              ["all", "全部"],
            ]}
          />
          <form
            className="analytics-custom-range"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.from && draft.to && draft.from > draft.to) {
                setValidation("开始日期不能晚于结束日期");
                return;
              }
              setValidation("");
              setRange(draft);
              setPreset("custom");
            }}
          >
            <input
              type="date"
              aria-label="概览开始日期"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
            <span>—</span>
            <input
              type="date"
              aria-label="概览结束日期"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
            <button type="submit" aria-label="应用日期筛选">
              <Icon name="arrow" />
            </button>
          </form>
        </div>
      </div>
      {(validation || r.error) && (
        <div role="alert" className="alert">
          {validation || r.error}
        </div>
      )}
      {d ? (
        <>
          <div className="analytics-metrics">
            <Metric
              title="成交积分"
              value={d.totals.settled}
              note="已实际结算"
              icon="overview"
              color="var(--chart-lime)"
              previous={d.comparison?.totals.settled}
              comparison={d.comparison}
            />
            <Metric
              title="退回积分"
              value={d.totals.refunded}
              note="实际退款分录"
              icon="refresh"
              color="var(--chart-coral)"
              previous={d.comparison?.totals.refunded}
              comparison={d.comparison}
            />
            <Metric
              title="托管积分"
              value={
                d.balances.find((b) => b.kind === "escrow")?.balance || "0"
              }
              note="当前订单托管余额"
              icon="reviews"
              color="var(--chart-blue)"
              comparison={null}
            />
            <Metric
              title="平台服务费"
              value={d.totals.fees}
              note="实际结算收入"
              icon="policies"
              color="var(--chart-violet)"
              previous={d.comparison?.totals.fees}
              comparison={d.comparison}
            />
          </div>
          <div className="analytics-main-grid">
            <Trend d={d} />
            <OrderDonut d={d} />
          </div>
          <div className="analytics-detail-grid">
            <Payout d={d} />
            <LicenseDistribution d={d} />
            <AssetRanking d={d} />
          </div>
          <Card
            title="当前积分分布"
            note="同步截止时点的余额快照 · 不随日期筛选变化"
            action={<span className="analytics-tag">CREDIT</span>}
          >
            <div className="balance-snapshot">
              {[
                ["user", "用户可用积分", "var(--chart-lime)"],
                ["escrow", "订单托管", "var(--chart-blue)"],
                ["generation_hold", "生成任务冻结", "var(--chart-violet)"],
                ["license_escrow", "许可报价托管", "var(--chart-teal)"],
                ["lookup_hold", "私密检索冻结", "var(--chart-amber)"],
              ].map(([kind, label, color]) => {
                const balance =
                  d.balances.find((b) => b.kind === kind)?.balance || "0";
                return (
                  <div key={kind} style={colorStyle(color)}>
                    <span>
                      <i className="chart-dot" />
                      {label}
                    </span>
                    <strong title={money(balance)}>{compact(balance)}</strong>
                  </div>
                );
              })}
            </div>
          </Card>
          <details className="analytics-basis">
            <summary>
              <Icon name="audit" />
              统计口径与同步信息<span>每 10 秒自动更新</span>
            </summary>
            <p>{d.basis}</p>
            <div>
              <span>
                统计时区 <strong>{d.timezone}</strong>
              </span>
              <span>
                最近应用数据{" "}
                <strong>{date(d.application.last_applied_at)}</strong>
              </span>
              <span>
                支付模式 <strong>模拟积分支付</strong>
              </span>
              {d.comparison && (
                <span>
                  对比时段{" "}
                  <strong>
                    {d.comparison.from} — {d.comparison.to}
                  </strong>
                </span>
              )}
            </div>
          </details>
        </>
      ) : r.loading ? (
        <div className="analytics-loading" role="status">
          <div />
          <div />
          <div />
          <div />
          <span>正在汇总交易数据…</span>
        </div>
      ) : null}
    </div>
  );
}
