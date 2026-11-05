import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { gunzipSync } from "node:zlib";
import { fixture } from "./helpers.js";
import {
  createOperation,
  decideOperation,
  executeOperation,
} from "../packages/core/src/operations.js";
import { executeMock } from "../packages/adapters/src/mock.js";
import { sourceAdapter } from "../packages/adapters/src/index.js";
import {
  applyNextEvent,
  receiveEvent,
  importSnapshot,
  queueJob,
} from "../packages/core/src/sync.js";
import { digest } from "../packages/core/src/security.js";
import {
  syncSources,
  runJob,
  maintenance,
} from "../packages/core/src/worker.js";
import { reconcile } from "../packages/core/src/reconciliation.js";
import { listData, filtersSchema } from "../packages/core/src/queries.js";
import { cleanupExports } from "../packages/core/src/exports.js";
import { integer, positive } from "../packages/contracts/src/index.js";
import { createServer } from "node:http";

test("malformed/oversized integers and invalid calendar dates fail validation without unsafe conversion", () => {
  for (const value of [
    "NaN",
    "-0",
    "01",
    "1.5",
    "1e9",
    "9".repeat(100000),
    "9223372036854775808",
    null,
    1,
  ])
    assert.equal(integer.safeParse(value).success, false);
  assert.equal(integer.parse("9007199254740993"), "9007199254740993");
  assert.equal(positive.safeParse("0").success, false);
  for (const from of ["2026-02-30", "2026-13-01", "invalid"])
    assert.equal(filtersSchema.safeParse({ from }).success, false);
  assert.equal(
    filtersSchema.safeParse({ from: "2026-02-02", to: "2026-01-01" }).success,
    false,
  );
});

