import { describe, expect, it } from "vitest";
import { assertAllowedSshPath, validateSshHostInput, validateSshUploadLocalPath, validateSshUploadRemoteDirectory } from "../../electron/security/ssh-validation";

describe("SSH input validation", () => {
  it("accepts a normal host and applies the default port", () => {
    expect(validateSshHostInput({ alias: "build-box", hostname: "build.example.test", user: "deploy" })).toEqual({
      alias: "build-box",
      hostname: "build.example.test",
      port: 22,
      user: "deploy",
    });
  });

  it("accepts ordinary AFK display text", () => {
    expect(validateSshHostInput({ alias: " kg 演示 / 生产 ", hostname: "172.16.0.241" })).toMatchObject({ alias: "kg 演示 / 生产", hostname: "172.16.0.241" });
  });

  it("accepts a JumpServer host selection and requires its alias", () => {
    expect(validateSshHostInput({
      alias: "private-app",
      hostname: "172.16.0.241",
      jumpHostType: "jumpserver",
      jumpHost: "fangcloud-jumpserver",
    })).toMatchObject({ jumpHostType: "jumpserver", jumpHost: "fangcloud-jumpserver" });
    expect(() => validateSshHostInput({ alias: "private-app", hostname: "172.16.0.241", jumpHostType: "jumpserver" })).toThrow("跳板机别名不能为空");
  });

  it("rejects unsupported jump host types and unsafe aliases", () => {
    expect(() => validateSshHostInput({ alias: "private-app", hostname: "172.16.0.241", jumpHostType: "vpn" })).toThrow("跳板机类型无效");
    expect(() => validateSshHostInput({ alias: "private-app", hostname: "172.16.0.241", jumpHostType: "jumpserver", jumpHost: "jump host" })).toThrow("跳板机别名无效");
    expect(() => validateSshHostInput({ alias: "private-app", hostname: "172.16.0.241", jumpHostType: "openssh", jumpHost: "中文跳板机" })).toThrow("跳板机别名无效");
  });

  it("rejects invalid display names and ports", () => {
    expect(() => validateSshHostInput({ alias: " ", hostname: "example.test" })).toThrow("SSH 主机别名无效");
    expect(() => validateSshHostInput({ alias: "build\0box", hostname: "example.test" })).toThrow("SSH 主机别名无效");
    expect(() => validateSshHostInput({ alias: "主".repeat(101), hostname: "example.test" })).toThrow("SSH 主机名称过长");
    expect(() => validateSshHostInput({ alias: "build-box", hostname: "example.test", port: 0 })).toThrow("SSH 端口无效");
    expect(() => validateSshHostInput({ alias: "build-box", hostname: "example\0.test" })).toThrow("SSH 主机地址无效");
  });

  it("only permits identity files inside the SSH directory", () => {
    expect(assertAllowedSshPath("~/.ssh/id_ed25519_afk", "/Users/tester")).toBe("/Users/tester/.ssh/id_ed25519_afk");
    expect(() => assertAllowedSshPath("/tmp/private-key", "/Users/tester")).toThrow("SSH 密钥路径必须位于用户 SSH 目录");
  });

  it("validates upload paths without allowing control characters", () => {
    expect(validateSshUploadLocalPath(" /tmp/release notes.txt ")).toBe("/tmp/release notes.txt");
    expect(validateSshUploadRemoteDirectory("/srv/releases")).toBe("/srv/releases/");
    expect(() => validateSshUploadLocalPath("/tmp/file\nname")).toThrow("SSH 上传文件路径无效");
    expect(() => validateSshUploadRemoteDirectory("~/uploads\r")).toThrow("SSH 远程目录无效");
  });
});
