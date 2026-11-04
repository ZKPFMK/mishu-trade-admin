import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { createOperation } from "../packages/core/src/operations.js";
import { listData, filtersSchema } from "../packages/core/src/queries.js";

test("case worklist reaches old records, literal title filters, scoped detail and microsecond-safe cursors", async () => {
  const f = await fixture();
  try {
    const headers = await f.session("requester");
    await f.db.query(
      `INSERT INTO cases(id,application_id,title,owner_id,created_by,updated_at)
      SELECT 'case_'||lpad(n::text,4,'0'),$1,CASE WHEN n=1 THEN '证据100%_完成' ELSE '历史工单'||n END,
      CASE WHEN n%2=0 THEN 'requester' ELSE NULL END,'requester','2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1,235) n`,
      [f.app],
    );
    const get = async (path: string) => f.api.inject({ url: path, headers });
    const base = `/admin/case-worklist?application_id=${f.app}`;
    const first = (await get(base)).json();
    assert.equal(first.total, "235");
    assert.equal(first.items.length, 25);
    const forged = JSON.parse(
      Buffer.from(first.next_cursor, "base64url").toString(),
    );
    forged.time = "2026-02-30T00:00:00.123456Z";
    assert.equal(
      (
        await get(
          base +
            "&cursor=" +
            Buffer.from(JSON.stringify(forged)).toString("base64url"),
        )
      ).statusCode,
      400,
    );

    const seen = new Set<string>();
    let cursor = "";
    do {
      const response = await get(base + (cursor ? "&cursor=" + cursor : ""));
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json();
      for (const row of result.items) {
        assert.ok(!seen.has(row.id));
        seen.add(row.id);
      }
      cursor = result.next_cursor;
    } while (cursor);
    assert.equal(seen.size, 235);
    assert.ok(seen.has("case_0001"));
    const mine = (await get(base + "&owner=me&state=open")).json();
    assert.equal(mine.total, "117");
    assert.equal(
      (await get(base + "&q=" + encodeURIComponent("%_"))).json().total,
      "1",
    );
    assert.equal((await get(base + "&q=' OR 1=1--")).json().total, "0");
    assert.equal(
      (await get(base + "&cursor=" + first.next_cursor + "&owner=me"))
        .statusCode,
      400,
    );
    assert.equal((await get(base + "&page=1001")).statusCode, 400);
    assert.equal((await get(base + "&cursor=not_json")).statusCode, 400);
    const old = await get(`/admin/cases/case_0001?application_id=${f.app}`);
    assert.equal(old.statusCode, 200);
    const legacy = await get(`/admin/cases?application_id=${f.app}`);
    assert.equal(legacy.json().length, 200);
    assert.equal(
      (await get(`/admin/cases/case_0001?application_id=${f.other}`))
        .statusCode,
      403,
    );
    const outsider = await f.session("outsider");
    assert.equal(
      (
        await f.api.inject({
          url: `/admin/cases/case_0001?application_id=${f.other}`,
          headers: outsider,
        })
      ).statusCode,
      404,
    );
    for (const route of [
      "workbench",
      "case-worklist",
      "work-queue",
      "finding-worklist",
    ])
      assert.equal(
        (
          await f.api.inject({
            url: `/admin/${route}?application_id=${f.app}`,
            headers: outsider,
          })
        ).statusCode,
        403,
      );
  } finally {
    await f.close();
  }
});

test("workbench and approval queue agree on role, self-approval, source mode and unknown result semantics", async () => {
  const f = await fixture();
  try {
    const op = await createOperation(
      f.db,
      f.cfg,
      f.actors.requester,
      f.app,
      "trade_00005",
      "Synthetic test reason",
      "queue-test",
    );
    await f.db.query(
      "INSERT INTO cases(id,application_id,title,created_by,owner_id) VALUES('mine',$1,'测试本人处理工单','requester','requester'),('unclaimed',$1,'测试未领取的工单','requester',NULL)",
      [f.app],
    );
    const requester = await f.session("requester"),
      approver = await f.session("approver");
    const get = (name: string, headers: any, query = "") =>
      f.api.inject({
        url: `/admin/${name}?application_id=${f.app}${query}`,
        headers,
      });
    assert.equal(
      (await get("workbench", requester)).json().pending_approvals,
      null,
    );
    assert.equal((await get("workbench", requester)).json().my_cases, "1");
    assert.equal(
      (await get("workbench", approver)).json().pending_approvals,
      "1",
    );
    assert.equal(
      (await get("work-queue", requester, "&inbox=approval")).statusCode,
      403,
    );
    assert.equal(
      (await get("work-queue", approver, "&inbox=approval")).json().total,
      "1",
    );
    await f.db.query(
      "UPDATE operation_requests SET requester_id='approver' WHERE id=$1",
      [op.id],
    );
    assert.equal(
      (await get("workbench", approver)).json().pending_approvals,
      "0",
    );
    await f.db.query(
      "UPDATE operation_requests SET state='execution_unknown' WHERE id=$1",
      [op.id],
    );
    assert.equal(
      (await get("workbench", approver)).json().unknown_results,
      "1",
    );
    assert.equal(
      (await get("work-queue", approver, "&inbox=unknown")).json().items[0]
        .state,
      "execution_unknown",
    );
    await f.db.query(
      "UPDATE applications SET source_mode='mishu' WHERE id=$1",
      [f.app],
    );
    await f.db.query(
      `INSERT INTO management_requests(id,application_id,case_id,target_id,type,requester_id,idempotency_key,intent,digest,preview,requester_security,requester_mfa,request_expires_at)
      SELECT 'real_'||n,$1,'mine','target_'||n,'refund_undelivered','requester','real_key_'||n,'{}','digest','{}','sensitive',false,CASE WHEN n=1 THEN now()+interval '1 hour' ELSE now()-interval '1 second' END FROM generate_series(1,2) n`,
      [f.app],
    );
    assert.equal(
      (await get("workbench", approver)).json().pending_approvals,
      "1",
    );
    const queue = (await get("work-queue", approver, "&inbox=approval")).json();
    assert.equal(queue.total, "1");
    assert.equal(queue.items[0].id, "real_1");
    assert.ok(!("requester_security" in queue.items[0]));
    assert.ok(!("source_command" in queue.items[0]));
    assert.equal(
      (await get("workbench", approver)).json().unknown_results,
      "0",
    );
  } finally {
    await f.close();
  }
});

