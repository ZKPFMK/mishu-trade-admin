import { z } from "zod";
import type { Sql } from "../../database/src/index.js";
import { digest, insist } from "./security.js";
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Invalid calendar date");
export const filtersSchema = z
  .object({
    q: z.string().trim().max(160).default(""),
    status: z.string().max(60).default(""),
    from: day.optional(),
    to: day.optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(1200).optional(),
  })
  .strict()
  .refine(
    (f) => !f.from || !f.to || f.from <= f.to,
    "Start date must not be after end date",
  );
export type Filters = z.infer<typeof filtersSchema>;
export const datasets = [
  "trades",
  "accounts",
  "journal-transactions",
  "settlements",
  "generation-jobs",
] as const;
export type Dataset = (typeof datasets)[number];
export function querySpec(
  app: string,
  dataset: Dataset,
  filters: Filters,
  entries = false,
) {
  const tables = {
    trades: "trade_projections",
    accounts: "account_projections",
    "journal-transactions": "journal_transactions",
    settlements: "journal_transactions",
    "generation-jobs": "job_charge_summaries",
  };
  const table = tables[dataset];
  insist(table, 400, "invalid_dataset");
  const time =
    dataset === "trades"
      ? "created_at"
      : dataset === "journal-transactions" || dataset === "settlements"
        ? "occurred_at"
        : null;
  const values: unknown[] = [app],
    where = ["t.application_id=$1"];
  const add = (value: unknown) => {
    values.push(value);
    return "$" + values.length;
  };
  if (dataset === "settlements") where.push("t.kind='settle'");
  if (filters.q) {
    const p = add(filters.q);
    where.push(
      dataset === "trades"
        ? `(t.id=${p} OR t.buyer_id=${p} OR t.seller_id=${p} OR t.asset_id=${p} OR t.document->>'asset_title'=${p})`
        : dataset === "accounts"
          ? `(t.id=${p} OR t.owner_id=${p})`
          : dataset === "journal-transactions" || dataset === "settlements"
            ? `(t.id=${p} OR t.reference_id=${p})`
            : `t.id=${p}`,
    );
  }
  if (filters.status) {
    const p = add(filters.status);
    where.push(
      dataset === "trades"
        ? `t.status=${p}`
        : dataset === "accounts"
          ? `t.kind=${p}`
          : dataset === "generation-jobs"
            ? `t.document->>'status'=${p}`
            : `t.kind=${p}`,
    );
  }
  if (time && filters.from)
    where.push(
      `t.${time}>=${add(filters.from + "T00:00:00+08:00")}::timestamptz`,
    );
  if (time && filters.to)
    where.push(
      `t.${time}<${add(filters.to + "T00:00:00+08:00")}::timestamptz+interval '1 day'`,
    );
  const fingerprint = digest({
    app,
    dataset,
    q: filters.q,
    status: filters.status,
    from: filters.from,
    to: filters.to,
  });
  const baseWhere = where.join(" AND "),
    baseValues = [...values];
  if (filters.cursor) {
    let c: any;
    try {
      c = JSON.parse(Buffer.from(filters.cursor, "base64url").toString());
    } catch {
      insist(false, 400, "invalid_cursor");
    }
    insist(
      c?.fingerprint === fingerprint &&
        typeof c.id === "string" &&
        c.id.length <= 160 &&
        (!time ||
          (typeof c.time === "string" && Number.isFinite(Date.parse(c.time)))),
      400,
      "invalid_cursor",
    );
    where.push(
      time
        ? `(t.${time},t.id)<(${add(c.time)}::timestamptz,${add(c.id)})`
        : `t.id<${add(c.id)}`,
    );
  }
  return {
    table,
    time,
    where: where.join(" AND "),
    values,
    baseWhere,
    baseValues,
    fingerprint,
    order: time ? `t.${time} DESC,t.id DESC` : "t.id DESC",
  };
}
export async function listData(
  db: Sql,
  app: string,
  dataset: Dataset,
  filters: Filters,
  countTotal = true,
) {
  const spec = querySpec(app, dataset, filters);
  const count = countTotal
    ? (
        await db.query(
          `SELECT count(*)::text total FROM ${spec.table} t WHERE ${spec.baseWhere}`,
          spec.baseValues,
        )
      ).rows[0].total
    : null;
  const values = [
    ...spec.values,
    filters.limit + 1,
    filters.cursor ? 0 : (filters.page - 1) * filters.limit,
  ];
  const records = (
    await db.query(
      `SELECT t.* FROM ${spec.table} t WHERE ${spec.where} ORDER BY ${spec.order} LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
  ).rows;
  const more = records.length > filters.limit,
    visible = records.slice(0, filters.limit),
    last = visible.at(-1);
  const next =
    more && last
      ? Buffer.from(
          JSON.stringify({
            fingerprint: spec.fingerprint,
            id: last.id,
            ...(spec.time ? { time: last[spec.time].toISOString() } : {}),
          }),
        ).toString("base64url")
      : null;
  return {
    items: visible.map((r) => r.document),
    total: count,
    limit: filters.limit,
    page: filters.page,
    next_cursor: next,
    max_jump_page: 1000,
  };
}
