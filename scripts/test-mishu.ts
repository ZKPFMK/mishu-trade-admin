/** Two independent processes, an isolated source directory and an isolated projection schema. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fixture } from "../tests/helpers.js";
import { sourceAdapter } from "../packages/adapters/src/index.js";
import {
  importSnapshot,
  queueJob,
  receiveEvent,
  applyNextEvent,
} from "../packages/core/src/sync.js";
import { syncSources } from "../packages/core/src/worker.js";
import { reconcile } from "../packages/core/src/reconciliation.js";

const platform = path.resolve(process.argv[2] || "../mishu-platform");
const entry = path.join(platform, "scripts/trade-admin-fixture.ts");
assert.ok(
  fs.existsSync(entry),
  "Pass the platform checkout containing the isolated test fixture.",
);
const child = fork(entry, {
  cwd: platform,
  execArgv: ["--import", "tsx"],
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    TRADE_ADMIN_READ_TOKEN: "",
    PROMPT_GUARD_ENABLED: "0",
  },
});
let serial = 0,
  stderr = "";
child.stderr?.on("data", (b) => {
  stderr = (stderr + b.toString()).slice(-8000);
});
child.stdout?.resume();
function command(action: string, args: object = {}): Promise<any> {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      child.off("message", listener);
      child.off("exit", exited);
    };
    const listener = (m: any) => {
      if (m.id === id) {
        clean();
        if (m.error) reject(Error(m.error));
        else resolve(m.result);
      }
    };
    const exited = () => {
      clean();
      reject(Error("Fixture exited: " + stderr));
    };
    const timer = setTimeout(() => {
      clean();
      reject(Error("Fixture timeout: " + action + ": " + stderr));
    }, 30000);
    child.on("message", listener);
    child.once("exit", exited);
    child.send({ id, action, ...args });
  });
}
let f: Awaited<ReturnType<typeof fixture>> | undefined;
try {
  let connection = await command("start");
  f = await fixture(2);
  const app = { id: "real_source_test", source_mode: "mishu" };
  await f.db.query(
    "INSERT INTO applications(id,name,environment,source_mode) VALUES($1,'隔离主平台','test','mishu')",
    [app.id],
  );
  await f.db.query("INSERT INTO operator_scopes VALUES($1,$2)", [
    "requester",
    app.id,
  ]);
  const cfg = {
    ...f.cfg,
    sourceUrl: connection.base,
    sourceReadToken: connection.token,
  };
  const historic = await command("fund");
  await command("settle", { trade: historic.id });
  const snapshot = await sourceAdapter(f.db, cfg, app).snapshot();
  await importSnapshot(f.db, app.id, snapshot);
  assert.equal(snapshot.bundle.trades.length, 1);
  const view = async (id: string) =>
    (
      await f!.db.query(
        "SELECT document FROM trade_projections WHERE application_id=$1 AND id=$2",
        [app.id, id],
      )
    ).rows[0]?.document;
  assert.equal((await view(historic.id)).status, "COMPLETED");
  const live = await command("fund", { license_type: "usage" });
  await syncSources(f.db, cfg);
  assert.equal((await view(live.id)).status, "FUNDED");
  await command("settle", { trade: live.id });
  await syncSources(f.db, cfg);
  assert.equal((await view(live.id)).status, "COMPLETED");
  assert.equal((await view(live.id)).version, "2");
  assert.equal((await view(live.id)).license_type, "usage");
  const refunded = await command("fund", { license_type: "display" });
  await command("refund", { trade: refunded.id });
  await command("billing");
  await syncSources(f.db, cfg);
  assert.equal((await view(refunded.id)).status, "REFUNDED");
  const headers = await f.session("requester");
  const apps = await f.api.inject({
    method: "GET",
    url: "/admin/applications",
    headers,
  });
  assert.equal(apps.json()[0].id, app.id);
  const search = await f.api.inject({
    method: "GET",
    url:
      "/admin/trades?application_id=" +
      app.id +
      "&q=" +
      encodeURIComponent("你好 · 链路测试"),
    headers,
  });
  assert.equal(search.statusCode, 200);
  assert.equal(search.json().items.length, 3);
  assert.equal(
    (
      await f.api.inject({
        method: "GET",
        url: "/admin/trades?application_id=" + app.id,
        headers: await f.session("outsider"),
      })
    ).statusCode,
    403,
  );
  const overview = await f.api.inject({
    method: "GET",
    url: "/admin/overview?application_id=" + app.id,
    headers,
  });
  assert.equal(overview.json().totals.settled, "400");
  assert.equal(overview.json().totals.refunded, "200");
  assert.equal(
    overview.json().balances.find((b: any) => b.kind === "escrow").balance,
    "0",
  );
  // A source outage does not modify or block any purchase in the source process.
  await syncSources(f.db, { ...cfg, sourceReadToken: "incorrect-test-token" });
  assert.ok(
    (
      await f.db.query("SELECT source_error FROM applications WHERE id=$1", [
        app.id,
      ])
    ).rows[0].source_error,
  );
  const offline = await command("fund");
  await command("settle", { trade: offline.id });
  connection = await command("restart");
  cfg.sourceUrl = connection.base;
  await syncSources(f.db, cfg);
  assert.equal((await view(offline.id)).status, "COMPLETED");
  const state = (
    await f.db.query("SELECT * FROM applications WHERE id=$1", [app.id])
  ).rows[0];
  assert.equal(state.source_error, null);
  const before = (
    await f.db.query(
      "SELECT count(*) n FROM journal_entries WHERE application_id=$1",
      [app.id],
    )
  ).rows[0].n;
  const replay = (
    await f.db.query(
      "SELECT body FROM event_inbox WHERE application_id=$1 ORDER BY seq LIMIT 1",
      [app.id],
    )
  ).rows[0].body;
  await receiveEvent(f.db, app.id, replay);
  await applyNextEvent(f.db, app.id);
  await syncSources(f.db, cfg);
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*) n FROM journal_entries WHERE application_id=$1",
        [app.id],
      )
    ).rows[0].n,
    before,
  );
  const run = await queueJob(f.db, app.id, null, "reconcile");
  const result = await reconcile(f.db, app.id, run);
  assert.equal(result.outcome, "passed", JSON.stringify(result));
  await assert.rejects(
    sourceAdapter(f.db, cfg, app).receipt("refund_test"),
    /real_source_commands_disabled/,
  );
  const final = await sourceAdapter(f.db, cfg, app).snapshot();
  assert.deepEqual(
    final.bundle.trades.map((t) => t.id).sort(),
    (
      await f.db.query(
        "SELECT id FROM trade_projections WHERE application_id=$1",
        [app.id],
      )
    ).rows
      .map((r) => r.id)
      .sort(),
  );
  console.log(
    "MiShu HTTP integration passed: history, new orders, settlement, refunds, generation, license escrow, source restart/offline recovery, idempotency, title search, scope isolation and seven reconciliation rules.",
  );
} finally {
  if (child.connected) {
    await command("stop").catch(() => {});
    const exit = once(child, "exit");
    child.disconnect();
    await exit;
  }
  await f?.close();
}
