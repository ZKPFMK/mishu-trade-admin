import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { config, ROOT } from "../packages/core/src/config.js";
import { database } from "../packages/database/src/index.js";
import { insist } from "../packages/core/src/security.js";
const folder = process.argv[2];
if (!folder)
  throw new Error("Usage: npm run backup:verify -- /absolute/backup/directory");
const file = path.resolve(folder, "database.dump"),
  manifest = JSON.parse(
    fs.readFileSync(path.resolve(folder, "manifest.json"), "utf8"),
  ),
  hash = createHash("sha256");
for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
insist(hash.digest("hex") === manifest.sha256, 422, "backup_checksum_mismatch");
const cfg = config(),
  url = new URL(cfg.databaseUrl),
  owner = database(cfg.databaseUrl),
  name = "trade_restore_" + randomBytes(8).toString("hex"),
  tool =
    process.env.PG_RESTORE_PATH ||
    [
      path.join(
        ROOT,
        `node_modules/@embedded-postgres/${process.platform}-${process.arch}/native/bin/pg_restore`,
      ),
      "/opt/homebrew/opt/libpq/bin/pg_restore",
      "/usr/local/opt/libpq/bin/pg_restore",
    ].find(fs.existsSync) ||
    "pg_restore";
let restored: ReturnType<typeof database> | undefined,
  created = false;
try {
  await owner.query(`CREATE DATABASE ${name}`);
  created = true;
  await promisify(execFile)(
    tool,
    [
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--host=" + url.hostname,
      "--port=" + (url.port || "5432"),
      "--username=" + decodeURIComponent(url.username),
      "--dbname=" + name,
      file,
    ],
    {
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
      timeout: 120000,
      maxBuffer: 8192,
    },
  );
  const target = new URL(url);
  target.pathname = "/" + name;
  restored = database(target.toString());
  const counts = (
    await restored.query(
      "SELECT (SELECT count(*) FROM trade_projections)::text trades,(SELECT count(*) FROM journal_entries)::text entries,(SELECT count(*) FROM audit_events)::text audit_events",
    )
  ).rows[0];
  const bad = (
    await restored.query(
      "SELECT application_id,transaction_id FROM journal_entries GROUP BY application_id,transaction_id HAVING sum(amount)<>0",
    )
  ).rows;
  insist(bad.length === 0, 422, "restored_journal_not_balanced");
  await restored.query(
    "UPDATE jobs SET state='expired',result=NULL WHERE kind='export' AND state IN ('succeeded','running','queued')",
  );
  await restored.query("DELETE FROM sessions");
  console.log(
    "Isolated restore verified: " +
      JSON.stringify(counts) +
      ". Live database unchanged; scratch database removed.",
  );
} catch (e) {
  throw new Error(
    e instanceof Error && e.message === "restored_journal_not_balanced"
      ? e.message
      : "Restore verification failed; check the tool version, backup and database permissions.",
  );
} finally {
  await restored?.end();
  if (created) await owner.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await owner.end();
}
