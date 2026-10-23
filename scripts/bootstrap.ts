import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config, ROOT } from "../packages/core/src/config.js";
import {
  database,
  migrate,
  transaction,
} from "../packages/database/src/index.js";
import { id, passwordHash, hash } from "../packages/core/src/security.js";
import { demoBundle } from "../packages/adapters/src/mock.js";
import { queueJob } from "../packages/core/src/sync.js";
const cfg = config(),
  db = database(cfg.databaseUrl);
try {
  await migrate(db);
  const file = path.join(ROOT, ".local/credentials.json");
  const credentials: any = {
    console: "http://localhost:8920",
    mode: cfg.sourceMode,
    operators: [],
    service_token: null,
  };
  let created = false;
  await transaction(db, async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(89208923)");
    const app = cfg.sourceMode === "mock" ? "mishu_demo" : "mishu_readonly";
    // Changing the configured source must not recreate operators or overwrite their credentials.
    // Existing installations add the read-only application through connect-mishu.ts.
    if ((await sql.query("SELECT 1 FROM applications LIMIT 1")).rowCount)
      return;
    created = true;
    await sql.query(
      "INSERT INTO applications(id,name,environment,source_mode) VALUES($1,$2,$3,$4)",
      [
        app,
        cfg.sourceMode === "mock" ? "MiShu 模拟演示" : "MiShu 只读接入",
        cfg.sourceMode === "mock" ? "test" : "production",
        cfg.sourceMode,
      ],
    );
    for (const [email, name, roles] of [
      [
        "admin@trade-admin.local",
        "管理与申请",
        ["admin", "operator", "viewer", "auditor"],
      ],
      ["approver@trade-admin.local", "独立审批员", ["approver", "viewer"]],
      ["auditor@trade-admin.local", "只读审计员", ["auditor", "viewer"]],
    ] as const) {
      const operator = id("operator"),
        password = randomBytes(18).toString("base64url");
      await sql.query(
        "INSERT INTO operators(id,email,name,password_hash,roles) VALUES($1,$2,$3,$4,$5)",
        [operator, email, name, await passwordHash(password), roles],
      );
      await sql.query("INSERT INTO operator_scopes VALUES($1,$2)", [
        operator,
        app,
      ]);
      credentials.operators.push({ email, name, password, roles });
    }
    const token = randomBytes(32).toString("base64url");
    // Persist only a hash in the database. The one-time local file is outside Git.
    await sql.query(
      "INSERT INTO service_credentials(id,application_id,label,secret_hash,permissions) VALUES($1,$2,$3,$4,$5)",
      [
        id("key"),
        app,
        "本地接入",
        hash(token),
        ["events:write", "sync:read", "imports:write"],
      ],
    );
    credentials.application_id = app;
    credentials.service_token = token;
    if (cfg.sourceMode === "mock") {
      await sql.query("INSERT INTO mock_sources VALUES($1,$2,$3)", [
        app,
        "mock_bootstrap",
        JSON.stringify(demoBundle()),
      ]);
      await queueJob(sql, app, null, "import");
    }
  });
  if (created) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(credentials, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log("Accounts created. Credentials: .local/credentials.json");
  } else console.log("Existing data and credentials preserved.");
} finally {
  await db.end();
}