test("all admin read pages and scoped operator directory respond using real PostgreSQL queries", async () => {
  const f = await fixture();
  try {
    const headers = await f.session("requester");
    for (const page of [
      "overview",
      "assets",
      "trades",
      "accounts",
      "journal-transactions",
      "settlements",
      "generation-jobs",
      "operation-requests",
      "cases",
      "exports",
      "reconciliation-runs",
      "reconciliation-findings",
      "imports",
      "events",
      "event-conflicts",
      "audit-events",
      "credentials",
    ]) {
      const r = await f.api.inject({
        url: "/admin/" + page + "?application_id=" + f.app,
        headers,
      });
      assert.equal(r.statusCode, 200, page + ": " + r.body);
    }
    const overview = await f.api.inject({
      url:
        "/admin/overview?application_id=" +
        f.app +
        "&from=2026-01-01&to=2026-12-31",
      headers,
    });
    assert.equal(overview.statusCode, 200);
    const assets = await f.api.inject({
      url: "/admin/assets?application_id=" + f.app,
      headers,
    });
    assert.equal(assets.statusCode, 200);
    assert.ok(assets.json().items.some((x: any) => x.asset_id === "asset_5"));
    const asset = await f.api.inject({
      url: "/admin/assets/asset_5?application_id=" + f.app,
      headers,
    });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.json().asset.asset_id, "asset_5");
    const people = await f.api.inject({ url: "/admin/operators", headers });
    assert.equal(people.statusCode, 200);
    assert.ok(!people.json().some((p: any) => p.id === "outsider"));
    const missing = await f.api.inject({
      url: "/admin/trades/not_found?application_id=" + f.app,
      headers,
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await f.close();
  }
});

test("isolated auth, role/scope, CSRF and service permission boundaries", async () => {
  const f = await fixture();
  try {
    const h = await f.session("requester"),
      viewer = await f.session("auditor"),
      outsider = await f.session("outsider");
    assert.equal(
      (await f.api.inject("/admin/trades?application_id=" + f.app)).statusCode,
      401,
    );
    assert.equal(
      (
        await f.api.inject({
          url: "/admin/trades?application_id=" + f.app,
          headers: outsider,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.api.inject({
          method: "POST",
          url: "/admin/reconciliation-runs",
          headers: { cookie: h.cookie },
          payload: { application_id: f.app },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.api.inject({
          method: "POST",
          url: "/admin/reconciliation-runs",
          headers: viewer,
          payload: { application_id: f.app },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.api.inject({
          url: "/v1/sync/status",
          headers: { authorization: "Bearer " + f.token },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.api.inject({ url: "/v1/sync/status", headers: h })).statusCode,
      401,
    );
    assert.equal(
      (
        await f.api.inject({
          method: "POST",
          url: "/auth/login",
          headers: { origin: "https://evil.example" },
          payload: { email: "requester@test.local", password: "x" },
        })
      ).statusCode,
      403,
    );
    await f.db.query("UPDATE operators SET enabled=false WHERE id='requester'");
    assert.equal(
      (await f.api.inject({ url: "/auth/me", headers: h })).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});
test("two-person refund: source receipt, balanced journal, cursor synchronization and no duplicate spending", async () => {
  const f = await fixture();
  try {
    const op = await createOperation(
      f.db,
      f.cfg,
      f.actors.requester,
      f.app,
      "trade_00005",
      "测试未交付订单退款",
      "request-1",
    );
    assert.equal(
      (
        await createOperation(
          f.db,
          f.cfg,
          f.actors.requester,
          f.app,
          "trade_00005",
          "测试未交付订单退款",
          "request-1",
        )
      ).id,
      op.id,
    );
    await assert.rejects(
      () =>
        createOperation(
          f.db,
          f.cfg,
          f.actors.requester,
          f.app,
          "trade_00005",
          "不同的原因不允许重复",
          "request-1",
        ),
      { code: "idempotency_conflict" },
    );
    const self = { ...f.actors.requester, roles: ["approver"] };
    await assert.rejects(
      () => decideOperation(f.db, self, op.id, "approve", "不允许自己审批"),
      { code: "self_approval_forbidden" },
    );
    await decideOperation(
      f.db,
      f.actors.approver,
      op.id,
      "approve",
      "已核验订单与退款对象",
    );
    await executeOperation(f.db, f.cfg);
    const result = (
      await f.db.query("SELECT * FROM operation_requests WHERE id=$1", [op.id])
    ).rows[0];
    assert.equal(result.state, "succeeded");
    assert.equal(
      (
        await f.db.query("SELECT status FROM trade_projections WHERE id=$1", [
          "trade_00005",
        ])
      ).rows[0].status,
      "FUNDED",
    );
    await syncSources(f.db, f.cfg);
    assert.equal(
      (
        await f.db.query("SELECT status FROM trade_projections WHERE id=$1", [
          "trade_00005",
        ])
      ).rows[0].status,
      "REFUNDED",
    );
    const original = await executeMock(f.db, f.app, op.command);
    const duplicate = await executeMock(f.db, f.app, op.command);
    assert.deepEqual(duplicate, original);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM journal_transactions WHERE reference_id='trade_00005' AND kind='refund'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT balance FROM account_projections WHERE id='escrow:trade_00005'",
        )
      ).rows[0].balance,
      "0",
    );
    const run = await queueJob(f.db, f.app, "requester", "reconcile");
    assert.equal((await reconcile(f.db, f.app, run)).outcome, "passed");
  } finally {
    await f.close();
  }
});
test("revoked approver, approval expiry, stale source and delivered order are rejected", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () =>
        createOperation(
          f.db,
          f.cfg,
          f.actors.requester,
          f.app,
          "trade_00001",
          "已交付订单不允许人工退款",
          "bad",
        ),
      { code: "only_undelivered_funded_orders" },
    );
    for (const [trade, key, change, error] of [
      [
        "trade_00005",
        "revoked",
        "UPDATE operators SET enabled=false WHERE id='approver'",
        "operator_permission_changed",
      ],
      [
        "trade_00008",
        "expired",
        "UPDATE operation_requests SET approval_expires_at=now()-interval '1 minute' WHERE id=$1",
        "approval_expired",
      ],
      ["trade_00013", "stale", null, "source_state_changed"],
    ] as const) {
      await f.db.query("UPDATE operators SET enabled=true WHERE id='approver'");
      const op = await createOperation(
        f.db,
        f.cfg,
        f.actors.requester,
        f.app,
        trade,
        "测试审批失效的不同路径",
        key,
      );
      await decideOperation(
        f.db,
        f.actors.approver,
        op.id,
        "approve",
        "已核验申请内容与金额",
      );
      if (change)
        await f.db.query(change, change.includes("$1") ? [op.id] : []);
      else {
        const s = (
          await f.db.query(
            "SELECT bundle FROM mock_sources WHERE application_id=$1",
            [f.app],
          )
        ).rows[0].bundle;
        s.trades.find((x: any) => x.id === trade).version = "2";
        await f.db.query(
          "UPDATE mock_sources SET bundle=$2 WHERE application_id=$1",
          [f.app, JSON.stringify(s)],
        );
      }
      await executeOperation(f.db, f.cfg);
      assert.equal(
        (
          await f.db.query("SELECT error FROM operation_requests WHERE id=$1", [
            op.id,
          ])
        ).rows[0].error,
        error,
      );
    }
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM mock_commands")).rows[0].n,
      0,
    );
  } finally {
    await f.close();
  }
});
test("lost response/restarted worker resolves original receipt even after roles revoked and approval expired", async () => {
  const f = await fixture();
  try {
    const op = await createOperation(
      f.db,
      f.cfg,
      f.actors.requester,
      f.app,
      "trade_00005",
      "测试来源成功后网络中断",
      "lost-response",
    );
    await decideOperation(
      f.db,
      f.actors.approver,
      op.id,
      "approve",
      "允许模拟恢复演练退款",
    );
    await executeMock(f.db, f.app, op.command);
    await f.db.query(
      "UPDATE operation_requests SET state='executing',updated_at=now()-interval '2 minutes',approval_expires_at=now()-interval '1 minute' WHERE id=$1",
      [op.id],
    );
    await f.db.query("UPDATE operators SET enabled=false WHERE id='approver'");
    await maintenance(f.db, f.cfg);
    await executeOperation(f.db, f.cfg);
    assert.equal(
      (
        await f.db.query("SELECT state FROM operation_requests WHERE id=$1", [
          op.id,
        ])
      ).rows[0].state,
      "succeeded",
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM mock_commands")).rows[0].n,
      1,
    );
  } finally {
    await f.close();
  }
});
test("concurrent competing source commands commit only one refund; digest changes rejected", async () => {
  const f = await fixture();
  try {
    const op = await createOperation(
      f.db,
      f.cfg,
      f.actors.requester,
      f.app,
      "trade_00005",
      "模拟并发退款来源校验",
      "concurrent",
    );
    const out = await Promise.all([
      executeMock(f.db, f.app, op.command),
      executeMock(f.db, f.app, { ...op.command, command_id: "second-command" }),
    ]);
    assert.equal(out.filter((r) => r.status === "succeeded").length, 1);
    assert.equal(out.filter((r) => r.status === "rejected").length, 1);
    await assert.rejects(
      () => executeMock(f.db, f.app, { ...op.command, amount: "999" }),
      { code: "command_digest_conflict" },
    );
  } finally {
    await f.close();
  }
});
test("snapshot checksum, complete journal validation and rollback keep failed imports invisible", async () => {
  const f = await fixture();
  try {
    const snap = await sourceAdapter(f.db, f.cfg, {
      id: f.app,
      source_mode: "mock",
    }).snapshot();
    await assert.rejects(
      () =>
        importSnapshot(f.db, f.other, {
          ...snap,
          checksum: "sha256:" + "0".repeat(64),
        }),
      { code: "snapshot_checksum_mismatch" },
    );
    const bad = structuredClone(snap);
    bad.bundle.accounts[0].balance = "999";
    bad.checksum = digest(bad.bundle);
    await assert.rejects(() => importSnapshot(f.db, f.other, bad), {
      code: "account_balance_mismatch",
    });
    assert.equal(
      (
        await f.db.query("SELECT initialized FROM applications WHERE id=$1", [
          f.other,
        ])
      ).rows[0].initialized,
      false,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM trade_projections WHERE application_id=$1",
          [f.other],
        )
      ).rows[0].n,
      0,
    );
    await importSnapshot(f.db, f.other, snap);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM trade_projections WHERE application_id=$1",
          [f.other],
        )
      ).rows[0].n,
      24,
    );
  } finally {
    await f.close();
  }
});
test("out-of-order, duplicate, conflicting events and version gaps never overwrite or double-book", async () => {
  const f = await fixture();
  try {
    for (const trade of ["trade_00005", "trade_00008"]) {
      const op = await createOperation(
        f.db,
        f.cfg,
        f.actors.requester,
        f.app,
        trade,
        "测试事件乱序与重复接收",
        "key-" + trade,
      );
      await executeMock(f.db, f.app, op.command);
    }
    const events = (
      await sourceAdapter(f.db, f.cfg, {
        id: f.app,
        source_mode: "mock",
      }).events("bootstrap")
    ).events;
    await receiveEvent(f.db, f.app, events[1]);
    assert.equal(await applyNextEvent(f.db, f.app), false);
    assert.equal(
      (await f.db.query("SELECT state FROM event_inbox")).rows[0].state,
      "blocked",
    );
    await receiveEvent(f.db, f.app, events[0]);
    await applyNextEvent(f.db, f.app);
    await applyNextEvent(f.db, f.app);
    assert.equal((await receiveEvent(f.db, f.app, events[0])).duplicate, true);
    const conflict = { ...events[0], occurred_at: new Date().toISOString() };
    assert.equal((await receiveEvent(f.db, f.app, conflict)).state, "conflict");
    const t = (
      await f.db.query(
        "SELECT document FROM trade_projections WHERE id='trade_00005'",
      )
    ).rows[0].document;
    const gap = {
      schema_version: 1,
      event_id: "gap",
      source_cursor: "gap-cursor",
      previous_cursor: events[1].source_cursor,
      occurred_at: new Date().toISOString(),
      bundle: {
        trades: [{ ...t, version: "99" }],
        accounts: [],
        journals: [],
        jobs: [],
      },
    };
    await receiveEvent(f.db, f.app, gap);
    await applyNextEvent(f.db, f.app);
    assert.equal(
      (await f.db.query("SELECT error FROM event_inbox WHERE event_id='gap'"))
        .rows[0].error,
      "version_gap",
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT version FROM trade_projections WHERE id='trade_00005'",
        )
      ).rows[0].version,
      "2",
    );
    const run = await queueJob(f.db, f.app, "requester", "reconcile");
    assert.equal((await reconcile(f.db, f.app, run)).outcome, "incomplete");
  } finally {
    await f.close();
  }
});
test("reconciliation finds injected divergence, records history and resolves only after complete clean rerun", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "UPDATE account_projections SET balance=balance+1 WHERE id='escrow:trade_00005'",
    );
    const run = await queueJob(f.db, f.app, "requester", "reconcile"),
      result = await reconcile(f.db, f.app, run);
    assert.equal(result.outcome, "differences");
    assert.equal(result.findings, 2);
    await f.db.query(
      "UPDATE account_projections SET balance=balance-1 WHERE id='escrow:trade_00005'",
    );
    const rerun = await queueJob(f.db, f.app, "requester", "reconcile");
    assert.equal((await reconcile(f.db, f.app, rerun)).outcome, "passed");
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM reconciliation_findings WHERE state='resolved'",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM reconciliation_observations",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await f.close();
  }
});
test("stable pagination, bounded page jumps and filtered exports preserve exact large integers and literal formulas", async () => {
  const f = await fixture(60);
  try {
    const first = await listData(
      f.db,
      f.app,
      "trades",
      filtersSchema.parse({ limit: 10 }),
    );
    const second = await listData(
      f.db,
      f.app,
      "trades",
      filtersSchema.parse({ limit: 10, cursor: first.next_cursor }),
    );
    assert.equal(
      new Set([...first.items, ...second.items].map((x) => x.id)).size,
      20,
    );
    assert.deepEqual(
      second.items,
      (
        await listData(
          f.db,
          f.app,
          "trades",
          filtersSchema.parse({ limit: 10, page: 2 }),
        )
      ).items,
    );
    await assert.rejects(
      () =>
        listData(
          f.db,
          f.other,
          "trades",
          filtersSchema.parse({ limit: 10, cursor: first.next_cursor }),
        ),
      { code: "invalid_cursor" },
    );
    // Export the immutable value as text; intentionally bypass source validation only in this isolated test schema.
    await f.db.query(
      "UPDATE trade_projections SET document=jsonb_set(jsonb_set(document,'{price}','\"9007199254740993\"'),'{asset_title}','\"=HYPERLINK(unsafe)\"') WHERE id='trade_00005'",
    );
    const job = await queueJob(f.db, f.app, "requester", "export", {
      dataset: "trades",
      format: "xlsx",
      scope: "filtered",
      fields: "detail",
      filters: { q: "trade_00005" },
    });
    await runJob(f.db, f.cfg, ["export"]);
    const saved = (await f.db.query("SELECT * FROM jobs WHERE id=$1", [job]))
      .rows[0];
    assert.equal(saved.state, "succeeded");
    assert.equal(saved.progress, "1");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(
      path.join(
        f.cfg.dataDir,
        saved.result.directory,
        saved.result.parts[0].name,
      ),
    );
    assert.equal(
      workbook.worksheets[0].getCell("M2").value,
      "9007199254740993",
    );
    assert.equal(
      workbook.worksheets[0].getCell("R2").type,
      ExcelJS.ValueType.String,
    );
    const h = await f.session("requester"),
      viewer = await f.session("auditor"),
      url = `/admin/exports/${job}/files/${saved.result.parts[0].name}`;
    assert.equal((await f.api.inject({ url, headers: h })).statusCode, 200);
    assert.equal(
      (await f.api.inject({ url, headers: viewer })).statusCode,
      403,
    );
    await f.db.query(
      "UPDATE jobs SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [job],
    );
    assert.equal((await f.api.inject({ url, headers: h })).statusCode, 410);
    await cleanupExports(f.db, f.cfg);
    assert.equal(
      fs.existsSync(path.join(f.cfg.dataDir, saved.result.directory)),
      false,
    );
  } finally {
    await f.close();
  }
});
test("JSONL exports contain all journal entries; cancellation, permission revocation and expired lease recovery", async () => {
  const f = await fixture();
  try {
    const job = await queueJob(f.db, f.app, "requester", "export", {
      dataset: "journal-transactions",
      format: "jsonl.gz",
      filters: {},
    });
    await f.db.query(
      "UPDATE jobs SET state='running',lease_token='old',lease_until=now()-interval '1 minute' WHERE id=$1",
      [job],
    );
    await runJob(f.db, f.cfg, ["export"]);
    const saved = (await f.db.query("SELECT * FROM jobs WHERE id=$1", [job]))
      .rows[0];
    assert.equal(saved.state, "succeeded");
    const lines = gunzipSync(
      fs.readFileSync(
        path.join(
          f.cfg.dataDir,
          saved.result.directory,
          saved.result.parts[0].name,
        ),
      ),
    )
      .toString()
      .trim()
      .split("\n");
    assert.equal(
      lines.length,
      f.bundle.journals.reduce((n, j) => n + j.entries.length, 0),
    );
    assert.equal(JSON.parse(lines[0])["支付模式"], "simulated");
    const cancel = await queueJob(f.db, f.app, "requester", "export", {
      dataset: "trades",
      filters: {},
    });
    await f.db.query("UPDATE jobs SET cancel_requested=true WHERE id=$1", [
      cancel,
    ]);
    await runJob(f.db, f.cfg, ["export"]);
    assert.equal(
      (await f.db.query("SELECT state FROM jobs WHERE id=$1", [cancel])).rows[0]
        .state,
      "canceled",
    );
    const revoked = await queueJob(f.db, f.app, "requester", "export", {
      dataset: "trades",
      filters: {},
    });
    await f.db.query(
      "DELETE FROM operator_scopes WHERE operator_id='requester'",
    );
    await runJob(f.db, f.cfg, ["export"]);
    assert.equal(
      (await f.db.query("SELECT error FROM jobs WHERE id=$1", [revoked]))
        .rows[0].error,
      "export_permission_revoked",
    );
  } finally {
    await f.close();
  }
});
test("legacy mock refund endpoints reject real sources regardless of administrator configuration", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "UPDATE applications SET source_mode='mishu' WHERE id=$1",
      [f.app],
    );
    await assert.rejects(
      () =>
        createOperation(
          f.db,
          f.cfg,
          f.actors.requester,
          f.app,
          "trade_00005",
          "真实来源当前应只读",
          "no-real-write",
        ),
      { code: "real_source_commands_disabled" },
    );
    await assert.rejects(
      () =>
        sourceAdapter(f.db, f.cfg, { id: f.app, source_mode: "mishu" }).execute(
          {
            command_id: "x",
            type: "refund_undelivered",
            trade_id: "trade_00005",
            expected_version: "1",
            amount: "1",
            buyer_id: "x",
            reason: "不可实际执行",
          },
        ),
      { code: "real_source_commands_disabled" },
    );
  } finally {
    await f.close();
  }
});