test("audit filters preserve global-event visibility, exact matching, Shanghai dates and integer cursor validation", async () => {
  const f = await fixture();
  try {
    const headers = await f.session("requester");
    await f.db.query(
      `INSERT INTO audit_events(application_id,actor_id,action,object_id,detail,created_at) VALUES
      ($1,'requester','case.note','audit_case','{}','2026-01-01T16:00:00Z'),
      ($1,'approver','case.note','audit_case','{}','2026-01-01T15:59:59Z'),
      (NULL,'outsider','case.note','audit_case','{}','2026-01-01T16:00:00Z'),
      (NULL,'requester','case.note','audit_case','{}','2026-01-01T16:00:00Z'),
      ($2,'requester','case.note','audit_case','{}','2026-01-01T16:00:00Z')`,
      [f.app, f.other],
    );
    const get = (q: string) =>
      f.api.inject({
        url: `/admin/audit-events?application_id=${f.app}&object_id=audit_case${q}`,
        headers,
      });
    assert.equal(
      (await get("&from=2026-01-02&to=2026-01-02&action=case.note")).json()
        .length,
      2,
    );
    assert.equal((await get("&actor_id=approver")).json().length, 1);
    assert.equal((await get("&action=case")).json().length, 0);
    for (const query of [
      "&before=9223372036854775808",
      "&from=2026-02-30",
      "&from=2026-01-03&to=2026-01-02",
    ])
      assert.equal((await get(query)).statusCode, 400);
    assert.equal(
      (
        await f.api.inject({
          url: `/admin/audit-events?application_id=${f.app}`,
          headers: await f.session("approver"),
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test("account-linked journals use scoped entries and export-compatible filters", async () => {
  const f = await fixture();
  try {
    const entry = f.bundle.journals[0].entries[0];
    const result = await listData(
      f.db,
      f.app,
      "journal-transactions",
      filtersSchema.parse({ account_id: entry.account_id }),
    );
    assert.ok(result.items.length > 0);
    for (const j of result.items)
      assert.ok(j.entries.some((e: any) => e.account_id === entry.account_id));
    assert.equal(
      (
        await listData(
          f.db,
          f.other,
          "journal-transactions",
          filtersSchema.parse({ account_id: entry.account_id }),
        )
      ).total,
      "0",
    );
    await assert.rejects(() =>
      listData(
        f.db,
        f.app,
        "trades",
        filtersSchema.parse({ account_id: entry.account_id }),
      ),
    );
    const different = await listData(
      f.db,
      f.app,
      "journal-transactions",
      filtersSchema.parse({ account_id: "no_account" }),
    );
    assert.equal(different.total, "0");
  } finally {
    await f.close();
  }
});

test("finding worklist reaches all open findings and agrees with the dashboard", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "INSERT INTO jobs(id,application_id,kind) VALUES('run_worklist',$1,'reconcile')",
      [f.app],
    );
    await f.db.query(
      `INSERT INTO reconciliation_findings(id,application_id,rule,object_id,state,detail,first_run,last_run)
      SELECT 'finding_'||n,$1,'account_balance','user:test_'||n,CASE WHEN n%2=0 THEN 'resolved' ELSE 'open' END,'{"actual":"9007199254740993","expected":"0"}','run_worklist','run_worklist' FROM generate_series(1,235) n`,
      [f.app],
    );
    const headers = await f.session("requester");
    const get = (q: string) =>
      f.api.inject({
        url: `/admin/finding-worklist?application_id=${f.app}${q}`,
        headers,
      });
    const first = (await get("&state=open")).json();
    assert.equal(first.total, "118");
    const stats = (
      await f.api.inject({
        url: `/admin/workbench?application_id=${f.app}`,
        headers,
      })
    ).json();
    assert.equal(stats.open_findings, first.total);
    assert.equal(
      (await get("&q=user:test_1")).json().items[0].detail.actual,
      "9007199254740993",
    );
    assert.equal(
      (await get("&state=open&cursor=" + first.next_cursor)).json().items
        .length,
      25,
    );
    assert.equal(
      (await get("&state=resolved&cursor=" + first.next_cursor)).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});
