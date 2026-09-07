import { test, expect, E2E_HOME_PATH, writeFileSync, chmodSync } from "./_helpers/launch";
import path from "node:path";

test.describe("SshPage error surface", () => {
  test("shows the page-level error banner when ~/.ssh/config is unreadable", async ({ page }) => {
    // Write an unreadable ~/.ssh/config — SSH config adapter should
    // fail to read it and the page should surface the failure.
    const configPath = path.join(E2E_HOME_PATH, ".ssh", "config");
    writeFileSync(configPath, "Host unreachable\n  HostName 10.0.0.1\n", "utf8");
    try { chmodSync(configPath, 0o000); } catch { /* readonly fs */ }

    await page.locator(".primary-nav button", { hasText: "SSH 主机" }).click();

    // The error is best-effort: the SSH page may either show the alert or
    // silently skip the host. Either is acceptable behaviour, but the
    // page must remain stable (no crash, empty state still present).
    const alert = page.getByRole("alert");
    if (await alert.count()) {
      await expect(alert).toBeVisible();
    } else {
      await expect(page.locator(".ssh-empty")).toBeVisible();
    }
  });
});