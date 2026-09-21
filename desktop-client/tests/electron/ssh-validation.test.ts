import { describe, expect, it } from "vitest";
import { assertAllowedSshPath, validateSshHostInput, validateSshUploadLocalPath, validateSshUploadRemoteDirectory, validateJumpserverBastionInput, validateJumpserverSyncOptions, validateJumpserverBastionId } from "../../electron/security/ssh-validation";

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

describe("JumpServer validation", () => {
  it("accepts valid full input and returns normalized object", () => {
    expect(validateJumpserverBastionInput({
      alias: "fangcloud-jumpserver",
      hostname: "jumpserver.example.test",
      port: 2222,
      user: "admin",
      otpSecret: "JBSWY3DPEHPK3PXP",
    })).toEqual({
      alias: "fangcloud-jumpserver",
      hostname: "jumpserver.example.test",
      port: 2222,
      user: "admin",
      otpSecret: "JBSWY3DPEHPK3PXP",
    });
  });

  it("applies default port 2222 when missing", () => {
    expect(validateJumpserverBastionInput({
      alias: "fangcloud-jumpserver",
      hostname: "jumpserver.example.test",
      user: "admin",
    })).toMatchObject({ port: 2222 });
  });

  it("coerces string port to number", () => {
    expect(validateJumpserverBastionInput({
      alias: "fangcloud-jumpserver",
      hostname: "jumpserver.example.test",
      port: "3333",
      user: "admin",
    })).toMatchObject({ port: 3333 });
  });

  it("throws on invalid port values", () => {
    expect(() => validateJumpserverBastionInput({ alias: "js", hostname: "js.test", port: 0, user: "u" })).toThrow("JumpServer 堡垒机端口无效");
    expect(() => validateJumpserverBastionInput({ alias: "js", hostname: "js.test", port: 65536, user: "u" })).toThrow("JumpServer 堡垒机端口无效");
    expect(() => validateJumpserverBastionInput({ alias: "js", hostname: "js.test", port: NaN, user: "u" })).toThrow("JumpServer 堡垒机端口无效");
  });

  it("throws when required fields are missing", () => {
    expect(() => validateJumpserverBastionInput({ hostname: "js.test", user: "u" })).toThrow("JumpServer 堡垒机别名无效");
    expect(() => validateJumpserverBastionInput({ alias: "js", user: "u" })).toThrow("JumpServer 堡垒机地址无效");
    expect(() => validateJumpserverBastionInput({ alias: "js", hostname: "js.test" })).toThrow("JumpServer 堡垒机用户无效");
  });

  it("throws on invalid alias with slash", () => {
    expect(() => validateJumpserverBastionInput({ alias: "js/prod", hostname: "js.test", user: "u" })).toThrow("JumpServer 堡垒机别名无效");
  });

  it("throws on invalid hostname with whitespace", () => {
    expect(() => validateJumpserverBastionInput({ alias: "js", hostname: "js test", user: "u" })).toThrow("JumpServer 堡垒机地址无效");
  });

  it("otpSecret is optional and validates type", () => {
    expect(validateJumpserverBastionInput({ alias: "js", hostname: "js.test", user: "u" }).otpSecret).toBeUndefined();
    expect(() => validateJumpserverBastionInput({ alias: "js", hostname: "js.test", user: "u", otpSecret: 12345 })).toThrow("JumpServer 堡垒机 OTP 密钥无效");
  });

  it("returns empty object for undefined or non-object sync options", () => {
    expect(validateJumpserverSyncOptions(undefined)).toEqual({});
    expect(validateJumpserverSyncOptions(null)).toEqual({});
    expect(validateJumpserverSyncOptions("string")).toEqual({});
  });

  it("throws on invalid selectedNames in sync options", () => {
    expect(() => validateJumpserverSyncOptions({ selectedNames: "all" })).toThrow("JumpServer 同步选项 selectedNames 无效");
    expect(() => validateJumpserverSyncOptions({ selectedNames: ["a", 2] })).toThrow("JumpServer 同步选项 selectedNames 无效");
  });

  it("throws on invalid linuxOnly in sync options", () => {
    expect(() => validateJumpserverSyncOptions({ linuxOnly: "true" })).toThrow("JumpServer 同步选项 linuxOnly 无效");
  });

  it("validateJumpserverBastionId throws on invalid input", () => {
    expect(() => validateJumpserverBastionId("")).toThrow("JumpServer 堡垒机 ID 无效");
    expect(() => validateJumpserverBastionId(123)).toThrow("JumpServer 堡垒机 ID 无效");
    expect(() => validateJumpserverBastionId(null)).toThrow("JumpServer 堡垒机 ID 无效");
  });

  it("validateJumpserverBastionId returns string id as-is", () => {
    expect(validateJumpserverBastionId("managed:abc123")).toBe("managed:abc123");
  });
});
