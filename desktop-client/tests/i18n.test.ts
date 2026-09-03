import { describe, expect, it } from "vitest";
import { catalogs, resolveLocale, translate } from "../src/i18n";

describe("desktop internationalization", () => {
  it("resolves system and explicit locale preferences", () => {
    expect(resolveLocale("system", "zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLocale("system", "en-GB")).toBe("en-US");
    expect(resolveLocale("en-US", "zh-CN")).toBe("en-US");
    expect(resolveLocale("system", "fr-FR")).toBe("en-US");
  });

  it("keeps the English catalog structurally complete", () => {
    expect(Object.keys(catalogs["en-US"]).sort()).toEqual(Object.keys(catalogs["zh-CN"]).sort());
  });

  it("interpolates variables without translating runtime evidence", () => {
    expect(translate("en-US", "records.count", { count: 3 })).toBe("3 records");
    expect(translate("en-US", "terminal.readFailed", { error: "tmux: no server" })).toBe("Unable to read session: tmux: no server");
  });
});
