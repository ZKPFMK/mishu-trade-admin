import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fixture } from "../tests/helpers.js";
import { ROOT } from "../packages/core/src/config.js";
import { previewRoles, setupRolePreviews } from "./role-previews.js";

const f = await fixture(),
  out = path.join(ROOT, ".local/ui-tests");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const baseUrl = await f.api.listen({ host: "127.0.0.1", port: 0 });
  const credentials = await setupRolePreviews({
    baseUrl,
    applicationId: f.app,
    admin: {
      email: "requester@test.local",
      password: "Test-only-password-042!",
    },
    outputFile: path.join(f.cfg.dataDir, "role-previews.json"),
  });
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const errors: string[] = [];
  for (const [role, label] of previewRoles) {
    const account = credentials.operators.find((p) => p.roles[0] === role)!;
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(baseUrl);
    await page.getByLabel("账号邮箱").fill(account.email);
    await page.getByLabel("密码", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "登录工作台", exact: true }).click();
    const identity = page.getByRole("region", {
      name: "当前登录身份",
      exact: true,
    });
    await identity.getByText(account.email, { exact: true }).waitFor();
    const roles = identity.getByLabel("我的岗位");
    assert.equal(await roles.locator(".badge").count(), 1);
    await roles.getByText(label, { exact: true }).waitFor();
    await page
      .getByRole("heading", { name: "运营待办", exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator("nav")
        .getByRole("link", { name: "操作员", exact: true })
        .count(),
      role === "admin" ? 1 : 0,
    );
    assert.equal(
      await page
        .locator("nav")
        .getByRole("link", { name: "操作审计", exact: true })
        .count(),
      ["admin", "auditor"].includes(role) ? 1 : 0,
    );
    assert.equal(
      await page.getByRole("link", { name: /待我审批/ }).count(),
      role === "approver" ? 1 : 0,
    );
    assert.equal(
      await page.getByRole("link", { name: /我的开放工单/ }).count(),
      role === "operator" ? 1 : 0,
    );
    await page.screenshot({
      path: path.join(out, `role-${role}.png`),
      animations: "disabled",
    });
    await page
      .locator("nav")
      .getByRole("link", { name: "异常与审批", exact: true })
      .click();
    await page.getByRole("link", { name: "异常工单", exact: true }).click();
    await page
      .getByRole("heading", { name: "异常工单", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "新建工单", exact: true }).count(),
      role === "operator" ? 1 : 0,
    );
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page
      .getByRole("button", { name: "登录工作台", exact: true })
      .waitFor();
    assert.equal(await page.getByLabel("账号邮箱").inputValue(), "");
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    "Five-role browser checks passed: isolated login/logout, single-role identity, scoped menus, personal tasks and operator-only case action. Screenshots: .local/ui-tests/role-*.png",
  );
} finally {
  await browser?.close();
  await f.close();
}
