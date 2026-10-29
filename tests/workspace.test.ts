import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";

const note = "已核对订单与用户反馈记录";
const created = (app: string, extra = {}) => ({
  application_id: app,
  title: "买家反馈交付内容存在问题",
  note,
  ...extra,
});

test("case workflow enforces scope, assignment eligibility, independent review and material changes", async () => {
  const f = await fixture();
  try {
    const admin = await f.session("requester"),
      reviewer = await f.session("approver"),
      audit = await f.session("auditor"),
      outsider = await f.session("outsider");
    const post = (url: string, payload: unknown, headers = admin) =>
      f.api.inject({ method: "POST", url, payload: payload as any, headers });
    const row = await post(
      "/admin/cases",
      created(f.app, { category: "dispute", priority: "urgent" }),
    );
    assert.equal(row.statusCode, 200, row.body);
    const key = row.json().id,
      url = "/admin/cases/" + key;
    for (const route of [
      "/admin/workspace",
      "/admin/workspace/cases",
      "/admin/case-assignees",
    ]) {
      const r = await f.api.inject({
        url: `${route}?application_id=${f.app}`,
        headers: outsider,
      });
      assert.equal(r.statusCode, 403, r.body);
    }
    assert.equal(
      (await f.api.inject({ url, headers: outsider })).statusCode,
      403,
    );
    assert.equal(
      (await post(url, { action: "claim", note }, outsider)).statusCode,
      403,
    );
    assert.equal(
      (await post("/admin/cases", created(f.app), outsider)).statusCode,
      403,
    );
    assert.equal(
      (await post(url, { action: "claim", note }, audit)).statusCode,
      403,
    );
    assert.equal(
      (await post("/admin/cases", created(f.app), audit)).statusCode,
      403,
    );
    assert.equal(
      (await post(url, { action: "assign", owner_id: "outsider", note })).json()
        .error,
      "case_assignee_invalid",
    );
    assert.equal(
      (await post(url, { action: "assign", owner_id: "approver", note })).json()
        .error,
      "case_assignee_invalid",
    );
    await f.db.query("UPDATE operators SET enabled=false WHERE id='requester'");
    // Other administrators cannot assign work to a disabled operator either.
    await f.db.query(
      "UPDATE operators SET roles=array_append(roles,'admin') WHERE id='approver'",
    );
    assert.equal(
      (
        await post(
          url,
          { action: "assign", owner_id: "requester", note },
          reviewer,
        )
      ).json().error,
      "case_assignee_invalid",
    );
    await f.db.query(
      "UPDATE operators SET enabled=true,roles=array_append(roles,'approver') WHERE id='requester'",
    );
    assert.equal((await post(url, { action: "claim", note })).statusCode, 200);
    assert.equal(
      (await post(url, { action: "close", note })).json().error,
      "case_review_required",
    );
    assert.equal(
      (await post(url, { action: "update", category: "follow_up", note }))
        .statusCode,
      200,
    );
    assert.equal(
      (await post(url, { action: "close", note })).json().error,
      "case_review_required",
    );
    assert.equal(
      (await post(url, { action: "submit_review", note })).statusCode,
      200,
    );
    assert.equal(
      (await post(url, { action: "update", stage: "in_progress", note })).json()
        .error,
      "case_review_pending",
    );
    assert.equal(
      (await post(url, { action: "note", note })).json().error,
      "case_review_pending",
    );
    assert.equal(
      (await post(url, { action: "review", decision: "accept", note })).json()
        .error,
      "self_review_forbidden",
    );
    assert.equal(
      (
        await post(
          url,
          { action: "review", decision: "accept", note },
          reviewer,
        )
      ).statusCode,
      200,
    );
    assert.equal((await post(url, { action: "claim", note })).statusCode, 200);
    assert.equal(
      (await post(url, { action: "close", note })).json().error,
      "case_review_required",
    );
    await post(url, { action: "submit_review", note });
    await post(url, { action: "review", decision: "accept", note }, reviewer);
    assert.equal((await post(url, { action: "note", note })).statusCode, 200);
    assert.equal(
      (await post(url, { action: "close", note })).json().error,
      "case_review_required",
    );
    assert.equal(
      (await post(url, { action: "submit_review", note })).statusCode,
      200,
    );
    assert.equal(
      (
        await post(
          url,
          { action: "review", decision: "return", note },
          reviewer,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await post(url, { action: "close", note })).json().error,
      "case_review_required",
    );
    await post(url, { action: "submit_review", note });
    await post(url, { action: "review", decision: "accept", note }, reviewer);
    assert.equal((await post(url, { action: "close", note })).statusCode, 200);
    const detail = (await f.api.inject({ url, headers: admin })).json();
    assert.equal(detail.stage, "resolved");
    assert.equal(detail.state, "closed");
    assert.ok(detail.closed_at);
    assert.equal(detail.requires_review, true);
    assert.equal(detail.reviewer_name, "approver");
    assert.ok(detail.notes.every((n: any) => n.actor_name && n.event.action));
    assert.equal(
      (await post(url, { action: "note", note })).json().error,
      "case_closed",
    );
    assert.equal(
      (await post(url, { action: "update", priority: "high", note })).json()
        .error,
      "case_closed",
    );
    const events = (
      await f.db.query(
        "SELECT detail FROM audit_events WHERE object_id=$1 AND action='case.review'",
        [key],
      )
    ).rows;
    assert.ok(
      events.every(
        (e) =>
          e.detail.before.stage === "pending_review" &&
          e.detail.after.stage === "in_progress",
      ),
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM management_requests"))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM operation_requests"))
        .rows[0].n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("workspace reports actual scoped queues and bounded pagination without exposing team data to viewers", async () => {
  const f = await fixture();
  try {
    const admin = await f.session("requester"),
      auditor = await f.session("auditor"),
      reviewer = await f.session("approver");
    const create = async (extra: any) =>
      (
        await f.api.inject({
          method: "POST",
          url: "/admin/cases",
          headers: admin,
          payload: created(f.app, extra),
        })
      ).json().id;
    const key = await create({
      due_at: "2020-01-01T00:00:00Z",
      priority: "urgent",
      category: "after_sales",
    });
    await f.api.inject({
      method: "POST",
      url: "/admin/cases/" + key,
      headers: admin,
      payload: { action: "claim", note },
    });
    const other = await create({ category: "dispute" });
    await f.api.inject({
      method: "POST",
      url: "/admin/cases/" + other,
      headers: admin,
      payload: { action: "claim", note },
    });
    await f.api.inject({
      method: "POST",
      url: "/admin/cases/" + other,
      headers: admin,
      payload: { action: "submit_review", note },
    });
    await create({});
    const get = (path: string, headers = admin) =>
      f.api.inject({ url: path, headers });
    const workspace = (
      await get(`/admin/workspace?application_id=${f.app}`)
    ).json();
    assert.equal(workspace.summary.open, 3);
    assert.equal(workspace.summary.mine, 2);
    assert.equal(workspace.summary.unassigned, 1);
    assert.equal(workspace.summary.overdue, 1);
    assert.equal(workspace.summary.review, 1);
    assert.equal(
      workspace.summary.disputed_trades,
      f.bundle.trades.filter((t) => t.status === "DISPUTED").length,
    );
    assert.equal(
      workspace.summary.awaiting_delivery,
      f.bundle.trades.filter((t) => t.status === "FUNDED").length,
    );
    assert.equal(workspace.risks.length <= 12, true);
    assert.ok(workspace.risks.every((t: any) => typeof t.price === "string"));
    assert.equal(
      workspace.team.find((x: any) => x.id === "requester").overdue,
      1,
    );
    assert.equal(workspace.capabilities.assign_cases, true);
    await f.db.query("INSERT INTO operator_scopes VALUES('requester',$1)", [
      f.other,
    ]);
    assert.equal(
      (await get(`/admin/cases/${key}?application_id=${f.other}`)).json().error,
      "case_application_mismatch",
    );
    const reviewerWorkspace = (
      await get(`/admin/workspace?application_id=${f.app}`, reviewer)
    ).json();
    assert.deepEqual(reviewerWorkspace.team, []);
    assert.equal(reviewerWorkspace.capabilities.review_cases, true);
    assert.equal(reviewerWorkspace.capabilities.manage_cases, false);
    assert.equal(
      (await get(`/admin/workspace?application_id=${f.app}`, auditor)).json()
        .capabilities.view_team,
      true,
    );
    const list = (
      await get(
        `/admin/workspace/cases?application_id=${f.app}&scope=overdue&category=after_sales&priority=urgent`,
      )
    ).json();
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, key);
    assert.equal(
      (
        await get(
          `/admin/workspace/cases?application_id=${f.app}&scope=unassigned`,
        )
      ).json().total,
      1,
    );
    assert.equal(
      (
        await get(`/admin/workspace/cases?application_id=${f.app}&scope=review`)
      ).json().items[0].id,
      other,
    );
    assert.equal(
      (
        await get(`/admin/workspace/cases?application_id=${f.app}&q=${key}`)
      ).json().total,
      1,
    );
    assert.equal(
      (await get(`/admin/workspace/cases?application_id=${f.app}&page=0`))
        .statusCode,
      400,
    );
    for (let i = 0; i < 26; i++)
      await create({ title: "分页核验测试任务编号" + i });
    const page1 = (
      await get(
        `/admin/workspace/cases?application_id=${f.app}&q=分页核验&page=1`,
      )
    ).json();
    const page2 = (
      await get(
        `/admin/workspace/cases?application_id=${f.app}&q=分页核验&page=2`,
      )
    ).json();
    assert.equal(page1.total, 26);
    assert.equal(page1.items.length, 25);
    assert.equal(page2.items.length, 1);
    assert.ok(!page1.items.some((x: any) => x.id === page2.items[0].id));
    assert.ok(
      Array.isArray((await get(`/admin/cases?application_id=${f.app}`)).json()),
    );
  } finally {
    await f.close();
  }
});

test("assignment is admin-only, invalidates completed review and preserves case history", async () => {
  const f = await fixture();
  try {
    const admin = await f.session("requester"),
      reviewer = await f.session("approver");
    await f.db.query(
      "INSERT INTO operators(id,email,name,password_hash,roles) SELECT 'handler','handler@test.local','客服乙',password_hash,ARRAY['operator','viewer'] FROM operators WHERE id='requester'",
    );
    await f.db.query("INSERT INTO operator_scopes VALUES('handler',$1)", [
      f.app,
    ]);
    const handler = await f.session("handler");
    const key = (
      await f.api.inject({
        method: "POST",
        url: "/admin/cases",
        headers: admin,
        payload: created(f.app, { category: "dispute" }),
      })
    ).json().id;
    const act = (b: any, headers = admin) =>
      f.api.inject({
        method: "POST",
        url: "/admin/cases/" + key,
        headers,
        payload: { note, ...b },
      });
    assert.equal(
      (await act({ action: "assign", owner_id: "handler" }, handler))
        .statusCode,
      403,
    );
    assert.equal(
      (await act({ action: "assign", owner_id: "handler" })).statusCode,
      200,
    );
    assert.equal(
      (await act({ action: "update", priority: "high" })).json().error,
      "case_owner_only",
    );
    await act({ action: "submit_review" }, handler);
    await act({ action: "review", decision: "accept" }, reviewer);
    await act({ action: "assign", owner_id: "requester" });
    assert.equal(
      (await act({ action: "close" })).json().error,
      "case_review_required",
    );
    assert.equal(
      (await act({ action: "update", stage: "resolved" })).statusCode,
      400,
    );
    assert.equal(
      (await act({ action: "claim", category: "other" })).statusCode,
      400,
    );
    const row = (await f.db.query("SELECT * FROM cases WHERE id=$1", [key]))
      .rows[0];
    assert.equal(row.review_status, "none");
    assert.equal(row.owner_id, "requester");
    assert.ok(
      (
        await f.db.query(
          "SELECT * FROM case_notes WHERE case_id=$1 AND event->>'action'='review'",
          [key],
        )
      ).rowCount,
    );
  } finally {
    await f.close();
  }
});

test("closing and reassigning cannot bypass active financial requests; closing also checks authoritative holds", async () => {
  const f = await fixture();
  let held = true;
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ...f.bundle.trades[0],
        operational_hold: held
          ? { case_id: "guard_case", since: new Date().toISOString() }
          : null,
      }),
    );
  });
  try {
    const headers = await f.session("requester");
    await f.db.query(
      "INSERT INTO cases(id,application_id,trade_id,title,created_by,owner_id,stage) VALUES('guard_case',$1,$2,'核对暂停订单与在途申请','requester','requester','in_progress')",
      [f.app, f.bundle.trades[0].id],
    );
    await f.db.query(
      `INSERT INTO management_requests(id,application_id,case_id,target_id,type,requester_id,idempotency_key,intent,digest,preview,requester_security,requester_mfa,state,request_expires_at)
      VALUES('guard_request',$1,'guard_case',$2,'hold_trade','requester','guard_key','{}','digest','{}','security',false,'execution_unknown',now()+interval '1 day')`,
      [f.app, f.bundle.trades[0].id],
    );
    const act = (action: string) =>
      f.api.inject({
        method: "POST",
        url: "/admin/cases/guard_case",
        headers,
        payload: {
          action,
          note,
          ...(action === "assign" ? { owner_id: "requester" } : {}),
        },
      });
    assert.equal(
      (await act("close")).json().error,
      "case_has_active_operations",
    );
    assert.equal(
      (await act("assign")).json().error,
      "case_has_active_operations",
    );
    await f.db.query(
      "UPDATE management_requests SET state='succeeded' WHERE id='guard_request'",
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    f.cfg.sourceUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    f.cfg.sourceReadToken = "test_only_read_token";
    await f.db.query(
      "UPDATE applications SET source_mode='mishu' WHERE id=$1",
      [f.app],
    );
    assert.equal((await act("close")).json().error, "case_has_active_hold");
    held = false;
    assert.equal((await act("close")).statusCode, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test("voluntary review on a follow-up case cannot be bypassed after a return", async () => {
  const f = await fixture();
  try {
    const headers = await f.session("requester"),
      reviewer = await f.session("approver");
    const key = (
      await f.api.inject({
        method: "POST",
        url: "/admin/cases",
        headers,
        payload: created(f.app),
      })
    ).json().id;
    const action = (action: string, extra = {}, session = headers) =>
      f.api.inject({
        method: "POST",
        url: "/admin/cases/" + key,
        headers: session,
        payload: { action, note, ...extra },
      });
    await action("claim");
    await action("submit_review");
    await action("review", { decision: "return" }, reviewer);
    assert.equal((await action("close")).json().error, "case_review_required");
    await action("update", { priority: "urgent", category: "other" });
    assert.equal((await action("close")).json().error, "case_review_required");
    await action("submit_review");
    await action("review", { decision: "accept" }, reviewer);
    assert.equal((await action("close")).statusCode, 200);
  } finally {
    await f.close();
  }
});
