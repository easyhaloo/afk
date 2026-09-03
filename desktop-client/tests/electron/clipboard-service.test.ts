import { describe, expect, it } from "vitest";
import { createClipboardService } from "../../electron/services/clipboard-service";

function setup() {
  const writes: string[] = [];
  const service = createClipboardService({ writeText: (text) => { writes.push(text); } });
  return { service, writes };
}

describe("clipboard service", () => {
  it("writes ordinary plain text", () => {
    const { service, writes } = setup();
    expect(service.copyText("hello\n世界")).toBe(true);
    expect(writes).toEqual(["hello\n世界"]);
  });

  it("accepts exactly 65536 ASCII bytes", () => {
    const { service, writes } = setup();
    const text = "a".repeat(65_536);
    expect(service.copyText(text)).toBe(true);
    expect(writes).toEqual([text]);
  });

  it("rejects 65537 ASCII bytes without calling the writer", () => {
    const { service, writes } = setup();
    expect(() => service.copyText("a".repeat(65_537))).toThrow();
    expect(writes).toEqual([]);
  });

  it("measures multibyte Unicode using UTF-8 bytes", () => {
    const { service, writes } = setup();
    const withinLimit = "你".repeat(21_845);
    expect(service.copyText(withinLimit)).toBe(true);
    expect(() => service.copyText(`${withinLimit}你`)).toThrow();
    expect(writes).toEqual([withinLimit]);
  });

  it("rejects non-string input without calling the writer", () => {
    const { service, writes } = setup();
    expect(() => service.copyText(123)).toThrow();
    expect(writes).toEqual([]);
  });
});