test("snapshot boundary plus post-snapshot events yields the same order and account state", async () => {
  const f = await fixture();
  try {
    const adapter = sourceAdapter(f.db, f.cfg, {
        id: f.app,
        source_mode: "mock",
      }),
      snapshot = await adapter.snapshot();
    const op = await createOperation(
      f.db,
      f.cfg,
      f.actors.requester,
      f.app,
      "trade_00005",
      "快照创建后发生退款测试",
      "snapshot-race",
    );
    await executeMock(f.db, f.app, op.command);
    await importSnapshot(f.db, f.other, snapshot);
    const page = await adapter.events(snapshot.cursor);
    for (const event of page.events) {
      await receiveEvent(f.db, f.other, event);
      await applyNextEvent(f.db, f.other);
    }
    await syncSources(f.db, f.cfg);
    const a = (
        await f.db.query(
          "SELECT id,balance,version FROM account_projections WHERE application_id=$1 ORDER BY id",
          [f.app],
        )
      ).rows,
      b = (
        await f.db.query(
          "SELECT id,balance,version FROM account_projections WHERE application_id=$1 ORDER BY id",
          [f.other],
        )
      ).rows;
    assert.deepEqual(a, b);
    assert.equal(
      (
        await f.db.query(
          "SELECT status FROM trade_projections WHERE application_id=$1 AND id='trade_00005'",
          [f.other],
        )
      ).rows[0].status,
      "REFUNDED",
    );
  } finally {
    await f.close();
  }
});

