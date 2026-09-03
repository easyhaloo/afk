type SenderFrame = { url: string } | null | undefined;

export function isTrustedRendererUrl(url: string, developmentOrigin = process.env.ELECTRON_RENDERER_URL) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return parsed.pathname.endsWith("/dist/index.html");
    if (!developmentOrigin) return false;
    return parsed.origin === new URL(developmentOrigin).origin;
  } catch {
    return false;
  }
}

export function assertTrustedSender(event: { senderFrame?: SenderFrame }) {
  if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) {
    throw new Error("拒绝来自非 AFK Control renderer 的 IPC 请求");
  }
}
