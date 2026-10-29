import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { chromium } from "playwright-core";
import { fixture } from "../tests/helpers.js";
import { sourceAdapter } from "../packages/adapters/src/index.js";
import { managementAdapter } from "../packages/adapters/src/management.js";
import { executeManagement } from "../packages/core/src/management.js";
import { syncSources } from "../packages/core/src/worker.js";
import { importSnapshot, queueJob } from "../packages/core/src/sync.js";
import { reconcile } from "../packages/core/src/reconciliation.js";

const platform = path.resolve(process.argv[2] || "../mishu-platform");
const apiOnly = process.argv.includes("--api-only");
const child = fork(path.join(platform, "scripts/trade-admin-fixture.ts"), {
  cwd: platform,
  execArgv: ["--import", "tsx"],
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let httpSerial = 0;
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
        m.error ? reject(Error(m.error)) : resolve(m.result);
      }
    };
    const exited = () => {
      clean();
      reject(Error("Fixture exited: " + stderr));
    };
    const timer = setTimeout(() => {
      clean();
      reject(Error("Fixture timed out: " + action + ": " + stderr));
    }, 30000);
    child.on("message", listener);
    child.once("exit", exited);
    child.send({ id, action, ...args });
  });
}
let f: Awaited<ReturnType<typeof fixture>> | undefined,
  proxy: http.Server | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const app = "real_source_test",
    connection = await command("start", {
      management: true,
      application_id: app,
    });
  f = await fixture(2);
  Object.assign(f.cfg, {
    sourceUrl: connection.base,
    sourceReadToken: connection.token,
    sourceCommandToken: connection.commandToken,
    managementEnabled: true,
    requireMfa: false,
  });
  await f.db.query(
    "INSERT INTO applications(id,name,environment,source_mode,management_enabled) VALUES($1,'运营联调','test','mishu',true)",
    [app],
  );
  for (const who of ["requester", "approver", "auditor"])
    await f.db.query("INSERT INTO operator_scopes VALUES($1,$2)", [who, app]);
  await importSnapshot(
    f.db,
    app,
    await sourceAdapter(f.db, f.cfg, {
      id: app,
      source_mode: "mishu",
    }).snapshot(),
  );
  const requester = await f.session("requester"),
    approver = await f.session("approver"),
    auditor = await f.session("auditor"),
    password = "Test-only-password-042!";
  async function api(
    route: string,
    body?: any,
    headers = requester,
    expected = 200,
  ) {
    const r = await f!.api.inject({
      remoteAddress: "127.0.1." + ((++httpSerial % 250) + 1),
      method: body ? "POST" : "GET",
      url: route,
      headers,
      ...(body ? { payload: body } : {}),
    });
    assert.equal(r.statusCode, expected, r.body);
    return r.json();
  }
  const state = async (id: string) =>
    (await f!.db.query("SELECT * FROM management_requests WHERE id=$1", [id]))
      .rows[0];
  const sync = () => syncSources(f!.db, f!.cfg);
  async function request(type: string, target: string, options: any = {}) {
    await sync();
    const c = options.case_id
      ? { id: options.case_id }
      : await api("/admin/management/cases", {
          application_id: app,
          ...(type === "adjust_credit" ? {} : { trade_id: target }),
          title: "已核验的测试工单",
          evidence: "隔离环境核验用户反馈与订单流水",
        });
    const input = {
      type,
      target_id: target,
      case_id: c.id,
      ...(options.amount ? { amount: options.amount } : {}),
      ...(options.reference ? { reference_command_id: options.reference } : {}),
    };
    const p = await api("/admin/management/preview", {
      application_id: app,
      input,
    });
    return api("/admin/management/requests", {
      application_id: app,
      input: p.operation,
      expected_fingerprint: p.fingerprint,
      reason: "用户问题已经核验",
      evidence: "已核对用户反馈、交付状态和积分流水",
      idempotency_key: "test_" + ++serial,
      password,
    });
  }
  const approve = (id: string) =>
    api(
      "/admin/management/requests/" + id + "/approve",
      { reason: "独立核验确认本次处理", password },
      approver,
    );
  async function execute(id: string) {
    await executeManagement(f!.db, f!.cfg);
    await sync();
    return state(id);
  }
  const first = await command("fund"),
    refund = await request("refund_undelivered", first.id);
  await api(
    "/admin/management/requests/" + refund.id + "/approve",
    { reason: "不得自己审批自己的申请", password },
    requester,
    403,
  );
  await api(
    "/admin/management/requests/" + refund.id + "/approve",
    { reason: "只读审计无审批权限", password },
    auditor,
    403,
  );
  await api(
    "/admin/cases/" + refund.case_id,
    { action: "close", note: "尚有申请，不能关闭工单" },
    requester,
    409,
  );
  await approve(refund.id);
  await Promise.all([
    executeManagement(f.db, f.cfg),
    executeManagement(f.db, f.cfg),
  ]);
  await sync();
  assert.equal((await state(refund.id)).state, "succeeded");
  assert.equal(
    (await command("state", { trade: first.id })).status,
    "REFUNDED",
  );
  const listed = await api("/admin/management/requests?application_id=" + app);
  assert.equal(listed.items[0].projection_synced, true);
  assert.ok(!("requester_security" in listed.items[0]));

  const delivered = await command("fund"),
    stale = await request("refund_undelivered", delivered.id);
  await approve(stale.id);
  await command("deliver", { trade: delivered.id });
  assert.equal((await execute(stale.id)).state, "execution_failed");
  assert.equal(
    (await command("state", { trade: delivered.id })).status,
    "DELIVERED",
  );
  await command("expire", { trade: delivered.id });
  const settle = await request("retry_settlement", delivered.id);
  await approve(settle.id);
  assert.equal((await execute(settle.id)).state, "succeeded");
  assert.equal(
    (await command("state", { trade: delivered.id })).status,
    "COMPLETED",
  );

  const held = await command("fund"),
    hold = await request("hold_trade", held.id);
  await approve(hold.id);
  assert.equal((await execute(hold.id)).state, "succeeded");
  assert.ok((await command("state", { trade: held.id })).hold);
  await f.db.query(
    "UPDATE applications SET management_enabled=false WHERE id=$1",
    [app],
  );
  await api(
    "/admin/cases/" + hold.case_id,
    { action: "close", note: "仍有来源暂停，不能关单" },
    requester,
    409,
  );
  await f.db.query(
    "UPDATE applications SET management_enabled=true WHERE id=$1",
    [app],
  );
  const release = await request("release_trade", held.id, {
    case_id: hold.case_id,
  });
  await approve(release.id);
  assert.equal((await execute(release.id)).state, "succeeded");
  assert.ok(!(await command("state", { trade: held.id })).hold);
  await api("/admin/cases/" + hold.case_id, {
    action: "close",
    note: "暂停已解除，用户问题已处理",
  });

  const wallet = await command("wallet"),
    credit = await request("adjust_credit", wallet.account, { amount: "50" });
  await approve(credit.id);
  assert.equal((await execute(credit.id)).state, "succeeded");
  assert.equal((await command("wallet")).balance, wallet.balance + 50);
  const reversal = await request("adjust_credit", wallet.account, {
    amount: "-50",
    reference: credit.intent.command_id,
  });
  await approve(reversal.id);
  assert.equal((await execute(reversal.id)).state, "succeeded");
  assert.equal((await command("wallet")).balance, wallet.balance);

  const revocable = await command("fund"),
    revoked = await request("refund_undelivered", revocable.id);
  await approve(revoked.id);
  await f.db.query("UPDATE operators SET roles='{}' WHERE id='approver'");
  const denied = await execute(revoked.id);
  assert.equal(denied.state, "execution_failed");
  assert.equal(denied.receipt.code, "command_canceled");
  assert.equal(
    (await command("state", { trade: revocable.id })).status,
    "FUNDED",
  );
  assert.equal(
    (await managementAdapter(f.cfg).execute(denied.source_command)).code,
    "command_canceled",
  );
  await f.db.query(
    "UPDATE operators SET roles=ARRAY['approver','viewer'] WHERE id='approver'",
  );

  const lost = await command("fund"),
    uncertain = await request("refund_undelivered", lost.id);
  await approve(uncertain.id);
  let drop = true;
  proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const upstream = await fetch(new URL(req.url!, connection.base), {
        method: req.method,
        headers: {
          authorization: String(req.headers.authorization || ""),
          ...(req.method === "POST"
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      });
      const body = await upstream.text();
      if (drop && req.url!.endsWith("/management/commands")) {
        drop = false;
        res.destroy();
        return;
      }
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(body);
    } catch {
      res.destroy();
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  f.cfg.sourceUrl = "http://127.0.0.1:" + (proxy.address() as any).port;
  assert.equal((await execute(uncertain.id)).state, "execution_unknown");
  assert.equal((await command("state", { trade: lost.id })).status, "REFUNDED");
  await f.db.query("UPDATE operators SET roles='{}' WHERE id='approver'");
  await f.db.query(
    "UPDATE management_requests SET next_attempt_at=now(),approval_expires_at=now()-interval '1 minute' WHERE id=$1",
    [uncertain.id],
  );
  assert.equal((await execute(uncertain.id)).state, "succeeded");
  await f.db.query(
    "UPDATE operators SET roles=ARRAY['approver','viewer'] WHERE id='approver'",
  );
  f.cfg.sourceUrl = connection.base;
  await new Promise<void>((r) => proxy!.close(() => r()));
  proxy = undefined;

  // A production application cannot downgrade operation MFA by running the console in development mode.
  await f.db.query(
    "UPDATE applications SET environment='production' WHERE id=$1",
    [app],
  );
  const production = await command("fund");
  await sync();
  const pc = await api("/admin/management/cases", {
    application_id: app,
    trade_id: production.id,
    title: "生产多因素验证测试",
    evidence: "没有绑定验证器的用户不得发起资金操作",
  });
  const pi = {
      type: "refund_undelivered",
      target_id: production.id,
      case_id: pc.id,
    },
    pp = await api("/admin/management/preview", {
      application_id: app,
      input: pi,
    });
  const forbidden = await api(
    "/admin/management/requests",
    {
      application_id: app,
      input: pp.operation,
      expected_fingerprint: pp.fingerprint,
      reason: "验证生产环境权限要求",
      evidence: "生产应用必须绑定验证器才能发起操作",
      idempotency_key: "production_mfa",
      password,
    },
    requester,
    403,
  );
  assert.equal(forbidden.error, "mfa_enrollment_required");
  await f.db.query("UPDATE applications SET environment='test' WHERE id=$1", [
    app,
  ]);

  // Exercise the shipped UI with a new synthetic purchase, two separate browser sessions and actual source execution.
  if (!apiOnly) {
    const uiTrade = await command("fund");
    await sync();
    const base = await f.api.listen({ host: "127.0.0.1", port: 0 });
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROMIUM_PATH ||
        "/Users/dj/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    });
    const one = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      two = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      p = await one.newPage(),
      q = await two.newPage(),
      errors: string[] = [];
    for (const page of [p, q])
      page.on("pageerror", (e) => errors.push(e.message));
    async function login(page: typeof p, name: string) {
      await page.goto(base);
      await page.getByLabel("账号邮箱").fill(name + "@test.local");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page
        .getByRole("button", { name: "登录工作台", exact: false })
        .click();
      await page
        .getByRole("heading", { name: "我的工作台", exact: true })
        .waitFor();
      await page.goto(base + "/#reviews");
    }
    await login(p, "requester");
    await p.getByRole("button", { name: "发起运营处理", exact: true }).click();
    await p.getByLabel("订单编号", { exact: true }).fill(uiTrade.id);
    await p
      .getByLabel("处理依据与凭证编号")
      .fill("用户反馈并已核对订单尚未交付，保留完整核验依据");
    await p.getByRole("button", { name: "新建并领取处理工单" }).click();
    await p
      .getByLabel("申请理由", { exact: true })
      .fill("核验通过，退回未交付订单的托管积分");
    await p.getByRole("button", { name: "核对来源状态" }).click();
    await p.getByLabel("当前账号密码", { exact: true }).fill(password);
    await p.getByRole("button", { name: "提交独立审批", exact: true }).click();
    await p
      .getByRole("dialog", { name: "发起运营处理" })
      .waitFor({ state: "hidden" });
    await login(q, "approver");
    await q.getByRole("button", { name: "独立审批", exact: true }).click();
    await q
      .getByLabel("处理意见", { exact: true })
      .fill("独立审核凭证和当前交付状态，同意本次退款");
    await q.getByLabel("当前账号密码", { exact: true }).fill(password);
    await q.getByRole("button", { name: "确认处理", exact: true }).click();
    await q
      .getByRole("dialog", { name: "独立审批确认" })
      .waitFor({ state: "hidden" });
    await executeManagement(f.db, f.cfg);
    await sync();
    assert.equal(
      (await command("state", { trade: uiTrade.id })).status,
      "REFUNDED",
    );
    await p.reload();
    await p.getByRole("heading", { name: "运营处理与独立审批" }).waitFor();
    fs.mkdirSync(".local/management-ui", { recursive: true });
    await p.screenshot({
      path: ".local/management-ui/requests.png",
      fullPage: true,
    });
    await p.getByRole("button", { name: "安全验证", exact: true }).click();
    await p.getByRole("dialog", { name: "账号安全验证" }).waitFor();
    await p.getByText("尚未绑定验证器", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  }
  const run = await queueJob(f.db, app, null, "reconcile"),
    result = await reconcile(f.db, app, run);
  assert.equal(result.outcome, "passed", JSON.stringify(result));
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM management_requests WHERE state='execution_unknown'",
      )
    ).rows[0].n,
    0,
  );
  console.log(
    "Management integration passed: real HTTP refund/settlement/holds/compensation/reversal, two-person approval, scope and MFA gates, case closure, revoked permissions, lost response recovery without double spending, " +
      (apiOnly
        ? "API-only mode (browser checks skipped), "
        : "browser workflow, ") +
      "balanced reconciliation.",
  );
} finally {
  await browser?.close();
  if (proxy) await new Promise<void>((r) => proxy!.close(() => r()));
  if (child.connected) {
    await command("stop").catch(() => {});
    const exit = once(child, "exit");
    child.disconnect();
    await exit;
  }
  await f?.close();
}
