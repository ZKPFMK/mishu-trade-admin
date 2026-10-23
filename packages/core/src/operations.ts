import type pg from "pg";
import { transaction } from "../../database/src/index.js";
import { sourceAdapter } from "../../adapters/src/index.js";
import type { Config } from "./config.js";
import { audit } from "./audit.js";
import { type Actor, requireRole, requireScope } from "./auth.js";
import { digest, id, insist, TradeError } from "./security.js";
import type { Command, Receipt } from "../../contracts/src/index.js";
export async function createOperation(
  db: pg.Pool,
  cfg: Config,
  actor: Actor,
  app: string,
  tradeId: string,
  reason: string,
  key: string,
) {
  requireScope(actor, app);
  requireRole(actor, "operator");
  const application = (
    await db.query("SELECT * FROM applications WHERE id=$1 AND enabled", [app])
  ).rows[0];
  insist(application, 404, "application_not_found");
  insist(
    application.source_mode === "mock",
    403,
    "real_source_commands_disabled",
  );
  const existing = (
    await db.query(
      "SELECT * FROM operation_requests WHERE requester_id=$1 AND idempotency_key=$2",
      [actor.id, key],
    )
  ).rows[0];
  if (existing) {
    insist(
      existing.application_id === app &&
        existing.trade_id === tradeId &&
        existing.reason === reason,
      409,
      "idempotency_conflict",
    );
    return existing;
  }
  const trade = await sourceAdapter(db, cfg, application).trade(tradeId);
  insist(
    trade.status === "FUNDED" && !trade.delivery_verified,
    409,
    "only_undelivered_funded_orders",
  );
  insist(
    BigInt(trade.price) <= BigInt(application.refund_limit),
    403,
    "refund_limit_exceeded",
  );
  const command: Command = {
    command_id: id("cmd"),
    type: "refund_undelivered",
    trade_id: trade.id,
    expected_version: trade.version,
    amount: trade.price,
    buyer_id: trade.buyer_id,
    reason,
  };
  return transaction(db, async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      actor.id + ":" + key,
    ]);
    const duplicate = (
      await sql.query(
        "SELECT * FROM operation_requests WHERE requester_id=$1 AND idempotency_key=$2",
        [actor.id, key],
      )
    ).rows[0];
    if (duplicate) {
      insist(
        duplicate.application_id === app &&
          duplicate.trade_id === tradeId &&
          duplicate.reason === reason,
        409,
        "idempotency_conflict",
      );
      return duplicate;
    }
    const operation = id("op");
    const row = (
      await sql.query(
        "INSERT INTO operation_requests(id,application_id,trade_id,requester_id,idempotency_key,command,digest,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [
          operation,
          app,
          trade.id,
          actor.id,
          key,
          JSON.stringify(command),
          digest(command),
          reason,
        ],
      )
    ).rows[0];
    await audit(sql, app, actor.id, "refund.requested", operation, {
      command_id: command.command_id,
      amount: command.amount,
      expected_version: command.expected_version,
      reason,
      digest: row.digest,
    });
    return row;
  });
}
export async function decideOperation(
  db: pg.Pool,
  actor: Actor,
  key: string,
  action: "approve" | "reject" | "cancel",
  reason: string,
) {
  return transaction(db, async (sql) => {
    const op = (
      await sql.query(
        "SELECT * FROM operation_requests WHERE id=$1 FOR UPDATE",
        [key],
      )
    ).rows[0];
    insist(op, 404, "operation_not_found");
    requireScope(actor, op.application_id);
    if (action === "cancel") {
      insist(actor.id === op.requester_id, 403, "requester_only");
      insist(
        ["pending_approval", "approved"].includes(op.state),
        409,
        "cannot_cancel",
      );
    } else {
      requireRole(actor, "approver");
      insist(op.requester_id !== actor.id, 403, "self_approval_forbidden");
      insist(op.state === "pending_approval", 409, "not_pending_approval");
    }
    const state =
      action === "approve"
        ? "approved"
        : action === "reject"
          ? "rejected"
          : "canceled";
    if (action === "approve")
      await sql.query(
        "UPDATE operation_requests SET state=$2,approver_id=$3,approval_digest=digest,approval_expires_at=now()+interval '30 minutes',decision_reason=$4,updated_at=now() WHERE id=$1",
        [key, state, actor.id, reason],
      );
    else
      await sql.query(
        "UPDATE operation_requests SET state=$2,decision_reason=$3,updated_at=now() WHERE id=$1",
        [key, state, reason],
      );
    await audit(sql, op.application_id, actor.id, "refund." + state, key, {
      reason,
      digest: op.digest,
    });
    return { id: key, state };
  });
}
async function eligible(
  db: pg.Pool,
  actorId: string,
  app: string,
  role: string,
) {
  return !!(
    await db.query(
      "SELECT 1 FROM operators o JOIN operator_scopes s ON s.operator_id=o.id WHERE o.id=$1 AND s.application_id=$2 AND o.enabled AND $3=ANY(o.roles)",
      [actorId, app, role],
    )
  ).rowCount;
}
export async function executeOperation(db: pg.Pool, cfg: Config) {
  // Short claim transaction; execution is always resolved using the original command ID.
  const op = await transaction(db, async (sql) => {
    const row = (
      await sql.query(
        "SELECT o.* FROM operation_requests o WHERE (state IN ('approved','execution_unknown') AND next_attempt_at<=now()) OR (state='executing' AND updated_at<now()-interval '60 seconds') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!row) return null;
    await sql.query(
      "UPDATE operation_requests SET state='executing',attempts=attempts+1,updated_at=now(),next_attempt_at=now()+interval '60 seconds' WHERE id=$1",
      [row.id],
    );
    return row;
  });
  if (!op) return false;
  const app = (
      await db.query("SELECT * FROM applications WHERE id=$1", [
        op.application_id,
      ])
    ).rows[0],
    adapter = sourceAdapter(db, cfg, app);
  try {
    // Check for an already committed result before expiry/role checks. Revocation cannot erase a prior outcome.
    let receipt = await adapter.receipt(op.command.command_id);
    await db.query(
      "INSERT INTO command_attempts(operation_id,action,result) VALUES($1,$2,$3)",
      [op.id, "query", receipt ? "found" : "not_found"],
    );
    if (!receipt) {
      insist(
        app.enabled && app.source_mode === "mock",
        403,
        "real_source_commands_disabled",
      );
      insist(
        new Date(op.approval_expires_at).getTime() > Date.now(),
        409,
        "approval_expired",
      );
      insist(
        op.approver_id &&
          op.requester_id !== op.approver_id &&
          op.digest === op.approval_digest &&
          op.digest === digest(op.command),
        409,
        "approval_invalid",
      );
      insist(
        (await eligible(db, op.requester_id, app.id, "operator")) &&
          (await eligible(db, op.approver_id, app.id, "approver")),
        403,
        "operator_permission_changed",
      );
      insist(
        BigInt(op.command.amount) <= BigInt(app.refund_limit),
        403,
        "refund_limit_exceeded",
      );
      const latest = await adapter.trade(op.trade_id);
      insist(
        latest.version === op.command.expected_version &&
          latest.status === "FUNDED" &&
          !latest.delivery_verified,
        409,
        "source_state_changed",
      );
      receipt = await adapter.execute(op.command);
      await db.query(
        "INSERT INTO command_attempts(operation_id,action,result) VALUES($1,$2,$3)",
        [op.id, "execute", receipt.status],
      );
    }
    await transaction(db, async (sql) => {
      await sql.query(
        "UPDATE operation_requests SET state=$2,receipt=$3,error=$4,updated_at=now() WHERE id=$1",
        [
          op.id,
          receipt.status === "succeeded" ? "succeeded" : "execution_failed",
          JSON.stringify(receipt),
          receipt.status === "rejected" ? receipt.code : null,
        ],
      );
      await audit(sql, app.id, null, "refund.result", op.id, { receipt });
    });
  } catch (e) {
    const known = e instanceof TradeError,
      code = known ? e.code : "source_result_unknown",
      state =
        code === "approval_expired"
          ? "expired"
          : known
            ? "execution_failed"
            : "execution_unknown";
    await db.query(
      "UPDATE operation_requests SET state=$2,error=$3,updated_at=now(),next_attempt_at=now()+least(300,power(2,least(attempts,8))) * interval '1 second' WHERE id=$1",
      [op.id, state, code],
    );
    await audit(db, app.id, null, "refund." + state, op.id, { code });
  }
  return true;
}
