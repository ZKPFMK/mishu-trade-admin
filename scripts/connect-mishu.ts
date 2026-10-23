/** Local provisioning only. Runtime adapters use HTTP and never open the source database. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { config, ROOT } from "../packages/core/src/config.js";
import {
  database,
  migrate,
  transaction,
} from "../packages/database/src/index.js";
import { audit } from "../packages/core/src/audit.js";
import { queueJob } from "../packages/core/src/sync.js";

const { values } = parseArgs({
  options: {
    platform: { type: "string" },
    source: { type: "string", default: "http://127.0.0.1:8787" },
    import: { type: "boolean", default: false },
  },
});
const appId = "mishu_local",
  metadata = path.join(ROOT, ".local/mishu-connection.json");
const cfg = config(),
  db = database(cfg.databaseUrl);
const readEnv = (file: string) =>
  fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
function saveEnv(file: string, updates: Record<string, string>) {
  let contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const matcher = new RegExp("^(?:export\\s+)?" + key + "\\s*=.*$", "gm");
    contents = contents.replace(matcher, "").replace(/\n{3,}/g, "\n\n");
    contents =
      contents.trimEnd() + "\n" + key + "=" + JSON.stringify(value) + "\n";
  }
  const temp = file + ".trade-admin.tmp";
  fs.writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}
try {
  await migrate(db);
  if (values.import) {
    if (!fs.existsSync(metadata))
      throw Error("Run connect:mishu -- --platform <checkout> first.");
    const saved = JSON.parse(fs.readFileSync(metadata, "utf8"));
    if (cfg.sourceUrl !== saved.source_url || !cfg.sourceReadToken)
      throw Error(
        "Configured source differs from the provisioned application.",
      );
    const r = await fetch(
      new URL("/internal/trade-admin/status", cfg.sourceUrl),
      {
        headers: { authorization: "Bearer " + cfg.sourceReadToken },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok)
      throw Error(
        "Source is not ready (HTTP " +
          r.status +
          "). Restart the source with its read token first.",
      );
    const status = (await r.json()) as any;
    if (
      status.schema_version !== 1 ||
      status.write_commands !== false ||
      !/^mishu_[a-f0-9]{32}$/.test(status.source_id)
    )
      throw Error("Unsupported source status.");
    await transaction(db, async (sql) => {
      const app = (
        await sql.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
          appId,
        ])
      ).rows[0];
      if (!app || app.source_mode !== "mishu")
        throw Error("Local source application not provisioned.");
      if (app.initialized) {
        if (!app.applied_cursor?.startsWith(status.source_id + ":"))
          throw Error(
            "Source database identity changed. Create a separate application; never overwrite an existing projection.",
          );
        console.log(
          "Already imported. Continuous HTTP synchronization remains active.",
        );
        return;
      }
      const pending = (
        await sql.query(
          "SELECT id FROM jobs WHERE application_id=$1 AND kind='import' AND state IN ('queued','running')",
          [appId],
        )
      ).rows[0];
      const job = pending?.id || (await queueJob(sql, appId, null, "import"));
      console.log("Historical import queued: " + job);
    });
  } else {
    if (!values.platform)
      throw Error(
        "Usage: npm run connect:mishu -- --platform /path/to/mishu-platform, then --import after restarting both services.",
      );
    const platform = fs.realpathSync(path.resolve(values.platform));
    if (
      !fs.existsSync(
        path.join(platform, "apps/server/src/routes/tradeAdmin.ts"),
      )
    )
      throw Error(
        "The selected checkout does not contain the MiShu trade-admin read adapter.",
      );
    const url = new URL(values.source);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw Error("This local setup command requires a loopback HTTP origin.");
    const sourceUrl = url.origin;
    const existing = (
      await db.query("SELECT * FROM applications WHERE source_mode='mishu'")
    ).rows;
    if (existing.some((a) => a.id !== appId))
      throw Error(
        "A different real source is already configured. Per-application source credentials are required before adding another.",
      );
    if (fs.existsSync(metadata)) {
      const saved = JSON.parse(fs.readFileSync(metadata, "utf8"));
      if (saved.platform !== platform || saved.source_url !== sourceUrl)
        throw Error(
          "Existing source connection differs. Refusing to repoint its financial history.",
        );
    } else if (existing.some((a) => a.initialized))
      throw Error(
        "An initialized source lacks its connection manifest. Verify its identity before provisioning.",
      );
    const operator = (
      await db.query(
        "SELECT id FROM operators WHERE email='admin@trade-admin.local' AND enabled AND 'admin'=ANY(roles)",
      )
    ).rows[0];
    if (!operator)
      throw Error("Bootstrap the local administrator before connecting.");
    const mainEnv = path.join(platform, ".env"),
      adminEnv = path.join(ROOT, ".env");
    const token =
      readEnv(mainEnv).TRADE_ADMIN_READ_TOKEN ||
      randomBytes(32).toString("hex");
    if (token.length < 32 || /[\r\n]/.test(token))
      throw Error(
        "Existing source token must be a single line of at least 32 characters.",
      );
    const backup = path.join(
      ROOT,
      ".local/connection-backups",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const [file, name] of [
      [mainEnv, "platform.env"],
      [adminEnv, "admin.env"],
    ])
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, path.join(backup, name));
        fs.chmodSync(path.join(backup, name), 0o600);
      }
    saveEnv(mainEnv, { TRADE_ADMIN_READ_TOKEN: token });
    saveEnv(adminEnv, {
      SOURCE_MODE: "mishu",
      SOURCE_URL: sourceUrl,
      SOURCE_READ_TOKEN: token,
    });
    await transaction(db, async (sql) => {
      await sql.query("SELECT pg_advisory_xact_lock(89208923)");
      await sql.query(
        "INSERT INTO applications(id,name,environment,source_mode) VALUES($1,'MiShu 本地主平台','test','mishu') ON CONFLICT(id) DO NOTHING",
        [appId],
      );
      const app = (
        await sql.query("SELECT source_mode FROM applications WHERE id=$1", [
          appId,
        ])
      ).rows[0];
      if (app.source_mode !== "mishu")
        throw Error("Application ID is already used by a different source.");
      await sql.query(
        "INSERT INTO operator_scopes VALUES($1,$2) ON CONFLICT DO NOTHING",
        [operator.id, appId],
      );
      await audit(sql, appId, operator.id, "source.configured", appId, {
        source_url: sourceUrl,
        mode: "read-only",
      });
    });
    fs.writeFileSync(
      metadata,
      JSON.stringify(
        {
          application_id: appId,
          platform,
          source_url: sourceUrl,
          configured_at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.log(
      "Configured MiShu 本地主平台 (read-only). Existing demo records and passwords preserved.",
    );
    console.log(
      "Restart the platform server and trade-admin API/worker, then run npm run connect:mishu -- --import.",
    );
    console.log(
      "Read tokens are saved only in ignored local configuration; none were printed.",
    );
  }
} finally {
  await db.end();
}
