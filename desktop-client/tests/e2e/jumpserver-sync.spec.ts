import { test, expect } from "./_helpers/launch";

test.describe("JumpServer bastion auto-sync", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to SSH Hosts page
    await page.locator(".primary-nav button", { hasText: "SSH 主机" }).click();
    await expect(page.locator(".ssh-page")).toBeVisible();
  });

  test("full flow: add bastion → preview → sync → remove", async ({ page }) => {
    // --- Open the Add Bastion dialog ---
    await page.getByRole("button", { name: "添加堡垒机" }).click();
    const dialog = page.locator(".ssh-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("h2")).toContainText("添加堡垒机");

    // --- Fill the bastion form ---
    // The dialog opens in "bastion" mode by default (initialMode="bastion")
    // Fill alias, host, port, user, password fields (OTP optional)
    await dialog.locator("input").nth(0).fill("e2e-test");          // alias
    await dialog.locator("input").nth(1).fill("https://dev-jumpserver.local"); // host
    await dialog.locator("input").nth(2).fill("2222");              // port
    await dialog.locator("input").nth(3).fill("wangwendi");         // user
    await dialog.locator("input").nth(4).fill("e2e-password");       // password

    // --- Click "Test Connection & Preview Assets" ---
    const testButton = dialog.getByRole("button", { name: /Test Connection & Preview Assets/i });
    await expect(testButton).toBeEnabled();
    await testButton.click();

    // --- Wait for preview to appear ---
    const preview = dialog.locator(".ssh-bastion-preview");
    await expect(preview).toBeVisible({ timeout: 10_000 });
    await expect(preview.locator(".ssh-bastion-preview-header b")).toContainText("Login OK");

    // --- Assert preview shows 3 Linux assets (Windows filtered by linuxOnly=true) ---
    const rows = preview.locator(".ssh-bastion-preview-row");
    await expect(rows).toHaveCount(3);

    const linuxRows = rows.filter({ has: page.locator(".platform.linux") });
    await expect(linuxRows).toHaveCount(3);

    // --- All 3 Linux assets are pre-selected ---
    const checkedRows = rows.filter({ has: page.locator("input[type=checkbox]:checked") });
    await expect(checkedRows).toHaveCount(3);

    // --- Click "Sync ✓" ---
    const syncButton = dialog.getByRole("button", { name: /Sync ✓/i });
    await expect(syncButton).toBeEnabled();
    await syncButton.click();

    // --- Wait for success banner inside dialog ---
    const successAlert = dialog.locator(".ssh-alert.success");
    await expect(successAlert).toBeVisible({ timeout: 15_000 });
    await expect(successAlert).toContainText("Imported");

    // --- Close the dialog ---
    await dialog.locator('button[aria-label="关闭"]').click();
    await expect(dialog).not.toBeVisible();

    // --- Assert bastion group appears in the main list ---
    const bastionCard = page.locator(".ssh-bastion-group");
    await expect(bastionCard).toBeVisible({ timeout: 10_000 });
    await expect(bastionCard.locator(".ssh-bastion-copy b")).toContainText("e2e-test");

    // --- Expand the bastion to see synced assets ---
    await bastionCard.locator(".ssh-bastion-chevron-btn").click();
    const assetRows = page.locator(".ssh-host-row");
    await expect(assetRows).toHaveCount(3); // 3 Linux assets synced

    // --- Click the bastion header to open the detail panel ---
    await bastionCard.click();

    // --- Assert JumpserverDetail panel appears ---
    const detailPanel = page.locator("aside[aria-label*='堡垒机详情']");
    await expect(detailPanel).toBeVisible();
    await expect(detailPanel).toContainText("刷新资产");
    await expect(detailPanel).toContainText("删除堡垒机");

    // --- Check sync stats are displayed ---
    const syncStats = detailPanel.locator(".ssh-detail-sync-stats");
    await expect(syncStats).toBeVisible();
    await expect(syncStats).toContainText("资产");
    await expect(syncStats).toContainText("Linux");

    // --- Click "Remove Bastion" ---
    const removeButton = detailPanel.getByRole("button", { name: /删除堡垒机/i });
    await removeButton.click();

    // --- Confirm removal in the dialog ---
    const confirmDialog = page.locator(".ssh-confirm-dialog, [role='dialog']");
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: /确认删除/i }).click();

    // --- Assert bastion group is gone ---
    await expect(page.locator(".ssh-bastion-group")).not.toBeVisible();
  });
});