test("immutable journal conflict rolls back the event and same conflict digest is only logged once", async () => {
  const f = await fixture();
  try {
    const journal = structuredClone(f.bundle.journals[0]);
    journal.entries[0].amount = String(BigInt(journal.entries[0].amount) - 1n);
    journal.entries[1].amount = String(BigInt(journal.entries[1].amount) + 1n);
    const event = {
      schema_version: 1,
      event_id: "bad-journal",
      source_cursor: "bad-cursor",
      previous_cursor: "bootstrap",
      occurred_at: new Date().toISOString(),
      bundle: { trades: [], accounts: [], journals: [journal], jobs: [] },
    };
    await receiveEvent(f.db, f.app, event);
    await applyNextEvent(f.db, f.app);
    assert.equal(
      (
        await f.db.query(
          "SELECT error FROM event_inbox WHERE event_id='bad-journal'",
        )
      ).rows[0].error,
      "immutable_journal_conflict",
    );
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT document FROM journal_transactions WHERE application_id=$1 AND id=$2",
          [f.app, journal.id],
        )
      ).rows[0].document,
      f.bundle.journals[0],
    );
    const changed = { ...event, occurred_at: "2020-01-01T00:00:00Z" };
    await receiveEvent(f.db, f.app, changed);
    await receiveEvent(f.db, f.app, changed);
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM event_conflicts")).rows[0]
        .n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("import lease recovery acknowledges the same activated snapshot without reimporting", async () => {
  const f = await fixture();
  try {
    const snapshot = await sourceAdapter(f.db, f.cfg, {
        id: f.app,
        source_mode: "mock",
      }).snapshot(),
      job = await queueJob(f.db, f.other, "requester", "import", { snapshot });
    await importSnapshot(f.db, f.other, snapshot, job);
    await f.db.query(
      "UPDATE jobs SET state='running',lease_token='crashed',lease_until=now()-interval '1 minute' WHERE id=$1",
      [job],
    );
    await runJob(f.db, f.cfg, ["import"]);
    assert.equal(
      (await f.db.query("SELECT state FROM jobs WHERE id=$1", [job])).rows[0]
        .state,
      "succeeded",
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM trade_projections WHERE application_id=$1",
          [f.other],
        )
      ).rows[0].n,
      24,
    );
  } finally {
    await f.close();
  }
});

