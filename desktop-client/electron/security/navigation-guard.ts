import type { WebContents } from "electron";
import { isTrustedRendererUrl } from "./sender-guard";

export function installNavigationGuard(contents: WebContents) {
  contents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => ({ action: isTrustedRendererUrl(url) ? "allow" : "deny" }));
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}
