import type { ElectronApplication, Page } from "@playwright/test";
import { IPC_CHANNELS } from "../../../shared/ipc-contract.js";
import { parseWorkItemInventoryResult } from "../../../shared/backlog-contract.js";
import { INVENTORY } from "../fixtures/provider-inventory.mjs";

export async function seedSelectionInventory(electronApp: ElectronApplication, page: Page, itemCount = INVENTORY.items.length) {
  const source = structuredClone(INVENTORY);
  while (source.items.length < itemCount) {
    const issueNumber = source.items.length + 1;
    const id = `github:acme/api#${issueNumber}`;
    source.items.push({ ...source.items[0], id, issueNumber, title: `Focus fixture ${issueNumber}`, providerRef: id });
  }
  const inventory = parseWorkItemInventoryResult(source);
  await electronApp.evaluate(({ ipcMain }, input) => {
    ipcMain.removeHandler(input.channel);
    ipcMain.handle(input.channel, () => input.inventory);
  }, { channel: IPC_CHANNELS.workItemsList, inventory });
  await page.getByRole("button", { name: "刷新工作项" }).click();
}
