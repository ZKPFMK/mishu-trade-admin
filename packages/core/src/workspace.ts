import type pg from "pg";
import { z } from "zod";
import { transaction, type Sql } from "../../database/src/index.js";
import {
  caseAction,
  caseCreate,
  caseFilters,
  type Workspace,
} from "../../contracts/src/workspace.js";
import { requireRole, requireScope, type Actor } from "./auth.js";
import { audit } from "./audit.js";
import { id, insist } from "./security.js";
import { activeManagement } from "./management.js";
import { sourceAdapter } from "../../adapters/src/index.js";
import type { Config } from "./config.js";

export const readerRoles = [
  "viewer",
  "operator",
  "approver",
  "auditor",
  "admin",
];
export const caseSelect = `SELECT c.*,o.name owner_name,r.name reviewer_name,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('note',n.note,'at',n.created_at,'actor_id',n.actor_id,'actor_name',a.name,'event',n.event) ORDER BY n.id)
 FROM case_notes n LEFT JOIN operators a ON a.id=n.actor_id WHERE n.case_id=c.id),'[]') notes
 FROM cases c LEFT JOIN operators o ON o.id=c.owner_id LEFT JOIN operators r ON r.id=c.reviewer_id`;
const queueOrder = `CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,c.due_at NULLS LAST,c.updated_at DESC,c.id`;
function canRead(user: Actor, app: string) {
  requireRole(user, ...readerRoles);
  requireScope(user, app);
}
export async function caseDetail(
  db: pg.Pool,
  user: Actor,
  key: string,
  applicationId?: string,
) {
  const row = (await db.query(caseSelect + " WHERE c.id=$1", [key])).rows[0];
  insist(row, 404, "case_not_found");
  canRead(user, row.application_id);
  if (applicationId) {
    requireScope(user, applicationId);
    insist(
      row.application_id === applicationId,
      403,
      "case_application_mismatch",
    );
  }
  return row;
}
export async function listCases(
  db: pg.Pool,
  user: Actor,
  input: z.infer<typeof caseFilters>,
) {
  canRead(user, input.application_id);
  const params: unknown[] = [input.application_id],
    conditions = ["c.application_id=$1"];
  const bind = (value: unknown) => {
    params.push(value);
    return "$" + params.length;
  };
  if (input.scope === "mine")
    conditions.push(`c.owner_id=${bind(user.id)} AND c.state='open'`);
  if (input.scope === "unassigned")
    conditions.push("c.owner_id IS NULL AND c.state='open'");
  if (input.scope === "overdue")
    conditions.push("c.due_at<now() AND c.state='open'");
  if (input.scope === "review")
    conditions.push("c.stage='pending_review' AND c.state='open'");
  for (const field of ["category", "priority", "stage"] as const)
    if (input[field]) conditions.push(`c.${field}=${bind(input[field])}`);
  if (input.q)
    conditions.push(
      `(strpos(lower(c.title),lower(${bind(input.q)}))>0 OR c.id=${bind(input.q)} OR c.trade_id=${bind(input.q)})`,
    );
  const where = " WHERE " + conditions.join(" AND ");
  return transaction(db, async (sql) => {
    await sql.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const total = (
      await sql.query("SELECT count(*)::int total FROM cases c" + where, params)
    ).rows[0].total;
    const items = (
      await sql.query(
        caseSelect +
          where +
          ` ORDER BY (c.state='closed'),${queueOrder} LIMIT 25 OFFSET $${params.length + 1}`,
        [...params, (input.page - 1) * 25],
      )
    ).rows;
    return {
      items,
      total,
      page: input.page,
      pages: Math.max(1, Math.ceil(total / 25)),
    };
  });
}
export async function assignees(db: pg.Pool, user: Actor, app: string) {
  canRead(user, app);
  requireRole(user, "operator", "approver", "admin");
  return (
    await db.query(
      `SELECT o.id,o.name FROM operators o JOIN operator_scopes s ON s.operator_id=o.id
    WHERE s.application_id=$1 AND o.enabled AND 'operator'=ANY(o.roles) ORDER BY o.name,o.id`,
      [app],
    )
  ).rows;
}
async function note(
  sql: Sql,
  key: string,
  user: Actor,
  content: string,
  event: Record<string, unknown>,
) {
  await sql.query(
    "INSERT INTO case_notes(case_id,actor_id,note,event) VALUES($1,$2,$3,$4)",
    [key, user.id, content, JSON.stringify(event)],
  );
}
export async function createCase(
  db: pg.Pool,
  user: Actor,
  b: z.infer<typeof caseCreate>,
) {
  requireRole(user, "operator");
  requireScope(user, b.application_id);
  const key = id("case");
  await transaction(db, async (sql) => {
    if (b.trade_id)
      insist(
        (
          await sql.query(
            "SELECT 1 FROM trade_projections WHERE application_id=$1 AND id=$2",
            [b.application_id, b.trade_id],
          )
        ).rowCount,
        404,
        "trade_not_found",
      );
    await sql.query(
      `INSERT INTO cases(id,application_id,trade_id,title,created_by,category,priority,due_at,requires_review)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        key,
        b.application_id,
        b.trade_id || null,
        b.title,
        user.id,
        b.category,
        b.priority,
        b.due_at || null,
        b.category === "dispute",
      ],
    );
    await note(sql, key, user, b.note, { action: "created" });
    await audit(sql, b.application_id, user.id, "case.created", key, {
      category: b.category,
      priority: b.priority,
      due_at: b.due_at || null,
    });
  });
  return { id: key };
}
async function noActiveCommands(sql: Sql, key: string) {
  insist(
    !(
      await sql.query(
        "SELECT 1 FROM management_requests WHERE case_id=$1 AND state=ANY($2)",
        [key, activeManagement],
      )
    ).rowCount,
    409,
    "case_has_active_operations",
  );
}
export async function actOnCase(
  db: pg.Pool,
  cfg: Config,
  user: Actor,
  key: string,
  b: z.infer<typeof caseAction>,
) {
  requireRole(
    user,
    b.action === "review"
      ? "approver"
      : b.action === "assign"
        ? "admin"
        : "operator",
  );
  return transaction(db, async (sql) => {
    const c = (
      await sql.query("SELECT * FROM cases WHERE id=$1 FOR UPDATE", [key])
    ).rows[0];
    insist(c, 404, "case_not_found");
    requireScope(user, c.application_id);
    insist(c.state === "open", 409, "case_closed");
    // Freeze the reviewed evidence while a financial request is pending or its result is unknown.
    await noActiveCommands(sql, key);
    const before = {
      owner_id: c.owner_id,
      stage: c.stage,
      priority: c.priority,
      category: c.category,
      due_at: c.due_at,
      review_status: c.review_status,
    };
    if (b.action !== "review")
      insist(c.stage !== "pending_review", 409, "case_review_pending");
    if (["update", "submit_review", "close"].includes(b.action))
      insist(c.owner_id === user.id, 403, "case_owner_only");
    if (b.action === "note") {
      // Unassigned notes may be added by an operator; assigned work stays with its owner.
      insist(!c.owner_id || c.owner_id === user.id, 403, "case_owner_only");
    }
    if (b.action === "claim") {
      insist(
        !c.owner_id || c.owner_id === user.id,
        409,
        "case_already_claimed",
      );
      c.owner_id = user.id;
      c.stage = "in_progress";
    }
    if (b.action === "assign") {
      const eligible = (
        await sql.query(
          `SELECT o.id FROM operators o JOIN operator_scopes s ON s.operator_id=o.id
        WHERE o.id=$1 AND s.application_id=$2 AND o.enabled AND 'operator'=ANY(o.roles) FOR UPDATE OF o`,
          [b.owner_id, c.application_id],
        )
      ).rows[0];
      insist(eligible, 403, "case_assignee_invalid");
      c.owner_id = b.owner_id;
      c.stage = "in_progress";
    }
    if (b.action === "update") {
      if (b.category !== undefined) {
        c.category = b.category;
        c.requires_review ||= b.category === "dispute";
      }
      if (b.priority !== undefined) c.priority = b.priority;
      if (b.due_at !== undefined) c.due_at = b.due_at;
      if (b.stage !== undefined) c.stage = b.stage;
    }
    if (
      ["claim", "note", "update", "assign"].includes(b.action) &&
      c.review_status === "accepted"
    ) {
      c.review_status = "none";
      c.reviewer_id = null;
      c.reviewed_at = null;
    }
    if (b.action === "submit_review") {
      c.requires_review = true;
      c.stage = "pending_review";
      c.review_status = "pending";
      c.review_submitted_by = user.id;
      c.reviewer_id = null;
      c.reviewed_at = null;
    }
    if (b.action === "review") {
      insist(
        c.stage === "pending_review" && c.review_status === "pending",
        409,
        "case_not_pending_review",
      );
      insist(
        user.id !== c.owner_id && user.id !== c.review_submitted_by,
        403,
        "self_review_forbidden",
      );
      c.review_status = b.decision === "accept" ? "accepted" : "returned";
      c.stage = "in_progress";
      c.reviewer_id = user.id;
      c.reviewed_at = new Date().toISOString();
    }
    if (b.action === "close") {
      insist(
        !c.requires_review || c.review_status === "accepted",
        409,
        "case_review_required",
      );
      const application = (
        await sql.query("SELECT * FROM applications WHERE id=$1", [
          c.application_id,
        ])
      ).rows[0];
      if (c.trade_id && application.source_mode === "mishu") {
        const current = await sourceAdapter(db, cfg, application).trade(
          c.trade_id,
        );
        insist(
          current.operational_hold?.case_id !== key,
          409,
          "case_has_active_hold",
        );
      }
      c.state = "closed";
      c.stage = "resolved";
      c.resolution = b.note;
      c.closed_at = new Date().toISOString();
    }
    await sql.query(
      `UPDATE cases SET owner_id=$2,stage=$3,category=$4,priority=$5,due_at=$6,review_status=$7,
      review_submitted_by=$8,reviewer_id=$9,reviewed_at=$10,requires_review=$11,state=$12,resolution=$13,closed_at=$14,updated_at=now() WHERE id=$1`,
      [
        key,
        c.owner_id,
        c.stage,
        c.category,
        c.priority,
        c.due_at,
        c.review_status,
        c.review_submitted_by,
        c.reviewer_id,
        c.reviewed_at,
        c.requires_review,
        c.state,
        c.resolution,
        c.closed_at,
      ],
    );
    const event = {
      action: b.action,
      decision: b.decision,
      before,
      after: {
        owner_id: c.owner_id,
        stage: c.stage,
        priority: c.priority,
        category: c.category,
        due_at: c.due_at,
        review_status: c.review_status,
      },
    };
    await note(sql, key, user, b.note, event);
    await audit(sql, c.application_id, user.id, "case." + b.action, key, event);
    return { ok: true };
  });
}
export async function workspace(
  db: pg.Pool,
  user: Actor,
  app: string,
): Promise<Workspace> {
  canRead(user, app);
  return transaction(db, async (sql) => {
    await sql.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const capabilities = {
      manage_cases: user.roles.includes("operator"),
      review_cases: user.roles.includes("approver"),
      assign_cases: user.roles.includes("admin"),
      view_team: user.roles.some((r) => ["admin", "auditor"].includes(r)),
    };
    const summary = (
      await sql.query(
        `SELECT count(*) FILTER(WHERE state='open')::int open,
      count(*) FILTER(WHERE state='open' AND owner_id=$2)::int mine,
      count(*) FILTER(WHERE state='open' AND owner_id IS NULL)::int unassigned,
      count(*) FILTER(WHERE state='open' AND due_at<now())::int overdue,
      count(*) FILTER(WHERE state='open' AND stage='pending_review')::int review
      FROM cases WHERE application_id=$1`,
        [app, user.id],
      )
    ).rows[0];
    const tradeCounts = (
      await sql.query(
        `SELECT count(*) FILTER(WHERE status='DISPUTED')::int disputed_trades,
      count(*) FILTER(WHERE status='FUNDED')::int awaiting_delivery,count(*) FILTER(WHERE status='DELIVERED')::int awaiting_acceptance
      FROM trade_projections WHERE application_id=$1`,
        [app],
      )
    ).rows[0];
    const pending = (
      await sql.query(
        `SELECT ((SELECT count(*) FROM management_requests WHERE application_id=$1 AND state='pending_approval')+
      (SELECT count(*) FROM operation_requests WHERE application_id=$1 AND state='pending_approval'))::int pending_approvals`,
        [app],
      )
    ).rows[0];
    const cases = (
      await sql.query(
        caseSelect +
          ` WHERE c.application_id=$1 AND c.state='open'
      ORDER BY (c.owner_id=$2) DESC NULLS LAST,${queueOrder} LIMIT 12`,
        [app, user.id],
      )
    ).rows;
    const risks = (
      await sql.query(
        `SELECT t.id,t.status,t.document->>'asset_title' asset_title,t.price::text,t.buyer_id,t.seller_id,t.updated_at,t.created_at,
      (SELECT count(*)::int FROM cases c WHERE c.application_id=t.application_id AND c.trade_id=t.id AND c.state='open') open_cases
      FROM trade_projections t WHERE t.application_id=$1 AND t.status IN ('DISPUTED','FUNDED','DELIVERED')
      ORDER BY (t.status='DISPUTED') DESC,t.updated_at,t.id LIMIT 12`,
        [app],
      )
    ).rows;
    const team = capabilities.view_team
      ? (
          await sql.query(
            `SELECT o.id,o.name,
      count(c.id) FILTER(WHERE c.state='open')::int open,
      count(c.id) FILTER(WHERE c.state='open' AND c.due_at<now())::int overdue,
      count(c.id) FILTER(WHERE c.state='open' AND c.stage='pending_review')::int review,
      count(c.id) FILTER(WHERE c.state='closed' AND c.closed_at>=now()-interval '7 days')::int closed_7d
      FROM operators o JOIN operator_scopes s ON s.operator_id=o.id AND s.application_id=$1
      LEFT JOIN cases c ON c.owner_id=o.id AND c.application_id=$1
      WHERE o.enabled AND 'operator'=ANY(o.roles) GROUP BY o.id,o.name ORDER BY open DESC,o.name`,
            [app],
          )
        ).rows
      : [];
    const sync = (
      await sql.query(
        "SELECT initialized,last_poll_at,last_applied_at,source_error FROM applications WHERE id=$1",
        [app],
      )
    ).rows[0];
    insist(sync, 404, "application_not_found");
    return {
      summary: { ...summary, ...tradeCounts, ...pending },
      cases,
      risks,
      team,
      capabilities,
      sync,
      generated_at: new Date().toISOString(),
    };
  });
}
