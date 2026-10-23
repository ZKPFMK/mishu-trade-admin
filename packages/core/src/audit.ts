import type { Sql } from "../../database/src/index.js";
export async function audit(
  db: Sql,
  app: string | null,
  actor: string | null,
  action: string,
  object: string,
  detail: unknown = {},
) {
  await db.query(
    "INSERT INTO audit_events(application_id,actor_id,action,object_id,detail) VALUES($1,$2,$3,$4,$5)",
    [app, actor, action, object, JSON.stringify(detail)],
  );
}
