import type pg from "pg";
import { z } from "zod";
import { identifier } from "../../contracts/src/index.js";
import { transaction, type Sql } from "../../database/src/index.js";
import { type Actor, requireRole } from "./auth.js";
import { digest, insist } from "./security.js";
import { managementView } from "./management.js";
import { filtersSchema } from "./queries.js";
import { hasCapability } from "./permissions.js";

const paging = {
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(1600).optional(),
};
export const caseFilters = z
  .object({
    ...paging,
    q: z.string().trim().max(160).default(""),
    state: z.enum(["open", "closed"]).optional(),
    owner: z.enum(["me", "unassigned"]).optional(),
    trade_id: identifier.optional(),
  })
  .strict();
export const queueFilters = z
  .object({
    ...paging,
    state: z
      .enum([
        "pending_approval",
        "approved",
        "executing",
        "execution_unknown",
        "succeeded",
        "execution_failed",
        "rejected",
        "canceled",
        "expired",
      ])
      .optional(),
    inbox: z.enum(["approval", "unknown"]).optional(),
    target_id: identifier.optional(),
  })
  .strict();
export const findingFilters = z
  .object({
    ...paging,
    q: z.string().trim().max(160).default(""),
    state: z.enum(["open", "resolved"]).optional(),
    owner: z.enum(["me", "unassigned"]).optional(),
  })
  .strict();
export const auditFilters = z
  .object({
    before: z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      .refine((v) => BigInt(v) <= 9223372036854775807n)
      .optional(),
    actor_id: identifier.optional(),
    action: z.string().trim().min(1).max(100).optional(),
    object_id: identifier.optional(),
    from: filtersSchema.shape.from,
    to: filtersSchema.shape.to,
  })
  .strict()
  .refine(
    (f) => !f.from || !f.to || f.from <= f.to,
    "Start date must not be after end date",
  );

