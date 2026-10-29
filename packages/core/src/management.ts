import type pg from "pg";
import { transaction, type Sql } from "../../database/src/index.js";
import type { Config } from "./config.js";
import { type Actor, requireRole, requireScope } from "./auth.js";
import { managementAdapter } from "../../adapters/src/management.js";
import {
  managementInput,
  managementIntent,
  type ManagementInput,
  type ManagementCommand,
} from "../../contracts/src/management.js";
import { digest, id, insist, TradeError } from "./security.js";
import { reauthenticate, securityState } from "./mfa.js";
import { audit } from "./audit.js";
export const activeManagement = [
  "pending_approval",
  "approved",
  "executing",
  "execution_unknown",
];
function reviewAllows(c: any, type: string) {
  return (
    ["hold_trade", "release_trade"].includes(type) ||
    !c.requires_review ||
    c.review_status === "accepted"
  );
}
export function managementView(row: any) {
  const {
    requester_security,
    approver_security,
    lease_token,
    lease_until,
    source_command,
    ...safe
  } = row;
  return safe;
}
async function application(db: Sql, cfg: Config, actor: Actor, app: string) {
  requireScope(actor, app);
  const a = (await db.query("SELECT * FROM applications WHERE id=$1", [app]))
    .rows[0];
  insist(a?.enabled && a.initialized, 409, "source_not_initialized");
  insist(
    a.source_mode === "mishu" && a.management_enabled && cfg.managementEnabled,
    403,
    "management_disabled",
  );
  return a;
}
async function caseFor(
  sql: Sql,
  actor: Actor,
  app: string,
  input: ManagementInput,
  lock = false,
) {
  const c = (
    await sql.query(
      "SELECT * FROM cases WHERE id=$1" + (lock ? " FOR UPDATE" : ""),
      [input.case_id],
    )
  ).rows[0];
  insist(
    c?.application_id === app && c.state === "open",
    409,
    "open_case_required",
  );
  insist(c.owner_id === actor.id, 403, "case_owner_only");
  insist(reviewAllows(c, input.type), 409, "case_review_required");
  if (input.type !== "adjust_credit")
    insist(c.trade_id === input.target_id, 409, "case_target_mismatch");
  return c;
}
async function eligible(
  sql: Sql,
  actor: string,
  app: string,
  role: string,
  fingerprint: string,
  requireMfa: boolean,
  verified: boolean,
) {
  const ok = (
    await sql.query(
      "SELECT 1 FROM operators o JOIN operator_scopes s ON s.operator_id=o.id WHERE o.id=$1 AND s.application_id=$2 AND o.enabled AND $3=ANY(o.roles)",
      [actor, app, role],
    )
  ).rowCount;
  const state = await securityState(sql, actor);
  return !!(
    ok &&
    state?.enabled &&
    state.fingerprint === fingerprint &&
    (!requireMfa || state.mfa) &&
    (!state.mfa || verified)
  );
}
export async function previewManagement(
  db: pg.Pool,
  cfg: Config,
  actor: Actor,
  app: string,
  raw: unknown,
) {
  requireRole(actor, "operator");
  const a = await application(db, cfg, actor, app),
    input = managementInput.parse(raw);
  await caseFor(db, actor, app, input);
  const preview = await managementAdapter(cfg).preview(input);
  if (input.type === "adjust_credit")
    insist(
      (BigInt(preview.operation.amount) < 0n
        ? -BigInt(preview.operation.amount)
        : BigInt(preview.operation.amount)) <= BigInt(a.adjustment_limit),
      403,
      "adjustment_limit_exceeded",
    );
  else if (!["hold_trade", "release_trade"].includes(input.type))
    insist(
      BigInt(preview.operation.amount) <= BigInt(a.refund_limit),
      403,
      "management_amount_limit_exceeded",
    );
  return preview;
}
export type RequestManagement = {
  application_id: string;
  input: ManagementInput;
  expected_fingerprint: string;
  reason: string;
  evidence: string;
  idempotency_key: string;
  password: string;
  otp?: string;
};
export async function requestManagement(
  db: pg.Pool,
  cfg: Config,
  actor: Actor,
  b: RequestManagement,
) {
  const a = await application(db, cfg, actor, b.application_id);
  requireRole(actor, "operator");
  const same = (row: any) => {
    insist(
      row.application_id === b.application_id &&
        digest(row.intent.operation) ===
          digest({ ...b.input, amount: row.intent.operation.amount }) &&
        row.intent.expected_fingerprint === b.expected_fingerprint &&
        row.intent.reason === b.reason &&
        row.intent.evidence === b.evidence &&
        (b.input.amount === undefined ||
          b.input.amount === row.intent.operation.amount),
      409,
      "idempotency_conflict",
    );
    return managementView(row);
  };
  const old = (
    await db.query(
      "SELECT * FROM management_requests WHERE requester_id=$1 AND idempotency_key=$2",
      [actor.id, b.idempotency_key],
    )
  ).rows[0];
  if (old) return same(old);
  const auth = await reauthenticate(
    db,
    { ...cfg, requireMfa: cfg.requireMfa || a.environment === "production" },
    actor.id,
    b.password,
    b.otp,
  );
  const preview = await previewManagement(
    db,
    cfg,
    actor,
    b.application_id,
    b.input,
  );
  insist(
    preview.fingerprint === b.expected_fingerprint,
    409,
    "source_state_changed",
  );
  const now = Date.now(),
    intent = managementIntent.parse({
      command_id: id("mgmt"),
      application_id: a.id,
      source_id: preview.source_id,
      operation: preview.operation,
      expected_fingerprint: preview.fingerprint,
      reason: b.reason,
      evidence: b.evidence,
      requester_id: actor.id,
      requested_at: new Date(now).toISOString(),
      expires_at: new Date(now + 86400000).toISOString(),
    });
  return transaction(db, async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      actor.id + ":" + b.idempotency_key,
    ]);
    const duplicate = (
      await sql.query(
        "SELECT * FROM management_requests WHERE requester_id=$1 AND idempotency_key=$2",
        [actor.id, b.idempotency_key],
      )
    ).rows[0];
    if (duplicate) return same(duplicate);
    await caseFor(sql, actor, a.id, b.input, true);
    insist(
      await eligible(
        sql,
        actor.id,
        a.id,
        "operator",
        auth.fingerprint,
        cfg.requireMfa || a.environment === "production",
        auth.mfa,
      ),
      403,
      "operator_permission_changed",
    );
    const key = id("request");
    const row = (
      await sql.query(
        `INSERT INTO management_requests(id,application_id,case_id,target_id,type,requester_id,idempotency_key,intent,digest,preview,requester_security,requester_mfa,request_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          key,
          a.id,
          b.input.case_id,
          b.input.target_id,
          b.input.type,
          actor.id,
          b.idempotency_key,
          JSON.stringify(intent),
          digest(intent),
          JSON.stringify(preview),
          auth.fingerprint,
          auth.mfa,
          intent.expires_at,
        ],
      )
    ).rows[0];
    await audit(sql, a.id, actor.id, "management.requested", key, {
      type: b.input.type,
      target_id: b.input.target_id,
      case_id: b.input.case_id,
      digest: row.digest,
      amount: preview.operation.amount,
    });
    return managementView(row);
  });
}
export async function decideManagement(
  db: pg.Pool,
  cfg: Config,
  actor: Actor,
  key: string,
  action: "approve" | "reject" | "cancel",
  reason: string,
  password = "",
  otp = "",
) {
  const initial = (
    await db.query("SELECT * FROM management_requests WHERE id=$1", [key])
  ).rows[0];
  insist(initial, 404, "operation_not_found");
  requireScope(actor, initial.application_id);
  if (action === "cancel")
    insist(initial.requester_id === actor.id, 403, "requester_only");
  else {
    requireRole(actor, "approver");
    insist(initial.requester_id !== actor.id, 403, "self_approval_forbidden");
  }
  if (
    action === "approve" &&
    initial.approver_id === actor.id &&
    initial.state !== "pending_approval" &&
    initial.decision_reason === reason
  )
    return managementView(initial);
  const a =
    action === "approve"
      ? await application(db, cfg, actor, initial.application_id)
      : null;
  const auth =
    action === "approve"
      ? await reauthenticate(
          db,
          {
            ...cfg,
            requireMfa: cfg.requireMfa || a.environment === "production",
          },
          actor.id,
          password,
          otp,
        )
      : null;
  return transaction(db, async (sql) => {
    const row = (
      await sql.query(
        "SELECT * FROM management_requests WHERE id=$1 FOR UPDATE",
        [key],
      )
    ).rows[0];
    insist(
      row.state === "pending_approval" ||
        (action === "cancel" && row.state === "approved"),
      409,
      "not_pending_approval",
    );
    insist(!row.dispatched_at, 409, "execution_already_started");
    if (action === "approve") {
      insist(
        new Date(row.request_expires_at).getTime() > Date.now(),
        409,
        "request_expired",
      );
      insist(row.digest === digest(row.intent), 409, "approval_invalid");
      const c = (
        await sql.query("SELECT * FROM cases WHERE id=$1 FOR UPDATE", [
          row.case_id,
        ])
      ).rows[0];
      insist(
        c.state === "open" && c.owner_id === row.requester_id,
        409,
        "open_case_required",
      );
      insist(reviewAllows(c, row.type), 409, "case_review_required");
      insist(
        await eligible(
          sql,
          actor.id,
          a.id,
          "approver",
          auth!.fingerprint,
          cfg.requireMfa || a.environment === "production",
          auth!.mfa,
        ),
        403,
        "operator_permission_changed",
      );
      const expires = new Date(
        Math.min(
          Date.now() + 15 * 60000,
          new Date(row.request_expires_at).getTime(),
        ),
      ).toISOString();
      const command: ManagementCommand = {
        intent: row.intent,
        authorization: {
          approver_id: actor.id,
          approved_at: new Date().toISOString(),
          expires_at: expires,
          request_digest: row.digest,
          reason,
        },
      };
      await sql.query(
        "UPDATE management_requests SET state='approved',approver_id=$2,approver_security=$3,approver_mfa=$4,decision_reason=$5,source_command=$6,approval_expires_at=$7,updated_at=now() WHERE id=$1",
        [
          key,
          actor.id,
          auth!.fingerprint,
          auth!.mfa,
          reason,
          JSON.stringify(command),
          expires,
        ],
      );
    } else
      await sql.query(
        "UPDATE management_requests SET state=$2,decision_reason=$3,updated_at=now() WHERE id=$1",
        [key, action === "cancel" ? "canceled" : "rejected", reason],
      );
    await audit(
      sql,
      row.application_id,
      actor.id,
      "management." + action,
      key,
      { reason, digest: row.digest },
    );
    return {
      id: key,
      state:
        action === "approve"
          ? "approved"
          : action === "cancel"
            ? "canceled"
            : "rejected",
    };
  });
}
export async function executeManagement(db: pg.Pool, cfg: Config) {
  const lease = id("lease");
  const row = await transaction(db, async (sql) => {
    const row = (
      await sql.query(
        "SELECT * FROM management_requests WHERE (state IN ('approved','execution_unknown') AND next_attempt_at<=now()) OR (state='executing' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!row) return null;
    await sql.query(
      "UPDATE management_requests SET state='executing',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1",
      [row.id, lease],
    );
    return row;
  });
  if (!row) return false;
  const adapter = managementAdapter(cfg),
    command = row.source_command as ManagementCommand;
  const attempt = async (action: string, result: string) => {
    await db.query(
      "INSERT INTO management_attempts(request_id,action,result) VALUES($1,$2,$3)",
      [row.id, action, result],
    );
  };
  try {
    insist(
      command &&
        digest(command.intent) === row.digest &&
        command.authorization.request_digest === row.digest &&
        command.authorization.approver_id === row.approver_id,
      409,
      "approval_invalid",
    );
    let receipt = await adapter.receipt(command);
    await attempt("receipt", receipt ? "found" : "not_found");
    if (!receipt) {
      let refusal: string | null = null;
      await transaction(db, async (sql) => {
        const current = (
          await sql.query(
            "SELECT * FROM management_requests WHERE id=$1 FOR UPDATE",
            [row.id],
          )
        ).rows[0];
        insist(
          current.lease_token === lease && current.state === "executing",
          409,
          "lease_lost",
        );
        const app = (
          await sql.query("SELECT * FROM applications WHERE id=$1", [
            row.application_id,
          ])
        ).rows[0];
        const c = (
          await sql.query("SELECT * FROM cases WHERE id=$1 FOR UPDATE", [
            row.case_id,
          ])
        ).rows[0];
        if (!app?.enabled || !app.management_enabled || !cfg.managementEnabled)
          refusal = "management_disabled";
        else if (new Date(row.approval_expires_at).getTime() <= Date.now())
          refusal = "approval_expired";
        else if (!c || c.state !== "open" || c.owner_id !== row.requester_id)
          refusal = "open_case_required";
        else if (!reviewAllows(c, row.type)) refusal = "case_review_required";
        else if (
          !(await eligible(
            sql,
            row.requester_id,
            app.id,
            "operator",
            row.requester_security,
            cfg.requireMfa || app.environment === "production",
            row.requester_mfa,
          )) ||
          !(await eligible(
            sql,
            row.approver_id,
            app.id,
            "approver",
            row.approver_security,
            cfg.requireMfa || app.environment === "production",
            row.approver_mfa,
          ))
        )
          refusal = "operator_permission_changed";
        else {
          const limit = BigInt(
              row.type === "adjust_credit"
                ? app.adjustment_limit
                : app.refund_limit,
            ),
            amount = BigInt(command.intent.operation.amount);
          if ((amount < 0n ? -amount : amount) > limit)
            refusal = "management_amount_limit_exceeded";
        }
        // Persist uncertainty before any network dispatch. Recovery always uses this same command.
        await sql.query(
          "UPDATE management_requests SET dispatched_at=COALESCE(dispatched_at,now()) WHERE id=$1",
          [row.id],
        );
      });
      receipt = refusal
        ? await adapter.cancel(command)
        : await adapter.execute(command);
      await attempt(refusal ? "cancel" : "execute", receipt.status);
      if (refusal)
        await audit(
          db,
          row.application_id,
          null,
          "management.authorization_revoked",
          row.id,
          { reason: refusal },
        );
    }
    await transaction(db, async (sql) => {
      const updated = await sql.query(
        "UPDATE management_requests SET state=$2,receipt=$3,error=$4,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$5",
        [
          row.id,
          receipt!.status === "succeeded" ? "succeeded" : "execution_failed",
          JSON.stringify(receipt),
          receipt!.status === "rejected" ? receipt!.code : null,
          lease,
        ],
      );
      if (updated.rowCount) {
        await audit(
          sql,
          row.application_id,
          null,
          "management.result",
          row.id,
          { receipt },
        );
        await sql.query(
          "INSERT INTO case_notes(case_id,actor_id,note) VALUES($1,$2,$3)",
          [
            row.case_id,
            row.requester_id,
            `处理申请 ${row.id}：${receipt!.status} / ${receipt!.code}，来源回执 ${receipt!.command_id}`,
          ],
        );
      }
    });
  } catch (e) {
    if (e instanceof TradeError && e.code === "lease_lost") return true;
    // Never turn HTTP/auth/network errors into proof that the source did not execute.
    await db.query(
      "UPDATE management_requests SET state='execution_unknown',error='source_result_unknown',lease_until=NULL,next_attempt_at=now()+least(300,power(2,least(attempts,8)))*interval '1 second',updated_at=now() WHERE id=$1 AND lease_token=$2",
      [row.id, lease],
    );
    await attempt("recover", "source_result_unknown");
    await audit(
      db,
      row.application_id,
      null,
      "management.execution_unknown",
      row.id,
    );
  }
  return true;
}
