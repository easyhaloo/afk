import { test, expect } from "./_helpers/launch.js";

test("shows an expired connected account and cancels simulated Google consent through real IPC", async ({ page, electronApp }) => {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ["/simulated/google-client.json"] });
  });
  await page.locator(".sidebar-bottom .settings-entry").click();
  const account = page.getByRole("region", { name: "Google 账号", exact: true });
  await expect(account).toContainText("已连接：fixture@example.test");
  await expect(account.getByRole("button", { name: "断开 Google 账号", exact: true })).toBeEnabled();
  await account.getByRole("button", { name: "重新登录 Google", exact: true }).click();
  await expect(account).toContainText("在浏览器中完成授权");
  await expect(account.getByRole("button", { name: "刷新 Google 账号", exact: true })).toBeDisabled();
  await account.getByRole("button", { name: "取消 Google 登录", exact: true }).click();
  await expect(account).toContainText("已取消 Google 登录");
  await expect(account).toContainText("已连接：fixture@example.test");
  await expect(account.getByRole("button", { name: "刷新 Google 账号", exact: true })).toBeEnabled();
  await expect(account.getByRole("alert")).toHaveCount(0);
  const status = await page.evaluate(() => window.afkDesktop.plugins.google.status());
  expect(status).toEqual({ connected: true, email: "fixture@example.test", expiresAt: "2000-01-01T00:00:00Z" });
});
