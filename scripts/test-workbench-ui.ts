import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fixture } from "../tests/helpers.js";
import { createOperation } from "../packages/core/src/operations.js";
import { ROOT } from "../packages/core/src/config.js";

const f = await fixture(60),
  out = path.join(ROOT, ".local/ui-tests");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await f.db.query(
    `INSERT INTO cases(id,application_id,title,trade_id,owner_id,created_by,updated_at)
    SELECT 'old_case_'||lpad(n::text,4,'0'),$1,'历史查询工单'||n,'trade_00005',CASE WHEN n%2=0 THEN 'requester' ELSE NULL END,'requester','2026-01-01T00:00:00.123456Z' FROM generate_series(1,235) n`,
    [f.app],
  );
  await f.db.query(
    "INSERT INTO case_notes(case_id,actor_id,note) VALUES('old_case_0001','requester','历史工单的完整处理依据')",
  );
  await f.db.query("INSERT INTO operator_scopes VALUES('requester',$1)", [
    f.other,
  ]);
  await createOperation(
    f.db,
    f.cfg,
    f.actors.requester,
    f.app,
    "trade_00005",
    "合成数据申请供待办查询验证",
    "workbench-ui",
  );
  await f.db.query(
    "INSERT INTO audit_events(application_id,actor_id,action,object_id,detail) VALUES($1,'requester','case.note','old_case_0001','{}')",
    [f.app],
  );
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const base = await f.api.listen({ host: "127.0.0.1", port: 0 }),
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const login = async (name: string, target = page) => {
    await target.goto(base);
    assert.equal(
      await target.getByLabel("账号邮箱").inputValue(),
      "",
      "shared login must not prefill an administrator account",
    );
    await target
      .getByText("所有后台成员均使用个人账号登录", { exact: false })
      .waitFor();
    await target.getByLabel("账号邮箱").fill(name + "@test.local");
    await target
      .getByLabel("密码", { exact: true })
      .fill("Test-only-password-042!");
    await target.getByRole("button", { name: "登录工作台" }).click();
    await target.locator("h1").waitFor();
    if (
      !(await target
        .getByRole("heading", { name: "运营待办", exact: true })
        .count())
    ) {
      await target
        .locator("nav")
        .getByRole("link", { name: "异常与审批", exact: true })
        .click();
    }
    await target
      .getByRole("heading", { name: "运营待办", exact: true })
      .waitFor();
  };
  const nav = async (label: string) => {
    await page
      .locator("nav")
      .getByRole("link", { name: label, exact: true })
      .click();
    await page.getByRole("heading", { name: label, exact: true }).waitFor();
  };
  await login("requester");
  const identity = page.getByRole("region", {
    name: "当前登录身份",
    exact: true,
  });
  await identity.getByText("requester@test.local", { exact: true }).waitFor();
  await identity.getByText("系统管理员", { exact: true }).waitFor();
  await identity.getByText("运营处理", { exact: true }).waitFor();
  await identity.getByText("共 2 个授权应用", { exact: false }).waitFor();
  assert.equal(await page.getByRole("link", { name: /待我审批/ }).count(), 0);
  await page.getByRole("link", { name: /我的开放工单/ }).click();
  await page.getByText("共 117 条", { exact: false }).waitFor();
  assert.equal(await page.getByLabel("工单负责人").inputValue(), "me");
  await page.getByLabel("工单搜索").fill("old_case_0002");
  await page.getByRole("button", { name: "查询工单", exact: true }).click();
  await page
    .getByRole("heading", { name: "历史查询工单2", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "历史查询工单2", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("工单搜索").inputValue(), "old_case_0002");
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await page.getByText("共 235 条", { exact: false }).waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("游标分页", { exact: false }).waitFor();
  const secondPage = page.url();
  await page.reload();
  await page.getByText("游标分页", { exact: false }).waitFor();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await page.getByText("第 1 页", { exact: false }).waitFor();
  await page.goBack();
  await page.getByText("游标分页", { exact: false }).waitFor();
  assert.equal(page.url(), secondPage);
  const direct = await context.newPage();
  direct.on("pageerror", (e) => errors.push(e.message));
  await direct.goto(secondPage);
  await direct.getByText("游标分页", { exact: false }).waitFor();
  await direct.getByRole("button", { name: "上一页", exact: true }).click();
  await direct.getByText("第 1 页", { exact: false }).waitFor();
  assert.ok(direct.url().startsWith(base));
  await direct.close();

  await page.goto(
    base + "#operations?app=" + f.app + "&tab=cases&case_id=old_case_0001",
  );
  const detail = page.getByRole("dialog", { name: "工单详情", exact: true });
  await detail.getByText("历史工单的完整处理依据", { exact: false }).waitFor();
  await page.reload();
  await detail.getByText("历史工单的完整处理依据", { exact: false }).waitFor();
  await detail.getByRole("link", { name: "trade_00005", exact: true }).click();
  const trade = page.getByRole("dialog", { name: "订单详情", exact: true });
  await trade.getByRole("link", { name: "关联流水", exact: true }).waitFor();
  await trade.getByRole("link", { name: "关联流水", exact: true }).click();
  await page.locator("details.journal").first().waitFor();
  await page.goBack();
  await trade.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page.getByLabel("编号搜索").fill("");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page.getByLabel("跳转页码").fill("2");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await page.getByText("第 2 页 · 共 3 页", { exact: false }).waitFor();
  const ordersPage = page.url();
  await page.locator("tbody tr").first().getByRole("link").first().click();
  await page.getByRole("heading", { name: "积分账户", exact: true }).waitFor();
  await page.locator("tbody tr").first().getByRole("link").first().click();
  await page.getByText("账户流水：", { exact: false }).waitFor();
  await page.locator("details.journal").first().waitFor();
  assert.ok(page.url().includes("account_id="));
  await nav("全部订单");
  await page.getByText("第 2 页 · 共 3 页", { exact: false }).waitFor();
  assert.equal(page.url(), ordersPage);
  await page.reload();
  await page.getByText("第 2 页 · 共 3 页", { exact: false }).waitFor();
  await page.getByLabel("当前应用").selectOption(f.other);
  await page.getByText("没有符合筛选条件的记录", { exact: true }).waitFor();
  assert.ok(!page.url().includes("page="));
  assert.ok(!page.url().includes("cursor="));
  await page.getByLabel("当前应用").selectOption(f.app);
  await page.getByText("第 1 页 · 共 3 页", { exact: false }).waitFor();
  await nav("操作审计");
  await page.getByLabel("操作者编号", { exact: true }).fill("requester");
  await page.getByLabel("操作类型", { exact: true }).fill("case.note");
  await page.getByLabel("审计对象编号", { exact: true }).fill("old_case_0001");
  await page.getByRole("button", { name: "查询审计", exact: true }).click();
  await page.locator("tbody tr").filter({ hasText: "old_case_0001" }).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll("tbody tr").length === 1,
  );
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.reload();
  await page.locator("tbody tr").filter({ hasText: "old_case_0001" }).waitFor();
  assert.equal(
    await page.getByLabel("操作类型", { exact: true }).inputValue(),
    "case.note",
  );
  await page.getByRole("button", { name: "切换浅色模式", exact: true }).click();
  await page.screenshot({
    path: path.join(out, "workbench-audit-light.png"),
    animations: "disabled",
  });
  await page.goto(
    base + "#operations?app=" + f.app + "&tab=cases&q=old_case_0001",
  );
  await page
    .getByRole("heading", { name: "历史查询工单1", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(out, "workbench-cases-light.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "cases mobile layout must not overflow",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await page.locator(".app-shell").count(), 1);
  assert.equal(await page.locator(".sidebar").count(), 1);
  await page.screenshot({
    path: path.join(out, "workbench-cases-mobile.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "回到首页", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(out, "workbench-cases-mobile-bottom.png"),
    animations: "disabled",
  });
  await nav("工作概览");
  await page.getByRole("link", { name: /待领取工单/ }).waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "workbench mobile layout must not overflow",
  );
  const approvalContext = await browser.newContext(),
    approvalPage = await approvalContext.newPage();
  approvalPage.on("pageerror", (e) => errors.push(e.message));
  await login("approver", approvalPage);
  const approvalIdentity = approvalPage.getByRole("region", {
    name: "当前登录身份",
    exact: true,
  });
  await approvalIdentity.getByText("独立审批", { exact: true }).waitFor();
  assert.equal(
    await approvalIdentity.getByText("系统管理员", { exact: true }).count(),
    0,
  );
  assert.equal(
    await approvalPage
      .locator("nav")
      .getByRole("link", { name: "操作员", exact: true })
      .count(),
    0,
  );
  const pending = approvalPage.getByRole("link", { name: /待我审批/ });
  await pending.locator("strong").filter({ hasText: "1" }).waitFor();
  await pending.click();
  await approvalPage
    .getByRole("button", { name: "审批通过", exact: true })
    .waitFor();
  assert.ok(approvalPage.url().includes("inbox=approval"));
  await approvalContext.close();
  const auditorContext = await browser.newContext(),
    auditorPage = await auditorContext.newPage();
  auditorPage.on("pageerror", (e) => errors.push(e.message));
  await login("auditor", auditorPage);
  await auditorPage
    .getByRole("region", { name: "当前登录身份", exact: true })
    .getByText("审计", { exact: true })
    .waitFor();
  assert.equal(
    await auditorPage
      .getByRole("link", { name: /待我审批|我的开放工单/ })
      .count(),
    0,
  );
  await auditorPage
    .locator("nav")
    .getByRole("link", { name: "操作审计", exact: true })
    .waitFor();
  assert.equal(
    await auditorPage
      .locator("nav")
      .getByRole("link", { name: "操作员", exact: true })
      .count(),
    0,
  );
  await auditorContext.close();
  // Only synthetic read models change here; no real-source command is sent.
  f.cfg.managementEnabled = true;
  await f.db.query(
    "UPDATE applications SET source_mode='mishu',management_enabled=true WHERE id=$1",
    [f.app],
  );
  await page.goto(
    base + "#trades?app=" + f.app + "&q=trade_00005&detail=trade_00005",
  );
  await page
    .getByRole("dialog", { name: "订单详情", exact: true })
    .getByRole("button", { name: "运营处理", exact: true })
    .click();
  const management = page.getByRole("dialog", {
    name: "发起运营处理",
    exact: true,
  });
  await management
    .getByLabel("查找关联工单", { exact: true })
    .fill("old_case_0002");
  await management
    .getByRole("button", { name: "查找工单", exact: true })
    .click();
  await management
    .getByLabel("关联工单", { exact: true })
    .selectOption("old_case_0002");
  assert.equal(
    await management.getByLabel("关联工单", { exact: true }).inputValue(),
    "old_case_0002",
  );

  assert.deepEqual(errors, []);
  console.log(
    "Workbench browser checks passed: role-specific tasks, 235-case history, search, cursors after reload, back/forward, case/order/journal/account links, remembered lists, application reset, audit filters, approver queue, light/mobile layouts.",
  );
} finally {
  await browser?.close();
  await f.close();
}
