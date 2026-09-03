import { describe, expect, it } from "vitest";
import { assertAllowedSshPath, validateSshHostInput } from "../../electron/security/ssh-validation";

describe("SSH input validation", () => {
  it("accepts a normal host and applies the default port", () => {
    expect(validateSshHostInput({ alias: "build-box", hostname: "build.example.test", user: "deploy" })).toEqual({
      alias: "build-box",
      hostname: "build.example.test",
      port: 22,
      user: "deploy",
    });
  });

  it("rejects unsafe aliases and ports", () => {
    expect(() => validateSshHostInput({ alias: "build box", hostname: "example.test" })).toThrow("SSH 主机别名无效");
    expect(() => validateSshHostInput({ alias: "build-box", hostname: "example.test", port: 0 })).toThrow("SSH 端口无效");
    expect(() => validateSshHostInput({ alias: "build-box", hostname: "example\0.test" })).toThrow("SSH 主机地址无效");
  });

  it("only permits identity files inside the SSH directory", () => {
    expect(assertAllowedSshPath("~/.ssh/id_ed25519_afk", "/Users/tester")).toBe("/Users/tester/.ssh/id_ed25519_afk");
    expect(() => assertAllowedSshPath("/tmp/private-key", "/Users/tester")).toThrow("SSH 密钥路径必须位于用户 SSH 目录");
  });
});
