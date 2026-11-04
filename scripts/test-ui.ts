import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fixture } from "../tests/helpers.js";
import { executeOperation } from "../packages/core/src/operations.js";
import { syncSources, runJob } from "../packages/core/src/worker.js";
import { ROOT } from "../packages/core/src/config.js";
const f = await fixture(60),
  out = path.join(ROOT, ".local/ui-tests");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const executablePath =
  process.env.CHROMIUM_PATH ||
  "/Users/dj/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
if (!fs.existsSync(executablePath))
  throw new Error("Set CHROMIUM_PATH to a local Chromium executable");
const browser = await chromium.launch({ executablePath, headless: true }),
  base = await f.api.listen({ host: "127.0.0.1", port: 0 }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage(),
  pageErrors: string[] = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
let stopped = false;
const loop = (async () => {
  while (!stopped) {
    await executeOperation(f.db, f.cfg);
    await syncSources(f.db, f.cfg);
    await runJob(f.db, f.cfg, ["reconcile", "import", "export"]);
    await new Promise((r) => setTimeout(r, 100));
  }
})();
async function login(p: typeof page, name: string) {
  await p.goto(base);
  await p.getByLabel("账号邮箱").fill(name + "@test.local");
  await p.getByLabel("密码", { exact: true }).fill("Test-only-password-042!");
  await p.getByRole("button", { name: "登录工作台" }).click();
  await p.getByRole("heading", { name: "工作概览", exact: true }).waitFor();
}
async function nav(label: string) {
  await page.getByRole("link", { name: label, exact: true }).click();
  await page.getByRole("heading", { name: label, exact: true }).waitFor();
}
try {
  await page.goto(base);
  await page.screenshot({
    path: path.join(out, "login-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await login(page, "requester");
  await page.getByText("已实际结算 · CREDIT").waitFor();
  await page.getByRole("img", { name: "订单状态环形图，共 60 笔" }).waitFor();
  const distribution = page.getByRole("group", { name: "订单分布统计方式" });
  await distribution
    .getByRole("button", { name: "按积分", exact: true })
    .click();
  await page.getByRole("img", { name: /订单状态环形图，共 .* 积分/ }).waitFor();
  const legend = page.getByLabel("订单分布图例").getByRole("button").first();
  await legend.click();
  assert.equal(await legend.getAttribute("aria-pressed"), "true");
  await legend.press("Enter");
  assert.equal(await legend.getAttribute("aria-pressed"), "false");
  await distribution
    .getByRole("button", { name: "按笔数", exact: true })
    .click();
  const trend = page.getByRole("group", { name: "交易趋势指标" });
  await trend.getByRole("button", { name: "笔数", exact: true }).click();
  const plot = page.getByRole("img", {
    name: "交易趋势笔数图，左右方向键查看日期",
  });
  await plot.focus();
  await plot.press("Home");
  await page.getByText("查看趋势数据", { exact: false }).click();
  assert.equal(
    await page.locator(".analytics-data-table tbody tr").count(),
    30,
  );
  await page.getByText("查看趋势数据", { exact: false }).click();
  await trend.getByRole("button", { name: "积分", exact: true }).click();
  const sevenResponse = page.waitForResponse(
    (r) =>
      r.url().includes("/admin/overview?") &&
      r.url().includes("from=") &&
      !r
        .url()
        .includes(
          "from=" +
            new Date(Date.now() + 8 * 3600000 - 29 * 86400000)
              .toISOString()
              .slice(0, 10),
        ),
  );
  await page
    .getByRole("group", { name: "统计时间范围" })
    .getByRole("button", { name: "近 7 天", exact: true })
    .click();
  const seven = await (await sevenResponse).json();
  assert.equal(seven.range.days, 7);
  assert.ok(BigInt(seven.orders.count) < 60n);
  await page.getByRole("img", { name: /订单状态环形图/ }).waitFor();
  await page.getByLabel("概览开始日期").fill("2040-02-07");
  await page.getByLabel("概览结束日期").fill("2040-02-01");
  await page.getByRole("button", { name: "应用日期筛选" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "开始日期不能晚于结束日期" })
    .waitFor();
  await page.getByLabel("概览开始日期").fill("2040-02-01");
  await page.getByLabel("概览结束日期").fill("2040-02-07");
  await page.getByRole("button", { name: "应用日期筛选" }).click();
  await page.getByRole("img", { name: "订单状态环形图，共 0 笔" }).waitFor();
  await page.getByText("所选时段暂无成交或退款", { exact: true }).waitFor();
  await page
    .getByRole("group", { name: "统计时间范围" })
    .getByRole("button", { name: "全部", exact: true })
    .click();
  await page.getByRole("img", { name: "订单状态环形图，共 60 笔" }).waitFor();
  await page
    .getByRole("group", { name: "统计时间范围" })
    .getByRole("button", { name: "近 30 天", exact: true })
    .click();
  await page.getByText("已实际结算 · CREDIT").waitFor();
  await page.screenshot({
    path: path.join(out, "overview-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await nav("全部订单");
  await page.getByLabel("跳转页码").fill("2");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await page.getByText("第 2 页 · 共 3 页").waitFor();
  await page.getByLabel("编号搜索").fill("trade_00005");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page.getByRole("button", { name: "trade_00005", exact: true }).click();
  await page
    .getByRole("button", { name: "申请退回托管积分", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "申请全额退回托管积分" })
    .getByLabel("处理理由")
    .fill("浏览器端到端测试未交付托管退款");
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await page
    .getByRole("dialog", { name: "申请全额退回托管积分" })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("dialog", { name: "订单详情" })
    .getByRole("button", { name: "关闭弹窗" })
    .click();
  await nav("异常与审批");
  await page.getByText("待审批", { exact: true }).waitFor();
  const approverContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    approver = await approverContext.newPage();
  approver.on("pageerror", (e) => pageErrors.push(e.message));
  await login(approver, "approver");
  await approver.getByRole("link", { name: "异常与审批", exact: true }).click();
  await approver.getByRole("button", { name: "审批通过", exact: true }).click();
  const dialog = approver.getByRole("dialog", { name: "批准退回托管积分" });
  await dialog.getByLabel("处理理由").fill("已核验退款用户金额及来源版本");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await approver
    .getByText(/来源已执行，查询数据已同步/)
    .waitFor({ timeout: 15000 });
  await approverContext.close();
  await page
    .getByText(/来源已执行，查询数据已同步/)
    .waitFor({ timeout: 15000 });
  await page.screenshot({
    path: path.join(out, "approval-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("link", { name: "异常工单", exact: true }).click();
  await page.getByRole("button", { name: "新建工单" }).click();
  await page.getByLabel("工单标题").fill("浏览器测试退款情况跟进");
  await page.getByLabel("处理理由").fill("检查退款已执行且同步完毕");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("button", { name: "领取任务" }).click();
  await page.getByLabel("处理理由").fill("本人领取并核实关联流水");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("button", { name: "关闭工单", exact: true }).waitFor();
  await nav("全部订单");
  await page.getByLabel("编号搜索").fill("trade_00005");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page.getByText("第 1 页 · 共 1 页").waitFor();
  await page.getByRole("button", { name: "导出记录" }).click();
  await page.getByRole("button", { name: "创建导出任务" }).click();
  await page
    .getByRole("link", { name: /trades-001.xlsx/ })
    .waitFor({ timeout: 15000 });
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: /trades-001.xlsx/ }).click();
  const download = await downloadEvent;
  await download.saveAs(path.join(out, "trade.xlsx"));
  assert.equal(await download.failure(), null);
  assert.ok(fs.statSync(path.join(out, "trade.xlsx")).size > 1000);
  await nav("对账中心");
  await page.getByRole("button", { name: "发起对账" }).click();
  await page.getByText("对账通过", { exact: true }).waitFor({ timeout: 15000 });
  await nav("全部流水");
  await page.locator("details.journal").first().locator("summary").click();
  assert.ok((await page.getByText(/分录合计：0 CREDIT/).count()) > 0);
  await nav("工作概览");
  await page.getByRole("img", { name: "订单状态环形图，共 60 笔" }).waitFor();
  assert.equal(
    await page
      .getByLabel("订单分布图例")
      .getByRole("button")
      .filter({ hasText: "已退款" })
      .locator("strong")
      .innerText(),
    "9",
  );
  await page.getByRole("button", { name: "切换浅色模式" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.screenshot({
    path: path.join(out, "overview-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(out, "overview-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "mobile page must not overflow horizontally",
  );
  await nav("全部订单");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "mobile table overflow stays in table container",
  );
  await page.screenshot({
    path: path.join(out, "orders-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(pageErrors, []);
  console.log(
    "Browser checks passed: analytics donuts, metric/date switches, keyboard trend, zero-data state, refreshed distributions, login, pagination, two-person refund, claim case, automatic refresh, native XLSX download, reconciliation, journals, light/dark/mobile. Screenshots: .local/ui-tests",
  );
} finally {
  stopped = true;
  await loop;
  await browser.close();
  await f.close();
}
