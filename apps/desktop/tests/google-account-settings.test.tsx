import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAccountSettings } from "../src/features/settings/GoogleAccountSettings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

async function render() {
  const google = { status: vi.fn().mockResolvedValue({ connected: false }), login: vi.fn().mockResolvedValue({ connected: true, email: "me@example.com" }), cancel: vi.fn().mockResolvedValue(undefined), logout: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal("window", { afkDesktop: { plugins: { google } } });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(GoogleAccountSettings)); });
  return { google, renderer };
}

describe("Google account settings", () => {
  it("shows automatically detected account identity after browser login and confirms logout", async () => {
    const { google, renderer } = await render();
    google.status.mockResolvedValue({ connected: true, email: "me@example.com" });
    await act(async () => { renderer.root.findAllByType("button").find(button => button.children.includes("登录 Google"))!.props.onClick(); });
    expect(google.login).toHaveBeenCalledWith();
    expect(JSON.stringify(renderer.toJSON())).toContain("me@example.com");
    act(() => renderer.root.findByProps({ "aria-label": "断开 Google 账号" }).props.onClick());
    expect(google.logout).not.toHaveBeenCalled();
    google.status.mockResolvedValue({ connected: false });
    await act(async () => { renderer.root.findByProps({ "aria-label": "确认断开 Google 账号" }).props.onClick(); });
    expect(google.logout).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer.toJSON())).toContain("未连接 Google 账号");
    act(() => renderer.unmount());
  });

  it("keeps cancellation available during login and restores controls when cleanup finishes", async () => {
    const { google, renderer } = await render();
    let finish!: (result: null) => void;
    google.login.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => renderer.root.findAllByType("button").find(button => button.children.includes("登录 Google"))!.props.onClick());
    expect(renderer.root.findByProps({ "aria-label": "刷新 Google 账号" }).props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("在浏览器中完成授权");
    google.cancel.mockImplementationOnce(async () => { finish(null); });
    await act(async () => { renderer.root.findByProps({ "aria-label": "取消 Google 登录" }).props.onClick(); });
    expect(google.cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer.toJSON())).toContain("回调监听已关闭");
    expect(renderer.root.findByProps({ "aria-label": "刷新 Google 账号" }).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it("cancels when unmounted and does not update a departed settings view", async () => {
    const { google, renderer } = await render();
    let finish!: (result: null) => void;
    google.login.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => renderer.root.findAllByType("button").find(button => button.children.includes("登录 Google"))!.props.onClick());
    act(() => renderer.unmount());
    expect(google.cancel).toHaveBeenCalledOnce();
    await act(async () => { finish(null); });
    expect(google.status).toHaveBeenCalledOnce();
  });

  it("shows meaningful login failure and allows retry", async () => {
    const { google, renderer } = await render();
    google.login.mockRejectedValueOnce(new Error("缺少邮件发送权限，请重新授权"));
    await act(async () => { renderer.root.findAllByType("button").find(button => button.children.includes("登录 Google"))!.props.onClick(); });
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("邮件发送权限");
    await act(async () => { renderer.root.findAllByType("button").find(button => button.children.includes("登录 Google"))!.props.onClick(); });
    expect(google.login).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it("keeps a stored account connected when the access-token expiry is in the past", async () => {
    const { google, renderer } = await render();
    google.status.mockResolvedValueOnce({ connected: true, email: "me@example.com", expiresAt: "2000-01-01T00:00:00Z" });
    await act(async () => { renderer.root.findByProps({ "aria-label": "刷新 Google 账号" }).props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("已连接：me@example.com");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("未连接 Google 账号");
    expect(renderer.root.findByProps({ "aria-label": "断开 Google 账号" }).props.disabled).toBe(false);
    expect(google.login).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("refreshes connected state after configuration failure without discarding the actionable error", async () => {
    const { google, renderer } = await render();
    google.login.mockRejectedValueOnce(new Error("Google 账号已连接但配置失败，请检查插件配置"));
    google.status.mockResolvedValueOnce({ connected: true, email: "me@example.com" });
    await act(async () => { renderer.root.findAllByType("button").find(button => button.children.includes("登录 Google"))!.props.onClick(); });
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("已连接但配置失败");
    expect(JSON.stringify(renderer.toJSON())).toContain("已连接：me@example.com");
    expect(google.logout).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
