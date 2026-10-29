import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";
import {
  previewManagement,
  requestManagement,
  decideManagement,
  executeManagement,
} from "../packages/core/src/management.js";
import { digest } from "../packages/core/src/security.js";
import type {
  ManagementCommand,
  ManagementReceipt,
} from "../packages/contracts/src/management.js";

test("review gates financial preview, approval and dispatch while preserving an already committed receipt", async () => {
  const f = await fixture();
  const receipts = new Map<string, ManagementReceipt>();
  let executed = 0,
    canceled = 0,
    previewed = 0;
  const receiptFor = (
    command: ManagementCommand,
    succeeded: boolean,
  ): ManagementReceipt => ({
    command_id: command.intent.command_id,
    source_id: command.intent.source_id,
    request_digest: digest(command.intent),
    type: command.intent.operation.type,
    target_id: command.intent.operation.target_id,
    status: succeeded ? "succeeded" : "rejected",
    code: succeeded ? "completed" : "command_canceled",
    committed_at: new Date().toISOString(),
    journal_ids: [],
  });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/preview")) {
      previewed++;
      res.end(
        JSON.stringify({
          source_id: "test_source",
          operation: {
            ...body,
            amount: ["hold_trade", "release_trade"].includes(body.type)
              ? "0"
              : "100",
          },
          fingerprint: digest(body),
          target_name: "测试订单",
          status: "FUNDED",
          user_id: "buyer",
          balance: "100",
          hold_case_id: null,
          accept_by: null,
        }),
      );
    } else if (req.url?.includes("/receipts/")) {
      res.end(
        JSON.stringify({
          receipt:
            receipts.get(decodeURIComponent(req.url.split("/").at(-1)!)) ||
            null,
        }),
      );
    } else {
      const cancel = req.url?.endsWith("/cancel");
      if (cancel) canceled++;
      else executed++;
      const receipt =
        receipts.get(body.intent.command_id) || receiptFor(body, !cancel);
      receipts.set(body.intent.command_id, receipt);
      res.end(JSON.stringify(receipt));
    }
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    Object.assign(f.cfg, {
      sourceUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      sourceReadToken: "test_read",
      sourceCommandToken: "test_write",
      managementEnabled: true,
      requireMfa: false,
    });
    await f.db.query(
      "UPDATE applications SET source_mode='mishu',management_enabled=true WHERE id=$1",
      [f.app],
    );
    await f.db.query(
      "INSERT INTO cases(id,application_id,trade_id,title,created_by,owner_id,stage,category,requires_review) VALUES('review_case',$1,$2,'争议退款核验工单','requester','requester','in_progress','dispute',true)",
      [f.app, f.bundle.trades[0].id],
    );
    const input = {
      type: "refund_undelivered" as const,
      target_id: f.bundle.trades[0].id,
      case_id: "review_case",
    };
    await assert.rejects(
      previewManagement(f.db, f.cfg, f.actors.requester, f.app, input),
      (e: any) => e.code === "case_review_required",
    );
    assert.equal(previewed, 0);
    const hold = await previewManagement(
      f.db,
      f.cfg,
      f.actors.requester,
      f.app,
      { ...input, type: "hold_trade" },
    );
    assert.equal(hold.operation.amount, "0");
    const release = await previewManagement(
      f.db,
      f.cfg,
      f.actors.requester,
      f.app,
      { ...input, type: "release_trade" },
    );
    assert.equal(release.operation.amount, "0");
    const request = (key: string) =>
      requestManagement(f.db, f.cfg, f.actors.requester, {
        application_id: f.app,
        input,
        expected_fingerprint: digest(input),
        reason: "按已核验材料退还托管积分",
        evidence: "已核对买卖双方的交付说明与原始订单记录",
        idempotency_key: key,
        password: "Test-only-password-042!",
      });
    await assert.rejects(
      request("not_reviewed"),
      (e: any) => e.code === "case_review_required",
    );
    await f.db.query(
      "UPDATE cases SET review_status='accepted',reviewer_id='approver' WHERE id='review_case'",
    );
    const pending = await request("reviewed_request");
    const headers = await f.session("requester");
    for (const action of [
      "claim",
      "note",
      "update",
      "submit_review",
      "close",
      "assign",
    ]) {
      const r = await f.api.inject({
        method: "POST",
        url: "/admin/cases/review_case",
        headers,
        payload: {
          action,
          note: "新增材料应在取消申请后补充",
          ...(action === "assign" ? { owner_id: "requester" } : {}),
          ...(action === "update" ? { priority: "high" } : {}),
        },
      });
      assert.equal(
        r.json().error,
        "case_has_active_operations",
        action + ": " + r.body,
      );
    }
    const approve = (key: string) =>
      decideManagement(
        f.db,
        f.cfg,
        f.actors.approver,
        key,
        "approve",
        "已核对申请与工单核验结果",
        "Test-only-password-042!",
      );
    // Simulate a revoked review in storage to verify defense in depth at approval and dispatch.
    await f.db.query(
      "UPDATE cases SET review_status='returned' WHERE id='review_case'",
    );
    await assert.rejects(
      approve(pending.id),
      (e: any) => e.code === "case_review_required",
    );
    await f.db.query(
      "UPDATE cases SET review_status='accepted' WHERE id='review_case'",
    );
    await approve(pending.id);
    await f.db.query(
      "UPDATE cases SET review_status='none' WHERE id='review_case'",
    );
    await executeManagement(f.db, f.cfg);
    assert.equal(executed, 0);
    assert.equal(canceled, 1);
    assert.equal(
      (
        await f.db.query("SELECT state FROM management_requests WHERE id=$1", [
          pending.id,
        ])
      ).rows[0].state,
      "execution_failed",
    );
    await f.db.query(
      "UPDATE cases SET review_status='accepted' WHERE id='review_case'",
    );
    const alreadyCommitted = await request("already_committed");
    await approve(alreadyCommitted.id);
    const saved = (
      await f.db.query(
        "SELECT source_command FROM management_requests WHERE id=$1",
        [alreadyCommitted.id],
      )
    ).rows[0].source_command as ManagementCommand;
    receipts.set(saved.intent.command_id, receiptFor(saved, true));
    await f.db.query(
      "UPDATE cases SET review_status='none' WHERE id='review_case'",
    );
    await executeManagement(f.db, f.cfg);
    assert.equal(
      (
        await f.db.query("SELECT state FROM management_requests WHERE id=$1", [
          alreadyCommitted.id,
        ])
      ).rows[0].state,
      "succeeded",
    );
    assert.equal(executed, 0);
    assert.equal(canceled, 1);
    // Legacy cases without a review requirement still use their existing approval process.
    await f.db.query(
      "UPDATE cases SET requires_review=false WHERE id='review_case'",
    );
    assert.equal(
      (await previewManagement(f.db, f.cfg, f.actors.requester, f.app, input))
        .operation.amount,
      "100",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
