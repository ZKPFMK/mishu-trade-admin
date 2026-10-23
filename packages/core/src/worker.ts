import type pg from "pg";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { transaction } from "../../database/src/index.js";
import { sourceAdapter } from "../../adapters/src/index.js";
import { applyNextEvent, importSnapshot, receiveEvent } from "./sync.js";
import { executeOperation } from "./operations.js";
import { reconcile } from "./reconciliation.js";
import { exportJob, cleanupExports } from "./exports.js";
import { id, insist, TradeError } from "./security.js";
import { audit } from "./audit.js";
export async function syncSources(db: pg.Pool, cfg: Config) {
  const apps = (
    await db.query("SELECT * FROM applications WHERE enabled AND initialized")
  ).rows;
  for (const app of apps)
    try {
      const page = await sourceAdapter(db, cfg, app).events(app.applied_cursor);
      insist(
        page.from_cursor === app.applied_cursor,
        409,
        "source_coverage_mismatch",
      );
      let cursor = page.from_cursor;
      for (const event of page.events) {
        insist(event.previous_cursor === cursor, 409, "source_coverage_gap");
        const received = await receiveEvent(db, app.id, event);
        insist(received.state !== "conflict", 409, "source_event_conflict");
        cursor = event.source_cursor;
      }
      insist(page.through_cursor === cursor, 409, "source_coverage_mismatch");
      for (let i = 0; i < 200 && (await applyNextEvent(db, app.id)); i++) {}
      await db.query(
        "UPDATE applications SET last_poll_at=now(),source_error=NULL WHERE id=$1",
        [app.id],
      );
    } catch (e) {
      await db.query(
        "UPDATE applications SET last_poll_at=now(),source_error=$2 WHERE id=$1",
        [app.id, e instanceof TradeError ? e.code : "source_unavailable"],
      );
    }
}
export async function runJob(db: pg.Pool, cfg: Config, kinds: string[]) {
  const lease = id("lease");
  const job = await transaction(db, async (sql) => {
    const j = (
      await sql.query(
        "SELECT * FROM jobs WHERE kind=ANY($1) AND (state='queued' OR (state='running' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
        [kinds],
      )
    ).rows[0];
    if (!j) return null;
    if (j.cancel_requested) {
      await sql.query(
        "UPDATE jobs SET state='canceled',updated_at=now() WHERE id=$1",
        [j.id],
      );
      return null;
    }
    if (j.attempts >= 5) {
      await sql.query(
        "UPDATE jobs SET state='failed',error='lease_retry_limit',updated_at=now() WHERE id=$1",
        [j.id],
      );
      return null;
    }
    await sql.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1",
      [j.id, lease],
    );
    return j;
  });
  if (!job) return false;
  const heartbeat = setInterval(
    () =>
      void db
        .query(
          "UPDATE jobs SET lease_until=now()+interval '45 seconds' WHERE id=$1 AND lease_token=$2 AND state='running'",
          [job.id, lease],
        )
        .catch(() => {}),
    10000,
  );
  try {
    let result: unknown;
    if (job.kind === "export") result = await exportJob(db, cfg, job, lease);
    else if (job.kind === "reconcile")
      result = await reconcile(db, job.application_id, job.id);
    else {
      const app = (
        await db.query("SELECT * FROM applications WHERE id=$1", [
          job.application_id,
        ])
      ).rows[0];
      // A crash after activation but before job completion can safely acknowledge the committed import.
      if (app.initialized) {
        const own = (
          await db.query(
            "SELECT detail FROM audit_events WHERE application_id=$1 AND action='import.activated' AND object_id=$2",
            [app.id, job.id],
          )
        ).rows[0];
        insist(own, 409, "already_initialized");
        result = own.detail;
      } else {
        const snapshot =
          job.payload.snapshot ||
          (await sourceAdapter(db, cfg, app).snapshot());
        result = await importSnapshot(db, app.id, snapshot, job.id);
      }
    }
    if (job.kind !== "export")
      await db.query(
        "UPDATE jobs SET state='succeeded',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$3",
        [job.id, JSON.stringify(result), lease],
      );
    await audit(
      db,
      job.application_id,
      job.owner_id,
      job.kind + ".completed",
      job.id,
    );
  } catch (e) {
    const error =
      e instanceof TradeError
        ? e.code
        : (e as any)?.name === "ZodError"
          ? "invalid_source_payload"
          : "task_failed";
    await db.query(
      "UPDATE jobs SET state=CASE WHEN cancel_requested OR $2='export_canceled' THEN 'canceled' ELSE 'failed' END,error=$2,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$3",
      [job.id, error, lease],
    );
    await audit(
      db,
      job.application_id,
      job.owner_id,
      job.kind + ".failed",
      job.id,
      { error },
    );
    console.error(`Task ${job.id}: ${error}`);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
export async function maintenance(db: pg.Pool, cfg: Config) {
  await cleanupExports(db, cfg);
  await db.query("DELETE FROM sessions WHERE expires_at<now()");
  // Approved/unknown commands are resolved by executeOperation before expiry is considered.
  // Expire pending requests too: stale approvals must be recreated from a fresh source view.
  await db.query(
    "UPDATE operation_requests SET state='expired',error='request_expired',updated_at=now() WHERE state='pending_approval' AND created_at<now()-interval '24 hours'",
  );
}
