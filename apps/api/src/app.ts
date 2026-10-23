import { overview } from "../../../packages/core/src/analytics.js";
import { managementRoutes } from "./management.js";
import { activeManagement } from "../../../packages/core/src/management.js";
import { sourceAdapter } from "../../../packages/adapters/src/index.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { randomBytes } from "node:crypto";
import { ROOT, type Config } from "../../../packages/core/src/config.js";
import {
  actor,
  login,
  requireRole,
  requireScope,
  service,
  type Actor,
} from "../../../packages/core/src/auth.js";
import {
  insist,
  hash,
  id,
  passwordHash,
  TradeError,
} from "../../../packages/core/src/security.js";
import { audit } from "../../../packages/core/src/audit.js";
import { transaction } from "../../../packages/database/src/index.js";
import {
  datasets,
  filtersSchema,
  listData,
} from "../../../packages/core/src/queries.js";
import {
  createOperation,
  decideOperation,
} from "../../../packages/core/src/operations.js";
import { exportSchema } from "../../../packages/core/src/exports.js";
import { queueJob, receiveEvent } from "../../../packages/core/src/sync.js";
import {
  batchSchema,
  identifier,
  roles,
  snapshotSchema,
} from "../../../packages/contracts/src/index.js";

export async function createApp(db: pg.Pool, cfg: Config) {
  const api = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger: false,
    trustProxy: false,
  });
  await api.register(cookie);
  await api.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  api.setErrorHandler((err: any, req, reply) => {
    if (err instanceof TradeError)
      return reply
        .code(err.status)
        .send({ error: err.code, request_id: req.id });
    if (err instanceof z.ZodError)
      return reply.code(400).send({
        error: "invalid_input",
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
        request_id: req.id,
      });
    if (err.code === "23505")
      return reply
        .code(409)
        .send({ error: "record_conflict", request_id: req.id });
    if (err.statusCode === 429)
      return reply
        .code(429)
        .send({ error: "rate_limited", request_id: req.id });
    if (err.statusCode && err.statusCode < 500)
      return reply
        .code(err.statusCode)
        .send({ error: err.code || "request_rejected", request_id: req.id });
    console.error(
      `Request ${req.id}: ${err.code || err.name || "internal_error"}`,
    );
    return reply
      .code(500)
      .send({ error: "internal_error", request_id: req.id });
  });
  api.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "DENY")
      .header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin
    ) {
      let origin: URL;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        throw new TradeError(403, "origin_invalid");
      }
      insist(origin.host === req.headers.host, 403, "origin_invalid");
    }
  });
  managementRoutes(api, db, cfg);
  api.get("/health", async () => {
    await db.query("SELECT 1");
    return { status: "ok", service: "mishu-trade-admin", version: "0.1.0" };
  });
  api.get("/openapi.json", async () =>
    JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages/contracts/openapi.json"),
        "utf8",
      ),
    ),
  );
  api.post(
    "/auth/login",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          email: z.email().max(254),
          password: z.string().min(1).max(200),
          otp: z.string().max(64).optional(),
        })
        .strict()
        .parse(req.body);
      const session = await login(db, body.email, body.password, cfg, body.otp);
      reply.setCookie("trade_session", session.token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: cfg.secureCookie,
        maxAge: 28800,
      });
      return { csrf: session.csrf };
    },
  );
  api.get("/auth/me", async (req) => actor(db, req));
  api.post("/auth/logout", async (req, reply) => {
    const user = await actor(db, req);
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [
      hash(req.cookies.trade_session!),
    ]);
    reply.clearCookie("trade_session", { path: "/" });
    await audit(db, null, user.id, "auth.logout", user.id);
    return { ok: true };
  });
  api.post("/auth/password", async (req) => {
    const user = await actor(db, req),
      b = z
        .object({
          current: z.string().max(200),
          otp: z.string().max(64).optional(),
          password: z.string().min(12).max(200),
        })
        .strict()
        .parse(req.body);
    const { verifyPassword } = await import(
      "../../../packages/core/src/security.js"
    );
    const { reauthenticate } = await import(
      "../../../packages/core/src/mfa.js"
    );
    await reauthenticate(
      db,
      { ...cfg, requireMfa: false },
      user.id,
      b.current,
      b.otp,
    );
    const old = (
      await db.query("SELECT password_hash FROM operators WHERE id=$1", [
        user.id,
      ])
    ).rows[0];
    insist(
      await verifyPassword(b.current, old.password_hash),
      403,
      "invalid_credentials",
    );
    await transaction(db, async (sql) => {
      const changed = await sql.query(
        "UPDATE operators SET password_hash=$2 WHERE id=$1 AND password_hash=$3 AND enabled",
        [user.id, await passwordHash(b.password), old.password_hash],
      );
      insist(changed.rowCount, 409, "operator_permission_changed");
      await sql.query("DELETE FROM sessions WHERE operator_id=$1", [user.id]);
      await audit(sql, null, user.id, "auth.password_changed", user.id);
    });
    return { ok: true };
  });
  const scoped = async (req: any) => {
    const user = await actor(db, req),
      app = identifier.parse(req.query.application_id);
    requireScope(user, app);
    return { user, app };
  };
  const appRow = async (app: string) =>
    (await db.query("SELECT * FROM applications WHERE id=$1", [app])).rows[0];
  api.get("/admin/applications", async (req) => {
    const user = await actor(db, req);
    return (
      await db.query(
        "SELECT a.*,(SELECT count(*)::int FROM event_inbox WHERE application_id=a.id AND state<>'applied') pending_events,(SELECT count(*)::int FROM event_conflicts WHERE application_id=a.id AND resolved_at IS NULL) conflicts FROM applications a WHERE id=ANY($1) ORDER BY (a.source_mode='mishu') DESC,a.created_at,a.id",
        [user.scopes],
      )
    ).rows.map((a) => ({
      ...a,
      management_available: !!(a.management_enabled && cfg.managementEnabled),
    }));
  });
  api.get("/admin/overview", async (req) => {
    const { app } = await scoped(req),
      q = req.query as any,
      filter = filtersSchema.parse({
        from: q.from || undefined,
        to: q.to || undefined,
      });
    return overview(db, app, filter);
  });
  for (const dataset of datasets)
    api.get("/admin/" + dataset, async (req) => {
      const { app } = await scoped(req),
        { application_id, ...filters } = req.query as any;
      return listData(db, app, dataset, filtersSchema.parse(filters));
    });
  api.get("/admin/trades/:id", async (req) => {
    const { app } = await scoped(req),
      key = identifier.parse((req.params as any).id);
    const t = (
      await db.query(
        "SELECT document FROM trade_projections WHERE application_id=$1 AND id=$2",
        [app, key],
      )
    ).rows[0];
    insist(t, 404, "trade_not_found");
    return {
      trade: t.document,
      journals: (
        await db.query(
          "SELECT document FROM journal_transactions WHERE application_id=$1 AND reference_id=$2 ORDER BY occurred_at,id",
          [app, key],
        )
      ).rows.map((r) => r.document),
      operations: (
        await db.query(
          "SELECT * FROM operation_requests WHERE application_id=$1 AND trade_id=$2 ORDER BY created_at DESC",
          [app, key],
        )
      ).rows,
      escrow:
        (
          await db.query(
            "SELECT balance FROM account_projections WHERE application_id=$1 AND id=$2",
            [app, "escrow:" + key],
          )
        ).rows[0]?.balance || "0",
    };
  });
  api.get("/admin/operation-requests", async (req) => {
    const { app } = await scoped(req);
    return (
      await db.query(
        "SELECT o.*,r.name requester_name,p.name approver_name,(t.version>=(o.receipt->>'version')::bigint) projection_synced FROM operation_requests o JOIN operators r ON r.id=o.requester_id LEFT JOIN operators p ON p.id=o.approver_id LEFT JOIN trade_projections t ON t.application_id=o.application_id AND t.id=o.trade_id WHERE o.application_id=$1 ORDER BY o.created_at DESC LIMIT 200",
        [app],
      )
    ).rows;
  });
  api.post("/admin/operation-requests", async (req) => {
    const user = await actor(db, req),
      b = z
        .object({
          application_id: identifier,
          trade_id: identifier,
          reason: z.string().trim().min(5).max(1000),
          idempotency_key: identifier,
        })
        .strict()
        .parse(req.body);
    return createOperation(
      db,
      cfg,
      user,
      b.application_id,
      b.trade_id,
      b.reason,
      b.idempotency_key,
    );
  });
  for (const action of ["approve", "reject", "cancel"] as const)
    api.post("/admin/operation-requests/:id/" + action, async (req) => {
      const user = await actor(db, req),
        b = z
          .object({ reason: z.string().trim().min(5).max(1000) })
          .strict()
          .parse(req.body);
      return decideOperation(
        db,
        user,
        identifier.parse((req.params as any).id),
        action,
        b.reason,
      );
    });
  api.get("/admin/cases", async (req) => {
    const { app } = await scoped(req);
    return (
      await db.query(
        "SELECT c.*,o.name owner_name,COALESCE((SELECT jsonb_agg(jsonb_build_object('note',n.note,'at',n.created_at,'actor_id',n.actor_id) ORDER BY n.id) FROM case_notes n WHERE n.case_id=c.id),'[]') notes FROM cases c LEFT JOIN operators o ON o.id=c.owner_id WHERE c.application_id=$1 ORDER BY c.updated_at DESC LIMIT 200",
        [app],
      )
    ).rows;
  });
  api.post("/admin/cases", async (req) => {
    const user = await actor(db, req);
    requireRole(user, "operator");
    const b = z
      .object({
        application_id: identifier,
        trade_id: identifier.optional(),
        title: z.string().trim().min(5).max(200),
        note: z.string().trim().min(5).max(2000),
      })
      .strict()
      .parse(req.body);
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
        "INSERT INTO cases(id,application_id,trade_id,title,created_by) VALUES($1,$2,$3,$4,$5)",
        [key, b.application_id, b.trade_id || null, b.title, user.id],
      );
      await sql.query(
        "INSERT INTO case_notes(case_id,actor_id,note) VALUES($1,$2,$3)",
        [key, user.id, b.note],
      );
      await audit(sql, b.application_id, user.id, "case.created", key, {
        note: b.note,
      });
    });
    return { id: key };
  });
  api.post("/admin/cases/:id", async (req) => {
    const user = await actor(db, req);
    requireRole(user, "operator");
    const b = z
      .object({
        action: z.enum(["claim", "note", "close"]),
        note: z.string().trim().min(5).max(2000),
      })
      .strict()
      .parse(req.body);
    return transaction(db, async (sql) => {
      const key = identifier.parse((req.params as any).id),
        c = (
          await sql.query("SELECT * FROM cases WHERE id=$1 FOR UPDATE", [key])
        ).rows[0];
      insist(c, 404, "case_not_found");
      requireScope(user, c.application_id);
      insist(c.state === "open", 409, "case_closed");
      if (b.action === "claim") {
        insist(
          !c.owner_id || c.owner_id === user.id,
          409,
          "case_already_claimed",
        );
        await sql.query("UPDATE cases SET owner_id=$2 WHERE id=$1", [
          key,
          user.id,
        ]);
      }
      if (b.action === "close") {
        insist(c.owner_id === user.id, 403, "case_owner_only");
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
        await sql.query(
          "UPDATE cases SET state='closed',resolution=$2 WHERE id=$1",
          [key, b.note],
        );
      }
      await sql.query(
        "INSERT INTO case_notes(case_id,actor_id,note) VALUES($1,$2,$3)",
        [key, user.id, b.note],
      );
      await sql.query("UPDATE cases SET updated_at=now() WHERE id=$1", [key]);
      await audit(sql, c.application_id, user.id, "case." + b.action, key, {
        note: b.note,
      });
      return { ok: true };
    });
  });
  function jobView(j: any) {
    const { payload, lease_token, lease_until, ...safe } = j;
    const { directory, ...result } = safe.result || {};
    return {
      ...safe,
      result,
      settings: j.kind === "export" ? payload : undefined,
    };
  }
  for (const [route, kind] of [
    ["exports", "export"],
    ["reconciliation-runs", "reconcile"],
    ["imports", "import"],
  ] as const) {
    api.get("/admin/" + route, async (req) => {
      const { app, user } = await scoped(req);
      return (
        await db.query(
          `SELECT * FROM jobs WHERE application_id=$1 AND kind=$2${kind === "export" ? " AND owner_id=$3" : ""} ORDER BY created_at DESC LIMIT 100`,
          kind === "export" ? [app, kind, user.id] : [app, kind],
        )
      ).rows.map(jobView);
    });
    api.post("/admin/" + route, async (req) => {
      const user = await actor(db, req),
        { application_id, ...raw } = z
          .object({ application_id: identifier })
          .passthrough()
          .parse(req.body),
        app = application_id;
      requireScope(user, app);
      if (kind !== "export") requireRole(user, "operator", "admin");
      const payload =
        kind === "export"
          ? exportSchema.parse(raw)
          : z.object({}).strict().parse(raw);
      return transaction(db, async (sql) => {
        const application = (
          await sql.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
            app,
          ])
        ).rows[0];
        insist(application, 404, "application_not_found");
        const pending = (
          await sql.query(
            "SELECT count(*)::int n FROM jobs WHERE application_id=$1 AND kind=$2 AND state IN ('queued','running')",
            [app, kind],
          )
        ).rows[0].n;
        insist(
          pending < (kind === "export" ? 3 : 1),
          429,
          "job_already_queued",
        );
        if (kind === "import")
          insist(!application.initialized, 409, "already_initialized");
        return { id: await queueJob(sql, app, user.id, kind, payload) };
      });
    });
  }
  for (const action of ["cancel", "retry"] as const)
    api.post("/admin/exports/:id/" + action, async (req) => {
      const user = await actor(db, req),
        key = identifier.parse((req.params as any).id);
      return transaction(db, async (sql) => {
        const j = (
          await sql.query(
            "SELECT * FROM jobs WHERE id=$1 AND kind='export' FOR UPDATE",
            [key],
          )
        ).rows[0];
        insist(j, 404, "export_not_found");
        requireScope(user, j.application_id);
        insist(j.owner_id === user.id, 403, "export_owner_only");
        if (action === "cancel") {
          insist(
            ["queued", "running"].includes(j.state),
            409,
            "export_not_running",
          );
          await sql.query(
            "UPDATE jobs SET cancel_requested=true,state=CASE WHEN state='queued' THEN 'canceled' ELSE state END,updated_at=now() WHERE id=$1",
            [key],
          );
        } else {
          insist(
            ["failed", "canceled", "expired"].includes(j.state),
            409,
            "export_not_retryable",
          );
          return {
            id: await queueJob(
              sql,
              j.application_id,
              user.id,
              "export",
              j.payload,
            ),
          };
        }
        await audit(sql, j.application_id, user.id, "export." + action, key);
        return { ok: true };
      });
    });
  api.get("/admin/exports/:id/files/:name", async (req, reply) => {
    const user = await actor(db, req),
      p = z
        .object({
          id: identifier,
          name: z.string().regex(/^[a-z-]+-\d{3,6}\.(xlsx|jsonl\.gz)$/),
        })
        .parse(req.params);
    const j = (
      await db.query("SELECT * FROM jobs WHERE id=$1 AND kind='export'", [p.id])
    ).rows[0];
    insist(j, 404, "export_not_found");
    requireScope(user, j.application_id);
    insist(j.owner_id === user.id, 403, "export_owner_only");
    insist(
      j.state === "succeeded" && new Date(j.expires_at).getTime() > Date.now(),
      410,
      "export_expired",
    );
    insist(
      j.result.parts.some((f: any) => f.name === p.name),
      404,
      "file_not_found",
    );
    const file = path.resolve(cfg.dataDir, j.result.directory, p.name);
    insist(
      file.startsWith(path.resolve(cfg.dataDir, "exports") + path.sep) &&
        fs.existsSync(file),
      404,
      "file_not_found",
    );
    await audit(db, j.application_id, user.id, "export.download", j.id, {
      name: p.name,
    });
    return reply
      .header("Content-Disposition", `attachment; filename="${p.name}"`)
      .type(
        p.name.endsWith(".xlsx")
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/gzip",
      )
      .send(fs.createReadStream(file));
  });
  api.get("/admin/reconciliation-findings", async (req) => {
    const { app } = await scoped(req);
    return (
      await db.query(
        "SELECT * FROM reconciliation_findings WHERE application_id=$1 ORDER BY updated_at DESC LIMIT 200",
        [app],
      )
    ).rows;
  });
  api.post("/admin/reconciliation-findings/:id/claim", async (req) => {
    const user = await actor(db, req);
    requireRole(user, "operator");
    return transaction(db, async (sql) => {
      const f = (
        await sql.query(
          "SELECT * FROM reconciliation_findings WHERE id=$1 FOR UPDATE",
          [identifier.parse((req.params as any).id)],
        )
      ).rows[0];
      insist(f, 404, "finding_not_found");
      requireScope(user, f.application_id);
      insist(!f.owner_id || f.owner_id === user.id, 409, "already_claimed");
      await sql.query(
        "UPDATE reconciliation_findings SET owner_id=$2 WHERE id=$1",
        [f.id, user.id],
      );
      await audit(sql, f.application_id, user.id, "finding.claimed", f.id);
      return { ok: true };
    });
  });
  api.get("/admin/events", async (req) => {
    const { app } = await scoped(req);
    return (
      await db.query(
        "SELECT seq,event_id,source_cursor,previous_cursor,state,attempts,error,received_at,applied_at FROM event_inbox WHERE application_id=$1 ORDER BY seq DESC LIMIT 200",
        [app],
      )
    ).rows;
  });
  api.get("/admin/event-conflicts", async (req) => {
    const { app } = await scoped(req);
    return (
      await db.query(
        "SELECT * FROM event_conflicts WHERE application_id=$1 ORDER BY created_at DESC LIMIT 100",
        [app],
      )
    ).rows;
  });
  api.post("/admin/event-conflicts/:id/resolve", async (req) => {
    const user = await actor(db, req);
    requireRole(user, "operator", "admin");
    const key = z
        .string()
        .regex(/^[1-9]\d{0,18}$/)
        .parse((req.params as any).id),
      b = z
        .object({ reason: z.string().trim().min(5).max(1000) })
        .strict()
        .parse(req.body);
    return transaction(db, async (sql) => {
      const conflict = (
        await sql.query(
          "SELECT * FROM event_conflicts WHERE id=$1 FOR UPDATE",
          [key],
        )
      ).rows[0];
      insist(conflict, 404, "conflict_not_found");
      requireScope(user, conflict.application_id);
      insist(!conflict.resolved_at, 409, "conflict_already_resolved");
      await sql.query(
        "UPDATE event_conflicts SET resolved_at=now(),resolved_by=$2,resolution_note=$3 WHERE id=$1",
        [key, user.id, b.reason],
      );
      await audit(
        sql,
        conflict.application_id,
        user.id,
        "event.conflict_reviewed",
        conflict.event_id,
        {
          reason: b.reason,
          original_digest: conflict.original_digest,
          incoming_digest: conflict.incoming_digest,
        },
      );
      return { ok: true };
    });
  });
  api.post("/admin/events/:id/retry", async (req) => {
    const { app, user } = await scoped(req);
    requireRole(user, "operator", "admin");
    const key = identifier.parse((req.params as any).id);
    const r = await db.query(
      "UPDATE event_inbox SET state='received',error=NULL WHERE application_id=$1 AND event_id=$2 AND state IN ('quarantined','blocked')",
      [app, key],
    );
    insist(r.rowCount, 409, "event_not_retryable");
    await audit(db, app, user.id, "event.retry", key);
    return { ok: true };
  });
  api.get("/admin/audit-events", async (req) => {
    const { app, user } = await scoped(req);
    requireRole(user, "auditor", "admin");
    const q = z
      .object({
        before: z
          .string()
          .regex(/^[1-9]\d{0,18}$/)
          .optional(),
      })
      .parse(req.query);
    return (
      await db.query(
        "SELECT * FROM audit_events WHERE (application_id=$1 OR (application_id IS NULL AND actor_id=$2)) AND seq<$3 ORDER BY seq DESC LIMIT 100",
        [app, user.id, q.before || "9223372036854775807"],
      )
    ).rows;
  });
  api.get("/admin/operators", async (req) => {
    const user = await actor(db, req);
    requireRole(user, "admin");
    return (
      await db.query(
        "SELECT o.id,o.email,o.name,o.roles,o.enabled,COALESCE(array_agg(s.application_id) FILTER (WHERE s.application_id IS NOT NULL),'{}') scopes FROM operators o LEFT JOIN operator_scopes s ON s.operator_id=o.id WHERE NOT EXISTS (SELECT 1 FROM operator_scopes hidden WHERE hidden.operator_id=o.id AND NOT (hidden.application_id=ANY($1))) AND EXISTS (SELECT 1 FROM operator_scopes visible WHERE visible.operator_id=o.id AND visible.application_id=ANY($1)) GROUP BY o.id ORDER BY o.created_at",
        [user.scopes],
      )
    ).rows;
  });
  api.post("/admin/operators", async (req) => {
    const user = await actor(db, req);
    requireRole(user, "admin");
    const b = z
      .object({
        email: z.email().max(254),
        name: z.string().trim().min(1).max(100),
        roles: z.array(z.enum(roles)).min(1),
        scopes: z.array(identifier).min(1),
      })
      .strict()
      .parse(req.body);
    for (const app of b.scopes) requireScope(user, app);
    const password = randomBytes(18).toString("base64url"),
      key = id("operator");
    await transaction(db, async (sql) => {
      await sql.query(
        "INSERT INTO operators(id,email,name,password_hash,roles) VALUES($1,$2,$3,$4,$5)",
        [
          key,
          b.email.toLowerCase(),
          b.name,
          await passwordHash(password),
          b.roles,
        ],
      );
      for (const app of new Set(b.scopes))
        await sql.query("INSERT INTO operator_scopes VALUES($1,$2)", [
          key,
          app,
        ]);
      await audit(sql, null, user.id, "operator.created", key, {
        roles: b.roles,
        scopes: b.scopes,
      });
    });
    return { id: key, password };
  });
  api.post("/admin/operators/:id/access", async (req) => {
    const user = await actor(db, req);
    requireRole(user, "admin");
    const key = identifier.parse((req.params as any).id);
    insist(key !== user.id, 403, "self_access_change_forbidden");
    const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await transaction(db, async (sql) => {
      const target = (
        await sql.query(
          "SELECT application_id FROM operator_scopes WHERE operator_id=$1",
          [key],
        )
      ).rows;
      for (const s of target) requireScope(user, s.application_id);
      const r = await sql.query("UPDATE operators SET enabled=$2 WHERE id=$1", [
        key,
        b.enabled,
      ]);
      insist(r.rowCount, 404, "operator_not_found");
      await sql.query("DELETE FROM sessions WHERE operator_id=$1", [key]);
      await audit(sql, null, user.id, "operator.access_changed", key, b);
    });
    return { ok: true };
  });
  api.get("/admin/credentials", async (req) => {
    const { app, user } = await scoped(req);
    requireRole(user, "admin");
    return (
      await db.query(
        "SELECT id,label,permissions,revoked_at,created_at FROM service_credentials WHERE application_id=$1 ORDER BY created_at DESC",
        [app],
      )
    ).rows;
  });
  api.post("/admin/credentials", async (req) => {
    const user = await actor(db, req);
    requireRole(user, "admin");
    const b = z
      .object({
        application_id: identifier,
        label: z.string().trim().min(1).max(100),
        permissions: z
          .array(z.enum(["events:write", "sync:read", "imports:write"]))
          .min(1),
      })
      .strict()
      .parse(req.body);
    requireScope(user, b.application_id);
    const secret = randomBytes(32).toString("base64url"),
      key = id("key");
    await transaction(db, async (sql) => {
      await sql.query(
        "INSERT INTO service_credentials(id,application_id,label,secret_hash,permissions) VALUES($1,$2,$3,$4,$5)",
        [key, b.application_id, b.label, hash(secret), b.permissions],
      );
      await audit(sql, b.application_id, user.id, "credential.created", key, {
        permissions: b.permissions,
      });
    });
    return { id: key, token: secret };
  });
  api.post("/admin/credentials/:id/revoke", async (req) => {
    const user = await actor(db, req);
    requireRole(user, "admin");
    return transaction(db, async (sql) => {
      const c = (
        await sql.query(
          "SELECT * FROM service_credentials WHERE id=$1 FOR UPDATE",
          [identifier.parse((req.params as any).id)],
        )
      ).rows[0];
      insist(c, 404, "credential_not_found");
      requireScope(user, c.application_id);
      await sql.query(
        "UPDATE service_credentials SET revoked_at=now() WHERE id=$1",
        [c.id],
      );
      await audit(sql, c.application_id, user.id, "credential.revoked", c.id);
      return { ok: true };
    });
  });
  api.post("/v1/events/batches", async (req) => {
    const app = await service(db, req, "events:write"),
      b = batchSchema.parse(req.body),
      results = [];
    for (const event of b.events)
      results.push(await receiveEvent(db, app, event));
    return { results };
  });
  api.get("/v1/events/:id", async (req) => {
    const app = await service(db, req, "sync:read"),
      row = (
        await db.query(
          "SELECT event_id,state,attempts,error,received_at,applied_at FROM event_inbox WHERE application_id=$1 AND event_id=$2",
          [app, identifier.parse((req.params as any).id)],
        )
      ).rows[0];
    insist(row, 404, "event_not_found");
    return row;
  });
  api.get("/v1/sync/status", async (req) => {
    const app = await service(db, req, "sync:read");
    return {
      application: await appRow(app),
      states: (
        await db.query(
          "SELECT state,count(*)::text count FROM event_inbox WHERE application_id=$1 GROUP BY state",
          [app],
        )
      ).rows,
    };
  });
  api.post("/v1/imports", { bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const app = await service(db, req, "imports:write");
    insist(!(await appRow(app)).initialized, 409, "already_initialized");
    const b = snapshotSchema.parse(req.body);
    return {
      id: await transaction(db, (sql) =>
        queueJob(sql, app, null, "import", { snapshot: b }),
      ),
    };
  });
  api.get("/v1/imports/:id", async (req) => {
    const app = await service(db, req, "sync:read"),
      row = (
        await db.query(
          "SELECT * FROM jobs WHERE id=$1 AND application_id=$2 AND kind='import'",
          [identifier.parse((req.params as any).id), app],
        )
      ).rows[0];
    insist(row, 404, "import_not_found");
    return jobView(row);
  });
  const dist = path.join(ROOT, "apps/admin/dist");
  if (fs.existsSync(dist)) {
    await api.register(staticFiles, { root: dist, prefix: "/", index: false });
    api.get("/", async (req, reply) => reply.sendFile("index.html"));
  }
  return api;
}