test("concurrent identical requests share one operation, and export queue limits are atomic", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        createOperation(
          f.db,
          f.cfg,
          f.actors.requester,
          f.app,
          "trade_00005",
          "并发相同请求编号保持幂等",
          "same-key",
        ),
      ),
    );
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    const headers = await f.session("requester"),
      requests = await Promise.all(
        Array.from({ length: 5 }, () =>
          f.api.inject({
            method: "POST",
            url: "/admin/exports",
            headers,
            payload: { application_id: f.app, dataset: "trades" },
          }),
        ),
      );
    assert.equal(requests.filter((r) => r.statusCode === 200).length, 3);
    assert.equal(requests.filter((r) => r.statusCode === 429).length, 2);
  } finally {
    await f.close();
  }
});

test("oversized Excel detail cells fail explicitly; auto format preserves full detail in JSONL", async () => {
  const f = await fixture();
  try {
    const long = "长字段".repeat(12000);
    await f.db.query(
      "UPDATE trade_projections SET document=jsonb_set(document,'{asset_title}',$1) WHERE id='trade_00005'",
      [JSON.stringify(long)],
    );
    const explicit = await queueJob(f.db, f.app, "requester", "export", {
      dataset: "trades",
      format: "xlsx",
      fields: "detail",
      filters: { q: "trade_00005" },
    });
    await runJob(f.db, f.cfg, ["export"]);
    assert.equal(
      (await f.db.query("SELECT error FROM jobs WHERE id=$1", [explicit]))
        .rows[0].error,
      "excel_cell_limit",
    );
    const auto = await queueJob(f.db, f.app, "requester", "export", {
      dataset: "trades",
      format: "auto",
      fields: "detail",
      filters: { q: "trade_00005" },
    });
    await runJob(f.db, f.cfg, ["export"]);
    const saved = (await f.db.query("SELECT * FROM jobs WHERE id=$1", [auto]))
      .rows[0];
    assert.equal(saved.state, "succeeded");
    assert.equal(saved.result.format, "jsonl.gz");
    const line = JSON.parse(
      gunzipSync(
        fs.readFileSync(
          path.join(
            f.cfg.dataDir,
            saved.result.directory,
            saved.result.parts[0].name,
          ),
        ),
      )
        .toString()
        .trim(),
    );
    assert.equal(JSON.parse(line["明细JSON"]).asset_title, long);
  } finally {
    await f.close();
  }
});

