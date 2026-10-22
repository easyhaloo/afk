export type ExternalUrlServiceDeps = {
  openExternal: (url: string) => Promise<void>;
};

export function createExternalUrlService(deps: ExternalUrlServiceDeps) {
  return {
    async open(url: string): Promise<boolean> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("外部地址无效");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("只允许打开 http 或 https 地址");
      }
      await deps.openExternal(parsed.toString());
      return true;
    },
  };
}
