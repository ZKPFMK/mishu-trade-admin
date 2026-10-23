/** Local provisioning only; never opens the source SQLite or executes a business command. */
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { config, ROOT } from "../packages/core/src/config.js";
import {
  database,
  migrate,
  transaction,
} from "../packages/database/src/index.js";
import { audit } from "../packages/core/src/audit.js";

const cfg = config(),
  db = database(cfg.databaseUrl);
function save(file: string, updates: Record<string, string>) {
  let body = fs.readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(updates))
    body =
      body
        .replace(new RegExp("^(?:export\\s+)?" + key + "\\s*=.*$", "gm"), "")
        .trimEnd() +
      "\n" +
      key +
      "=" +
      JSON.stringify(value) +
      "\n";
  const temp = file + ".management.tmp";
  fs.writeFileSync(temp, body, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}
try {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".local/mishu-connection.json"), "utf8"),
  );
  const url = new URL(manifest.source_url);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    cfg.sourceUrl !== url.origin
  )
    throw Error("Requires the existing local MiShu connection.");
  const response = await fetch(new URL("/internal/trade-admin/status", url), {
    headers: { authorization: "Bearer " + cfg.sourceReadToken },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("Source status unavailable.");
  const status = (await response.json()) as any;
  const app = (
    await db.query("SELECT * FROM applications WHERE id=$1", [
      manifest.application_id,
    ])
  ).rows[0];
  if (
    !app?.initialized ||
    app.source_mode !== "mishu" ||
    app.environment !== "test" ||
    !app.applied_cursor?.startsWith(status.source_id + ":")
  )
    throw Error("Source identity or local application is not verified.");
  const operators = (
    await db.query(
      "SELECT id,email,roles FROM operators WHERE enabled AND email IN ('admin@trade-admin.local','approver@trade-admin.local')",
    )
  ).rows;
  const requester = operators.find(
    (x) =>
      x.email === "admin@trade-admin.local" && x.roles.includes("operator"),
  );
  const approver = operators.find(
    (x) =>
      x.email === "approver@trade-admin.local" && x.roles.includes("approver"),
  );
  if (!requester || !approver || requester.id === approver.id)
    throw Error("Two distinct local operators are required.");
  const sourceFile = path.join(fs.realpathSync(manifest.platform), ".env"),
    adminFile = path.join(ROOT, ".env");
  const source = parseEnv(fs.readFileSync(sourceFile, "utf8")),
    admin = parseEnv(fs.readFileSync(adminFile, "utf8"));
  if (
    source.TRADE_ADMIN_READ_TOKEN !== cfg.sourceReadToken ||
    !/^[a-f0-9]{64}$/i.test(admin.TRADE_ENCRYPTION_KEY || "")
  )
    throw Error("Read credentials or MFA encryption key mismatch.");
  const token =
    source.TRADE_ADMIN_COMMAND_TOKEN ||
    admin.SOURCE_COMMAND_TOKEN ||
    randomBytes(32).toString("hex");
  if (
    token.length < 32 ||
    token === cfg.sourceReadToken ||
    /[\r\n]/.test(token)
  )
    throw Error("Independent command credential required.");
  if (
    source.TRADE_ADMIN_COMMAND_TOKEN &&
    admin.SOURCE_COMMAND_TOKEN &&
    source.TRADE_ADMIN_COMMAND_TOKEN !== admin.SOURCE_COMMAND_TOKEN
  )
    throw Error(
      "Existing command credentials differ; resolve them before enabling.",
    );
  if (
    source.TRADE_ADMIN_APPLICATION_ID &&
    source.TRADE_ADMIN_APPLICATION_ID !== app.id
  )
    throw Error("Source command application is already bound elsewhere.");
  const backup = path.join(
    ROOT,
    ".local/connection-backups",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const [file, name] of [
    [sourceFile, "platform.env"],
    [adminFile, "admin.env"],
  ]) {
    fs.copyFileSync(file, path.join(backup, name));
    fs.chmodSync(path.join(backup, name), 0o600);
  }
  await migrate(db);
  save(sourceFile, {
    TRADE_ADMIN_COMMAND_TOKEN: token,
    TRADE_ADMIN_APPLICATION_ID: app.id,
    TRADE_ADMIN_COMMANDS_ENABLED: "1",
    TRADE_ADMIN_REFUND_LIMIT: source.TRADE_ADMIN_REFUND_LIMIT || "100000",
    TRADE_ADMIN_ADJUSTMENT_LIMIT: source.TRADE_ADMIN_ADJUSTMENT_LIMIT || "1000",
    TRADE_ADMIN_ADJUSTMENT_DAILY_LIMIT:
      source.TRADE_ADMIN_ADJUSTMENT_DAILY_LIMIT || "10000",
  });
  save(adminFile, { SOURCE_COMMAND_TOKEN: token, MANAGEMENT_ENABLED: "1" });
  await transaction(db, async (sql) => {
    await sql.query(
      "UPDATE applications SET management_enabled=true WHERE id=$1",
      [app.id],
    );
    await sql.query(
      "INSERT INTO operator_scopes VALUES($1,$2) ON CONFLICT DO NOTHING",
      [approver.id, app.id],
    );
    await audit(sql, app.id, "local-cli", "management.enabled", app.id, {
      source_id: status.source_id,
      approver_id: approver.id,
      mode: "local",
      environment: "test",
    });
  });
  console.log(
    "Local management configured for " +
      app.id +
      ". Restart both services. No order, balance or password was changed; credentials were not printed.",
  );
} finally {
  await db.end();
}