type Filter = { page: number; limit: number; cursor?: string };
// Preserve PostgreSQL microseconds: JS Date truncation can skip rows during keyset paging.
const cursorTime = (alias: string) =>
  `to_char(${alias}.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
async function pageRows(
  sql: Sql,
  table: string,
  alias: string,
  select: string,
  joins: string,
  where: string[],
  values: unknown[],
  filters: Filter,
  binding: unknown,
) {
  const fingerprint = digest(binding);
  const total = (
    await sql.query(
      `SELECT count(*)::text total FROM ${table} ${alias} WHERE ${where.join(" AND ")}`,
      values,
    )
  ).rows[0].total;
  if (filters.cursor) {
    let c: any;
    try {
      c = JSON.parse(Buffer.from(filters.cursor, "base64url").toString());
    } catch {
      insist(false, 400, "invalid_cursor");
    }
    insist(
      c?.fingerprint === fingerprint &&
        identifier.safeParse(c.id).success &&
        typeof c.time === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.time) &&
        Number.isFinite(Date.parse(c.time)) &&
        new Date(c.time).toISOString().slice(0, 19) === c.time.slice(0, 19),
      400,
      "invalid_cursor",
    );
    values.push(c.time, c.id);
    where.push(
      `(${alias}.updated_at,${alias}.id)<($${values.length - 1}::timestamptz,$${values.length})`,
    );
  }
  values.push(
    filters.limit + 1,
    filters.cursor ? 0 : (filters.page - 1) * filters.limit,
  );
  const rows = (
    await sql.query(
      `SELECT ${select},${cursorTime(alias)} cursor_time FROM ${table} ${alias} ${joins} WHERE ${where.join(" AND ")} ORDER BY ${alias}.updated_at DESC,${alias}.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
  ).rows;
  const items = rows.slice(0, filters.limit),
    last = items.at(-1);
  return {
    items: items.map(({ cursor_time, ...r }) => r),
    total,
    page: filters.page,
    limit: filters.limit,
    next_cursor:
      rows.length > filters.limit && last
        ? Buffer.from(
            JSON.stringify({
              fingerprint,
              id: last.id,
              time: last.cursor_time,
            }),
          ).toString("base64url")
        : null,
  };
}
const caseSelect = `c.*,o.name owner_name,COALESCE((SELECT jsonb_agg(jsonb_build_object('note',n.note,'at',n.created_at,'actor_id',n.actor_id) ORDER BY n.id) FROM case_notes n WHERE n.case_id=c.id),'[]') notes`;
export async function listCases(
  db: pg.Pool,
  app: string,
  user: Actor,
  f: z.infer<typeof caseFilters>,
) {
  return transaction(db, async (sql) => {
    await sql.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const values: unknown[] = [app],
      where = ["c.application_id=$1"];
    const param = (v: unknown) => {
      values.push(v);
      return "$" + values.length;
    };
    if (f.q) {
      const p = param(f.q);
      where.push(
        `(c.id=${p} OR c.trade_id=${p} OR strpos(lower(c.title),lower(${p}))>0)`,
      );
    }
    if (f.state) where.push(`c.state=${param(f.state)}`);
    if (f.owner === "me") where.push(`c.owner_id=${param(user.id)}`);
    if (f.owner === "unassigned") where.push("c.owner_id IS NULL");
    if (f.trade_id) where.push(`c.trade_id=${param(f.trade_id)}`);
    return pageRows(
      sql,
      "cases",
      "c",
      caseSelect,
      "LEFT JOIN operators o ON o.id=c.owner_id",
      where,
      values,
      f,
      {
        app,
        user: user.id,
        q: f.q,
        state: f.state,
        owner: f.owner,
        trade: f.trade_id,
        limit: f.limit,
      },
    );
  });
}
export async function caseDetail(db: pg.Pool, app: string, key: string) {
  const row = (
    await db.query(
      `SELECT ${caseSelect} FROM cases c LEFT JOIN operators o ON o.id=c.owner_id WHERE c.application_id=$1 AND c.id=$2`,
      [app, key],
    )
  ).rows[0];
  insist(row, 404, "case_not_found");
  return row;
}
export async function listFindings(
  db: pg.Pool,
  app: string,
  user: Actor,
  f: z.infer<typeof findingFilters>,
) {
  return transaction(db, async (sql) => {
    await sql.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const values: unknown[] = [app],
      where = ["f.application_id=$1"];
    if (f.state) {
      values.push(f.state);
      where.push(`f.state=$${values.length}`);
    }
    if (f.owner === "me") {
      values.push(user.id);
      where.push(`f.owner_id=$${values.length}`);
    }
    if (f.owner === "unassigned") where.push("f.owner_id IS NULL");
    if (f.q) {
      values.push(f.q);
      where.push(`(f.id=$${values.length} OR f.object_id=$${values.length})`);
    }
    return pageRows(
      sql,
      "reconciliation_findings",
      "f",
      "f.*",
      "",
      where,
      values,
      f,
      {
        app,
        user: user.id,
        q: f.q,
        state: f.state,
        owner: f.owner,
        limit: f.limit,
      },
    );
  });
}
// A legacy mock request has no request expiry; only its approved authorization expires.
// Real requests expire before approval. Do not invent a timeout for the mock workflow.
function approvalWhere(real: boolean) {
  return (
    `r.state='pending_approval' AND r.requester_id<>$2` +
    (real ? " AND r.request_expires_at>now()" : "")
  );
}
export async function listQueue(
  db: pg.Pool,
  app: string,
  user: Actor,
  f: z.infer<typeof queueFilters>,
) {
  if (f.inbox === "approval") requireRole(user, "approver");
  return transaction(db, async (sql) => {
    await sql.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const real =
      (
        await sql.query("SELECT source_mode FROM applications WHERE id=$1", [
          app,
        ])
      ).rows[0]?.source_mode === "mishu";
    const values: unknown[] = [app],
      where = ["r.application_id=$1"];
    if (f.inbox === "approval") {
      values.push(user.id);
      where.push(approvalWhere(real));
    }
    if (f.inbox === "unknown") where.push("r.state='execution_unknown'");
    if (f.state) {
      values.push(f.state);
      where.push(`r.state=$${values.length}`);
    }
    if (f.target_id) {
      values.push(f.target_id);
      where.push(`r.${real ? "target_id" : "trade_id"}=$${values.length}`);
    }
    const synced = real
      ? `CASE WHEN r.receipt->>'status'='succeeded' AND jsonb_array_length(r.receipt->'journal_ids')>0 THEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.receipt->'journal_ids') j(id) WHERE NOT EXISTS(SELECT 1 FROM journal_transactions t WHERE t.application_id=r.application_id AND t.id=j.id)) ELSE NULL END`
      : `(SELECT t.version>=(r.receipt->>'version')::bigint FROM trade_projections t WHERE t.application_id=r.application_id AND t.id=r.trade_id)`;
    const result = await pageRows(
      sql,
      real ? "management_requests" : "operation_requests",
      "r",
      `r.*,o.name requester_name,a.name approver_name,${synced} projection_synced`,
      "JOIN operators o ON o.id=r.requester_id LEFT JOIN operators a ON a.id=r.approver_id",
      where,
      values,
      f,
      {
        app,
        user: user.id,
        inbox: f.inbox,
        state: f.state,
        target: f.target_id,
        limit: f.limit,
      },
    );
    return {
      ...result,
      items: real ? result.items.map(managementView) : result.items,
    };
  });
}
export async function workbench(db: pg.Pool, app: string, user: Actor) {
  return transaction(db, async (sql) => {
    await sql.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const real =
      (
        await sql.query("SELECT source_mode FROM applications WHERE id=$1", [
          app,
        ])
      ).rows[0]?.source_mode === "mishu";
    const table = real ? "management_requests" : "operation_requests";
    const count = async (query: string, values: unknown[] = [app]) =>
      (await sql.query(query, values)).rows[0].n as string;
    return {
      pending_approvals: hasCapability(user.roles, "approval:decide")
        ? await count(
            `SELECT count(*)::text n FROM ${table} r WHERE r.application_id=$1 AND ${approvalWhere(real)}`,
            [app, user.id],
          )
        : null,
      my_cases: hasCapability(user.roles, "operations:write")
        ? await count(
            "SELECT count(*)::text n FROM cases WHERE application_id=$1 AND state='open' AND owner_id=$2",
            [app, user.id],
          )
        : null,
      unassigned_cases: hasCapability(user.roles, "operations:write")
        ? await count(
            "SELECT count(*)::text n FROM cases WHERE application_id=$1 AND state='open' AND owner_id IS NULL",
          )
        : null,
      unknown_results: hasCapability(user.roles, "operations:read")
        ? await count(
            `SELECT count(*)::text n FROM ${table} WHERE application_id=$1 AND state='execution_unknown'`,
          )
        : null,
      open_findings: hasCapability(user.roles, "reconciliation:read")
        ? await count(
            "SELECT count(*)::text n FROM reconciliation_findings WHERE application_id=$1 AND state='open'",
          )
        : null,
      updated_at: (await sql.query("SELECT now() at")).rows[0].at.toISOString(),
    };
  });
}
export async function listAudit(
  db: pg.Pool,
  app: string,
  user: Actor,
  f: z.infer<typeof auditFilters>,
) {
  requireRole(user, "auditor", "admin");
  const values: unknown[] = [app, user.id, f.before || "9223372036854775807"],
    where = [
      "(application_id=$1 OR (application_id IS NULL AND actor_id=$2))",
      "seq<$3",
    ];
  for (const field of ["actor_id", "action", "object_id"] as const)
    if (f[field]) {
      values.push(f[field]);
      where.push(`${field}=$${values.length}`);
    }
  if (f.from) {
    values.push(f.from + "T00:00:00+08:00");
    where.push(`created_at>=$${values.length}::timestamptz`);
  }
  if (f.to) {
    values.push(f.to + "T00:00:00+08:00");
    where.push(`created_at<$${values.length}::timestamptz+interval '24 hours'`);
  }
  return (
    await db.query(
      `SELECT * FROM audit_events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT 100`,
      values,
    )
  ).rows;
}