test("HTTP read adapter authenticates, imports schema-validated snapshots and rejects false cursor coverage", async () => {
  const f = await fixture();
  let wrongCoverage = false;
  const snapshot = await sourceAdapter(f.db, f.cfg, {
    id: f.app,
    source_mode: "mock",
  }).snapshot();
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer local-read-test") {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/internal/trade-admin/snapshots")
      return void res.end(
        JSON.stringify({ snapshot_id: snapshot.snapshot_id }),
      );
    if (req.url?.startsWith("/internal/trade-admin/snapshots/"))
      return void res.end(JSON.stringify(snapshot));
    if (req.url?.startsWith("/internal/trade-admin/trades/"))
      return void res.end(JSON.stringify(f.bundle.trades[4]));
    if (req.url?.startsWith("/internal/trade-admin/events"))
      return void res.end(
        JSON.stringify({
          from_cursor: wrongCoverage ? "incorrect" : "bootstrap",
          through_cursor: "bootstrap",
          has_more: false,
          events: [],
        }),
      );
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port,
    cfg = {
      ...f.cfg,
      sourceUrl: `http://127.0.0.1:${port}`,
      sourceReadToken: "local-read-test",
    };
  try {
    const adapter = sourceAdapter(f.db, cfg, {
      id: f.app,
      source_mode: "mishu",
    });
    assert.deepEqual(await adapter.snapshot(), snapshot);
    assert.equal((await adapter.trade("trade_00005")).id, "trade_00005");
    assert.equal(
      (await adapter.events("bootstrap")).through_cursor,
      "bootstrap",
    );
    await f.db.query(
      "UPDATE applications SET source_mode='mishu' WHERE id=$1",
      [f.app],
    );
    wrongCoverage = true;
    await syncSources(f.db, cfg);
    assert.equal(
      (
        await f.db.query("SELECT source_error FROM applications WHERE id=$1", [
          f.app,
        ])
      ).rows[0].source_error,
      "source_coverage_mismatch",
    );
    wrongCoverage = false;
    await syncSources(f.db, cfg);
    assert.equal(
      (
        await f.db.query("SELECT source_error FROM applications WHERE id=$1", [
          f.app,
        ])
      ).rows[0].source_error,
      null,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await f.close();
  }
});
