import { describe, expect, it } from "vitest";
import { isTrustedRendererUrl } from "../electron/security/sender-guard";

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
});
