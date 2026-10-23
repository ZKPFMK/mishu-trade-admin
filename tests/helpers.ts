import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../packages/core/src/config.js";
import { database, migrate } from "../packages/database/src/index.js";
import { digest, hash, passwordHash } from "../packages/core/src/security.js";
import { demoBundle } from "../packages/adapters/src/mock.js";
import { importSnapshot } from "../packages/core/src/sync.js";
import { createApp } from "../apps/api/src/app.js";
import type { Actor } from "../packages/core/src/auth.js";
export async function fixture(count = 24) {
  const cfg = {
      ...config(),
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mishu-trade-test-")),
    },
    schema = "trade_test_" + randomBytes(6).toString("hex"),
    control = database(cfg.databaseUrl);
  await control.query(`CREATE SCHEMA "${schema}"`);
  const db = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: 12,
    options: `-c search_path=${schema}`,
  });
  await migrate(db);
  const app = "test_app",
    other = "other_app",
    password = "Test-only-password-042!",
    token = randomBytes(32).toString("hex");
  const actors: Record<string, Actor> = {};
  for (const key of [app, other])
    await db.query(
      "INSERT INTO applications(id,name,environment,source_mode) VALUES($1,$1,'test','mock')",
      [key],
    );
  for (const [name, roles, scope] of [
    ["requester", ["operator", "viewer", "admin", "auditor"], app],
    ["approver", ["approver", "viewer"], app],
    ["auditor", ["auditor", "viewer"], app],
    ["outsider", ["operator", "viewer"], other],
  ] as const) {
    await db.query(
      "INSERT INTO operators(id,email,name,password_hash,roles) VALUES($1,$2,$1,$3,$4)",
      [name, name + "@test.local", await passwordHash(password), roles],
    );
    await db.query("INSERT INTO operator_scopes VALUES($1,$2)", [name, scope]);
    actors[name] = {
      id: name,
      email: name + "@test.local",
      name,
      roles: [...roles],
      scopes: [scope],
      csrf: "",
    };
  }
  const bundle = demoBundle(count);
  await db.query("INSERT INTO mock_sources VALUES($1,$2,$3)", [
    app,
    "bootstrap",
    JSON.stringify(bundle),
  ]);
  await importSnapshot(db, app, {
    schema_version: 1,
    snapshot_id: "fixture",
    cursor: "bootstrap",
    created_at: new Date().toISOString(),
    history: "full",
    bundle,
    checksum: digest(bundle),
  });
  await db.query(
    "INSERT INTO service_credentials VALUES($1,$2,$3,$4,$5,NULL,now())",
    [
      "key",
      app,
      "test",
      hash(token),
      ["events:write", "sync:read", "imports:write"],
    ],
  );
  const api = await createApp(db, cfg);
  async function session(name: string) {
    const res = await api.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: name + "@test.local", password },
    });
    if (res.statusCode !== 200) throw new Error("login " + res.body);
    const cookie = res.cookies[0].name + "=" + res.cookies[0].value,
      csrf = res.json().csrf;
    return { cookie, "x-csrf-token": csrf };
  }
  async function close() {
    await api.close();
    await db.end();
    await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.end();
    fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  }
  return {
    db,
    cfg,
    app,
    other,
    actors,
    api,
    bundle,
    session,
    token,
    close,
    schema,
    control,
  };
}
