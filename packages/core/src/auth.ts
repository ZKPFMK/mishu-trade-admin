import type pg from "pg";
import type { FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { hash, insist, verifyPassword } from "./security.js";
import { audit } from "./audit.js";
import { transaction } from "../../database/src/index.js";
export type Actor = {
  id: string;
  email: string;
  name: string;
  roles: string[];
  scopes: string[];
  csrf: string;
};
export async function login(
  db: pg.Pool,
  email: string,
  password: string,
  cfg?: import("./config.js").Config,
  otp = "",
) {
  const row = (
    await db.query("SELECT * FROM operators WHERE email=$1", [
      email.toLowerCase(),
    ])
  ).rows[0];
  const valid = await verifyPassword(
    password,
    row?.password_hash || "00000000000000000000000000000000:" + "00".repeat(64),
  );
  insist(row?.enabled && valid, 401, "invalid_credentials");
  const { reauthenticate, securityState } = await import("./mfa.js");
  const proof = cfg
    ? await reauthenticate(
        db,
        { ...cfg, requireMfa: false },
        row.id,
        password,
        otp,
      )
    : null;
  const token = randomBytes(32).toString("base64url"),
    csrf = randomBytes(24).toString("base64url");
  await transaction(db, async (sql) => {
    const current = (
      await sql.query(
        "SELECT password_hash,enabled FROM operators WHERE id=$1 FOR UPDATE",
        [row.id],
      )
    ).rows[0];
    await sql.query(
      "SELECT operator_id FROM operator_mfa WHERE operator_id=$1 FOR UPDATE",
      [row.id],
    );
    insist(
      current?.enabled &&
        current.password_hash === row.password_hash &&
        (!proof ||
          (await securityState(sql, row.id))?.fingerprint ===
            proof.fingerprint),
      401,
      "invalid_credentials",
    );
    await sql.query(
      "INSERT INTO sessions(token_hash,operator_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
      [hash(token), row.id, csrf],
    );
    await audit(sql, null, row.id, "auth.login", row.id);
  });
  return { token, csrf };
}
export async function actor(db: pg.Pool, req: FastifyRequest): Promise<Actor> {
  const token = req.cookies.trade_session;
  insist(token, 401, "login_required");
  const r = (
    await db.query(
      "SELECT o.id,o.email,o.name,o.roles,s.csrf FROM sessions s JOIN operators o ON o.id=s.operator_id WHERE s.token_hash=$1 AND s.expires_at>now() AND o.enabled",
      [hash(token)],
    )
  ).rows[0];
  insist(r, 401, "session_expired");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
    insist(
      typeof req.headers["x-csrf-token"] === "string" &&
        hash(req.headers["x-csrf-token"]) === hash(r.csrf),
      403,
      "csrf_invalid",
    );
  const scopes = (
    await db.query(
      "SELECT application_id FROM operator_scopes WHERE operator_id=$1",
      [r.id],
    )
  ).rows.map((x) => x.application_id);
  return { ...r, scopes };
}
export function requireRole(actor: Actor, ...allowed: string[]) {
  insist(
    actor.roles.some((r) => allowed.includes(r)),
    403,
    "role_forbidden",
  );
}
export function requireScope(actor: Actor, app: string) {
  insist(actor.scopes.includes(app), 403, "application_forbidden");
}
export async function service(
  db: pg.Pool,
  req: FastifyRequest,
  permission: string,
) {
  const raw = req.headers.authorization;
  insist(raw?.startsWith("Bearer "), 401, "service_token_required");
  const c = (
    await db.query(
      "SELECT c.* FROM service_credentials c JOIN applications a ON a.id=c.application_id WHERE secret_hash=$1 AND revoked_at IS NULL AND a.enabled",
      [hash(raw!.slice(7))],
    )
  ).rows[0];
  insist(c && c.permissions.includes(permission), 403, "service_forbidden");
  return c.application_id as string;
}
