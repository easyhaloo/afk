import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SenderFrame = { url: string } | null | undefined;

export function isTrustedRendererUrl(url: string, developmentOrigin = process.env.ELECTRON_RENDERER_URL) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      return !parsed.hostname && fileURLToPath(parsed) === path.join(app.getAppPath(), "dist", "index.html");
    }
    if (!developmentOrigin) return false;
    const development = new URL(developmentOrigin);
    return ["http:", "https:"].includes(parsed.protocol) && ["http:", "https:"].includes(development.protocol)
      && parsed.origin === development.origin;
  } catch {
    return false;
  }
}

export function assertTrustedSender(event: { senderFrame?: SenderFrame }) {
  if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) {
    throw new Error("拒绝来自非 AFK Control renderer 的 IPC 请求");
  }
}
