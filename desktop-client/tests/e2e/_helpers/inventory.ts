import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { IPC_CHANNELS } from "../../../shared/ipc-contract";
import { parseWorkItemInventoryResult } from "../../../shared/backlog-contract";
import { FIXTURE_DIR } from "./launch";

export async function seedSelectionInventory(electronApp: ElectronApplication, page: Page) {
  const envelope = JSON.parse(execFileSync(process.execPath, [path.join(FIXTURE_DIR, "fake-afk.mjs"), "backlog", "inventory", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH } }));
  if (!envelope.ok) throw new Error("Selection inventory fixture failed");
  const inventory = parseWorkItemInventoryResult(envelope.data);
  await electronApp.evaluate(({ ipcMain }, input) => {
    ipcMain.removeHandler(input.channel);
    ipcMain.handle(input.channel, () => input.inventory);
  }, { channel: IPC_CHANNELS.workItemsList, inventory });
  await page.getByRole("button", { name: "刷新工作项" }).click();
}
