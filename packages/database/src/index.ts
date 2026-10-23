import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../core/src/config.js";
export type Sql = Pick<pg.PoolClient, "query">;
export function database(url: string) {
  return new pg.Pool({
    connectionString: url,
    max: 12,
    connectionTimeoutMillis: 5000,
  });
}
export async function transaction<T>(
  pool: pg.Pool,
  fn: (sql: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const sql = await pool.connect();
  try {
    await sql.query("BEGIN");
    const value = await fn(sql);
    await sql.query("COMMIT");
    return value;
  } catch (e) {
    await sql.query("ROLLBACK");
    throw e;
  } finally {
    sql.release();
  }
}
export async function migrate(pool: pg.Pool) {
  await transaction(pool, async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(89208922)");
    await sql.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of fs
      .readdirSync(path.join(ROOT, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (
        (
          await sql.query("SELECT 1 FROM schema_migrations WHERE name=$1", [
            name,
          ])
        ).rowCount
      )
        continue;
      await sql.query(
        fs.readFileSync(path.join(ROOT, "migrations", name), "utf8"),
      );
      await sql.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
  });
}
