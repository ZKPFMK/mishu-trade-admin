import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { config } from "../packages/core/src/config.js";
const cfg = config(),
  url = new URL(cfg.databaseUrl),
  dir = path.join(cfg.dataDir, "postgres");
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  port: Number(url.port),
  persistent: true,
  authMethod: "scram-sha-256",
  postgresFlags: ["-h", "127.0.0.1", "-k", cfg.dataDir],
  onLog: () => {},
  onError: (e) => console.error(String(e).slice(0, 500)),
});
fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(path.join(dir, "PG_VERSION"))) await pg.initialise();
await pg.start();
const client = pg.getPgClient();
await client.connect();
const name = url.pathname.slice(1);
if (
  !(await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]))
    .rowCount
)
  await pg.createDatabase(name);
await client.end();
console.log("Project PostgreSQL ready");
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  clearInterval(keepAlive);
  await pg.stop();
  process.exit(0);
};
const keepAlive = setInterval(() => {}, 10000);
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
