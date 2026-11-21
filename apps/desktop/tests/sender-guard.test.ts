import { describe, expect, it, vi } from "vitest";
import { isTrustedRendererUrl } from "../electron/security/sender-guard.js";
import { installNavigationGuard } from "../electron/security/navigation-guard.js";
import type { WebContents } from "electron";

vi.mock("electron", () => ({ app: { getAppPath: () => "/Applications/AFK Control.app/Contents/Resources/app.asar" } }));

describe("renderer sender guard", () => {
  it("allows packaged file pages and the explicit development origin", () => {
    expect(isTrustedRendererUrl("file:///Applications/AFK%20Control.app/Contents/Resources/app.asar/dist/index.html")).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:5174/", "http://localhost:5174")).toBe(true);
  });

  it("rejects remote and unrelated local origins", () => {
    expect(isTrustedRendererUrl("https://example.com/")).toBe(false);
    expect(isTrustedRendererUrl("http://localhost:5175/", "http://localhost:5174")).toBe(false);
    expect(isTrustedRendererUrl("file:///tmp/untrusted.html")).toBe(false);
  });

  it.each([
    "file:///tmp/attacker/dist/index.html",
    "file://untrusted-host/Applications/AFK%20Control.app/Contents/Resources/app.asar/dist/index.html",
    "file:///Applications/Another.app/Contents/Resources/app.asar/dist/index.html",
  ])("rejects unrelated packaged-looking file %s", url => {
    expect(isTrustedRendererUrl(url)).toBe(false);
  });

  it.each(["file:///tmp/index.html", "data:text/html,hello", "ftp://localhost:5174"])("rejects non-HTTP development origin %s", origin => {
    expect(isTrustedRendererUrl(origin, origin)).toBe(false);
    expect(isTrustedRendererUrl("data:text/html,other", origin)).toBe(false);
  });

  it("uses the same exact file trust rule for navigation and child windows", () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }, url: string) => void>();
    let open!: (input: { url: string }) => { action: string };
    const contents = { on: (name: string, callback: typeof open) => { listeners.set(name, callback as never); },
      setWindowOpenHandler: (callback: typeof open) => { open = callback; }, session: { setPermissionRequestHandler: vi.fn() } };
    installNavigationGuard(contents as unknown as WebContents);
    const preventDefault = vi.fn();
    listeners.get("will-navigate")!({ preventDefault }, "file:///tmp/attacker/dist/index.html");
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(open({ url: "file:///tmp/attacker/dist/index.html" })).toEqual({ action: "deny" });
    expect(open({ url: "file:///Applications/AFK%20Control.app/Contents/Resources/app.asar/dist/index.html" })).toEqual({ action: "allow" });
  });
});
