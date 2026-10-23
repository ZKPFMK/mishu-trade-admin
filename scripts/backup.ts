import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { config, ROOT } from "../packages/core/src/config.js";
const cfg = config(),
  url = new URL(cfg.databaseUrl),
  out = path.resolve(
    process.argv[2] ||
      path.join(
        ROOT,
        ".local/backups",
        new Date().toISOString().replace(/[:.]/g, "-"),
      ),
  );
if (fs.existsSync(out))
  throw new Error(
    "Choose a new backup directory; existing backups are not overwritten",
  );
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const tool =
    process.env.PG_DUMP_PATH ||
    [
      path.join(
        ROOT,
        `node_modules/@embedded-postgres/${process.platform}-${process.arch}/native/bin/pg_dump`,
      ),
      "/opt/homebrew/opt/libpq/bin/pg_dump",
      "/usr/local/opt/libpq/bin/pg_dump",
    ].find(fs.existsSync) ||
    "pg_dump",
  file = path.join(out, "database.dump");
try {
  await promisify(execFile)(
    tool,
    [
      "--format=custom",
      "--no-owner",
      "--file=" + file,
      "--host=" + url.hostname,
      "--port=" + (url.port || "5432"),
      "--username=" + decodeURIComponent(url.username),
      "--dbname=" + url.pathname.slice(1),
    ],
    {
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
      timeout: 120000,
      maxBuffer: 8192,
    },
  );
  fs.chmodSync(file, 0o600);
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        format: "postgres-custom",
        sha256: hash.digest("hex"),
        exports_included: false,
        credentials_included: false,
        restore_note:
          "Restore into a new database. Pause workers and disable source writes; expire download tasks whose files are not backed up. Keep .env and source credentials separately. Pending commands must query original source receipts before execution.",
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log("Backup completed: " + out);
} catch {
  throw new Error(
    "Backup failed. Verify pg_dump and database connectivity. No credentials were printed.",
  );
}
