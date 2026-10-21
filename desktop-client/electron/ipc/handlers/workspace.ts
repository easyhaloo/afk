import { app, dialog, ipcMain, shell } from "electron";
import { IPC_CHANNELS } from "../../../shared/ipc-contract.js";
import { assertTrustedSender } from "../../security/sender-guard.js";
import { readAppearance, saveAppearance } from "../../services/appearance-service.js";
import { saveWorkspacePreference } from "../../services/workspace-preference-service.js";
import { registerHandler, registerHandlerMulti } from "../handler-registry.js";
import { clipboardService, desktopService, externalUrlService } from "../ipc-services.js";
import { workspaceArgument } from "../ipc-arguments.js";

/**
 * The channels the desktop's shell answers: the clipboard, external links,
 * the workspace picker, and the snapshot the board is drawn from.
 */

export function registerWorkspaceHandlers() {
  registerHandler(IPC_CHANNELS.copyText, (v: unknown) => v, (text) => clipboardService.copyText(text as string));
  registerHandler(IPC_CHANNELS.openExternal, (url: unknown) => {
    if (typeof url !== "string" || !url.trim()) throw new Error("外部地址无效");
    return url;
  }, (url) => externalUrlService.open(url));
  ipcMain.handle(IPC_CHANNELS.chooseWorkspace, async (event) => {
    assertTrustedSender(event);
    const selected = await dialog.showOpenDialog({ title: "选择 AFK 工作区", properties: ["openDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const workspace = await saveWorkspacePreference(app.getPath("userData"), selected.filePaths[0]);
    process.env.AFK_WORKSPACE = workspace;
    return workspace;
  });
  registerHandler(IPC_CHANNELS.snapshot, (v: unknown) => workspaceArgument(v, "snapshot"), (workspace) => desktopService.snapshot(workspace));
  registerHandler(IPC_CHANNELS.appearance, (v: unknown) => v, () => readAppearance());
  registerHandler(IPC_CHANNELS.appearanceSave, (v: unknown) => v, (appearance) => saveAppearance(appearance));
  registerHandlerMulti(IPC_CHANNELS.workflowSave, [
    (v) => workspaceArgument(v, "workflowSave"),
    (v) => v,
  ], ([workspace, workflow]) => desktopService.saveWorkflowConfig(workspace, workflow));
}
