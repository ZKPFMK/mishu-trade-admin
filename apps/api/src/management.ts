import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../../../packages/core/src/config.js";
import {
  actor,
  requireRole,
  requireScope,
} from "../../../packages/core/src/auth.js";
import { identifier } from "../../../packages/contracts/src/index.js";
import {
  managementInput,
  fingerprint,
} from "../../../packages/contracts/src/management.js";
import {
  previewManagement,
  requestManagement,
  decideManagement,
  managementView,
} from "../../../packages/core/src/management.js";
import {
  securityState,
  beginMfa,
  confirmMfa,
  reauthenticate,
} from "../../../packages/core/src/mfa.js";
import { id, hash, insist } from "../../../packages/core/src/security.js";
import { transaction } from "../../../packages/database/src/index.js";
import { audit } from "../../../packages/core/src/audit.js";
const password = z.string().min(1).max(200),
  otp = z.string().max(64).optional();
const sensitive = { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } };
export function managementRoutes(
  api: FastifyInstance,
  db: pg.Pool,
  cfg: Config,
) {
  api.get("/auth/security", async (req) => {
    const u = await actor(db, req),
      state = await securityState(db, u.id);
    const m = (
      await db.query(
        "SELECT cardinality(recovery_hashes) remaining FROM operator_mfa WHERE operator_id=$1",
        [u.id],
      )
    ).rows[0];
    return {
      enabled: state?.mfa,
      required: cfg.requireMfa,
      recovery_codes_remaining: m?.remaining || 0,
    };
  });
  api.post("/auth/mfa/setup", sensitive, async (req) => {
    const u = await actor(db, req),
      b = z.object({ password }).strict().parse(req.body);
    return beginMfa(db, cfg, u.id, b.password, u.email);
  });
  api.post("/auth/mfa/confirm", sensitive, async (req) => {
    const u = await actor(db, req),
      b = z
        .object({ otp: z.string().regex(/^\d{6}$/) })
        .strict()
        .parse(req.body);
    return confirmMfa(db, cfg, u.id, b.otp, hash(req.cookies.trade_session!));
  });
  api.post("/auth/mfa/disable", sensitive, async (req) => {
    const u = await actor(db, req),
      b = z.object({ password, otp }).strict().parse(req.body),
      auth = await reauthenticate(db, cfg, u.id, b.password, b.otp);
    await transaction(db, async (sql) => {
      await sql.query("SELECT id FROM operators WHERE id=$1 FOR UPDATE", [
        u.id,
      ]);
      await sql.query(
        "SELECT operator_id FROM operator_mfa WHERE operator_id=$1 FOR UPDATE",
        [u.id],
      );
      const state = await securityState(sql, u.id);
      insist(
        state?.fingerprint === auth.fingerprint,
        409,
        "operator_permission_changed",
      );
      await sql.query("DELETE FROM operator_mfa WHERE operator_id=$1", [u.id]);
      await sql.query("DELETE FROM sessions WHERE operator_id=$1", [u.id]);
      await audit(sql, null, u.id, "auth.mfa_disabled", u.id);
    });
    return { ok: true };
  });
  api.post("/admin/management/cases", async (req) => {
    const u = await actor(db, req);
    requireRole(u, "operator");
    const b = z
      .object({
        application_id: identifier,
        trade_id: identifier.optional(),
        title: z.string().trim().min(5).max(200),
        evidence: z.string().trim().min(10).max(2000),
      })
      .strict()
      .parse(req.body);
    requireScope(u, b.application_id);
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
        "INSERT INTO cases(id,application_id,trade_id,title,created_by,owner_id) VALUES($1,$2,$3,$4,$5,$5)",
        [key, b.application_id, b.trade_id || null, b.title, u.id],
      );
      await sql.query(
        "INSERT INTO case_notes(case_id,actor_id,note) VALUES($1,$2,$3)",
        [key, u.id, b.evidence],
      );
      await audit(
        sql,
        b.application_id,
        u.id,
        "case.created_and_claimed",
        key,
        { trade_id: b.trade_id },
      );
    });
    return { id: key };
  });
  api.post("/admin/management/preview", async (req) => {
    const u = await actor(db, req),
      b = z
        .object({ application_id: identifier, input: managementInput })
        .strict()
        .parse(req.body);
    return previewManagement(db, cfg, u, b.application_id, b.input);
  });
  api.post("/admin/management/requests", sensitive, async (req) => {
    const u = await actor(db, req),
      b = z
        .object({
          application_id: identifier,
          input: managementInput,
          expected_fingerprint: fingerprint,
          reason: z.string().trim().min(5).max(1000),
          evidence: z.string().trim().min(10).max(2000),
          idempotency_key: identifier,
          password,
          otp,
        })
        .strict()
        .parse(req.body);
    return requestManagement(db, cfg, u, b);
  });
  api.get("/admin/management/requests", async (req) => {
    const u = await actor(db, req),
      q = z
        .object({
          application_id: identifier,
          page: z.coerce.number().int().min(1).max(1000).default(1),
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
        })
        .strict()
        .parse(req.query);
    requireScope(u, q.application_id);
    const where = "m.application_id=$1" + (q.state ? " AND m.state=$2" : ""),
      values: unknown[] = q.state
        ? [q.application_id, q.state]
        : [q.application_id];
    return transaction(db, async (sql) => {
      await sql.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const total = (
        await sql.query(
          "SELECT count(*)::text total FROM management_requests m WHERE " +
            where,
          values,
        )
      ).rows[0].total;
      const rows = (
        await sql.query(
          `SELECT m.*,r.name requester_name,a.name approver_name,
        CASE WHEN m.receipt->>'status'='succeeded' AND jsonb_array_length(m.receipt->'journal_ids')>0 THEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(m.receipt->'journal_ids') j(id) WHERE NOT EXISTS(SELECT 1 FROM journal_transactions t WHERE t.application_id=m.application_id AND t.id=j.id)) ELSE NULL END projection_synced
        FROM management_requests m JOIN operators r ON r.id=m.requester_id LEFT JOIN operators a ON a.id=m.approver_id WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT 25 OFFSET $${values.length + 1}`,
          [...values, (q.page - 1) * 25],
        )
      ).rows;
      return { items: rows.map(managementView), total, page: q.page };
    });
  });
  for (const action of ["approve", "reject", "cancel"] as const)
    api.post(
      "/admin/management/requests/:id/" + action,
      sensitive,
      async (req) => {
        const u = await actor(db, req),
          key = identifier.parse((req.params as any).id),
          b = z
            .object({
              reason: z.string().trim().min(5).max(1000),
              password: password.optional(),
              otp,
            })
            .strict()
            .parse(req.body);
        return decideManagement(
          db,
          cfg,
          u,
          key,
          action,
          b.reason,
          b.password,
          b.otp,
        );
      },
    );
}
