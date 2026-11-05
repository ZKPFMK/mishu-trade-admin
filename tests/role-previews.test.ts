import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fixture } from "./helpers.js";
import { previewRoles, setupRolePreviews } from "../scripts/role-previews.js";

test("five preview identities are single-role, scoped, repeatable and preserve original accounts", async () => {
  const f = await fixture();
  try {
    const baseUrl = await f.api.listen({ host: "127.0.0.1", port: 0 }),
      outputFile = path.join(f.cfg.dataDir, "previews.json"),
      input = {
        baseUrl,
        applicationId: f.app,
        admin: {
          email: "requester@test.local",
          password: "Test-only-password-042!",
        },
        outputFile,
      };
    const result = await setupRolePreviews(input);
    assert.equal(result.operators.length, 5);
    assert.equal(fs.statSync(outputFile).mode & 0o777, 0o600);
    const again = await setupRolePreviews(input);
    assert.deepEqual(again, result);
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM operators")).rows[0].n,
      9,
    );
    assert.deepEqual(
      (await f.db.query("SELECT roles FROM operators WHERE id='requester'"))
        .rows[0].roles,
      f.actors.requester.roles,
    );
    for (const [role] of previewRoles) {
      const saved = result.operators.find((p) => p.roles[0] === role)!;
      const login = await f.api.inject({
        method: "POST",
        url: "/auth/login",
        remoteAddress: "127.0.0.2",
        payload: { email: saved.email, password: saved.password },
      });
      assert.equal(login.statusCode, 200);
      const headers = {
        cookie: login.cookies[0].name + "=" + login.cookies[0].value,
        "x-csrf-token": login.json().csrf,
      };
      const get = (route: string) =>
        f.api.inject({
          url: `/admin/${route}?application_id=${f.app}`,
          headers,
        });
      const stats = (await get("workbench")).json();
      assert.equal(stats.pending_approvals, role === "approver" ? "0" : null);
      assert.equal(stats.my_cases, role === "operator" ? "0" : null);
      assert.equal(
        (await f.api.inject({ url: "/admin/operators", headers })).statusCode,
        role === "admin" ? 200 : 403,
      );
      assert.equal(
        (await get("audit-events")).statusCode,
        ["admin", "auditor"].includes(role) ? 200 : 403,
      );
      assert.equal(
        (
          await f.api.inject({
            url: `/admin/trades?application_id=${f.other}`,
            headers,
          })
        ).statusCode,
        403,
      );
      const me = (await f.api.inject({ url: "/auth/me", headers })).json();
      assert.equal(
        me.workspace.key,
        {
          admin: "system",
          operator: "operations",
          approver: "approvals",
          viewer: "overview",
          auditor: "audit",
        }[role],
      );
      assert.equal(
        (await f.api.inject({ url: "/admin/contexts", headers })).statusCode,
        200,
      );
      assert.equal(
        (await f.api.inject({ url: "/admin/applications", headers }))
          .statusCode,
        role === "admin" ? 200 : 403,
      );
      assert.equal(
        (await get("overview")).statusCode,
        ["operator", "approver", "viewer", "auditor"].includes(role)
          ? 200
          : 403,
      );
      assert.equal(
        (await get("operation-requests")).statusCode,
        ["operator", "approver", "auditor"].includes(role) ? 200 : 403,
      );
      assert.equal(
        (await get("reconciliation-findings")).statusCode,
        ["admin", "operator", "auditor"].includes(role) ? 200 : 403,
      );
      assert.equal(
        (await get("exports")).statusCode,
        ["operator", "auditor"].includes(role) ? 200 : 403,
      );
      const create = await f.api.inject({
        method: "POST",
        url: "/admin/cases",
        headers,
        payload: {
          application_id: f.app,
          title: "合成岗位权限工单",
          note: "仅在隔离环境验证运营处理权限",
        },
      });
      assert.equal(create.statusCode, role === "operator" ? 200 : 403);

      const approvals = await f.api.inject({
        url: `/admin/work-queue?application_id=${f.app}&inbox=approval`,
        headers,
      });
      assert.equal(approvals.statusCode, role === "approver" ? 200 : 403);
    }
    await f.db.query(
      "UPDATE applications SET source_mode='mishu',environment='production' WHERE id=$1",
      [f.app],
    );
    await assert.rejects(
      () => setupRolePreviews(input),
      /mock test application/,
    );
    await assert.rejects(
      () => setupRolePreviews({ ...input, baseUrl: "https://example.com" }),
      /local console origin/,
    );
  } finally {
    await f.close();
  }
});
