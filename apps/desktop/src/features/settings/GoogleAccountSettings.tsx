import { useEffect, useRef, useState } from "react";
import { LogOut, RefreshCw, X } from "lucide-react";
import type { GoogleAccountStatus } from "../../../shared/plugin-contract.js";
import { SshConfirmDialog } from "../ssh/SshConfirmDialog.js";

export function GoogleAccountSettings({ onConnected }: { onConnected?: () => void } = {}) {
  const [account, setAccount] = useState<GoogleAccountStatus>();
  const [busy, setBusy] = useState<"status" | "login" | "logout">();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const mounted = useRef(false);
  const operation = useRef<string | undefined>(undefined);

  async function run(action: "status" | "login" | "logout") {
    if (operation.current) return;
    operation.current = action;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      if (action === "login") {
        const result = await window.afkDesktop.plugins.google.login();
        if (!mounted.current) return;
        if (result) { setAccount(result); onConnected?.(); }
        setMessage(result ? "Google 账号已自动识别并连接。" : "已取消 Google 登录，回调监听已关闭。");
      }
      if (action === "logout") await window.afkDesktop.plugins.google.logout();
      const result = await window.afkDesktop.plugins.google.status();
      if (mounted.current) setAccount(result);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : "Google 账号操作失败，请重试。");
      if (action === "login") {
        try {
          const result = await window.afkDesktop.plugins.google.status();
          if (mounted.current) setAccount(result);
        } catch {}
      }
    } finally {
      operation.current = undefined;
      if (mounted.current) setBusy(undefined);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void run("status");
    return () => {
      mounted.current = false;
      if (operation.current === "login") void window.afkDesktop.plugins.google.cancel().catch(() => undefined);
    };
  }, []);

  return <section className="plugin-account" aria-label="Google 账号" aria-busy={!!busy}>
    <div className="plugin-description"><b>Google 账号</b><small>{busy === "login" ? "在浏览器中完成授权，账号由 Google 自动识别，完成后自动返回。" : account?.connected ? `已连接：${account.email}` : "未连接 Google 账号"}</small></div>
    <div className="plugin-actions">
      <button type="button" aria-label="刷新 Google 账号" title="刷新 Google 账号" disabled={!!busy} onClick={() => void run("status")}><RefreshCw size={16} /></button>
      <button type="button" disabled={!!busy} onClick={() => void run("login")}>{account?.connected ? "重新登录 Google" : "登录 Google"}</button>
      {busy === "login" ? <button type="button" aria-label="取消 Google 登录" title="取消 Google 登录" onClick={() => { void window.afkDesktop.plugins.google.cancel().catch(failure => { if (mounted.current) setError(failure instanceof Error ? failure.message : "取消失败，请重试。"); }); }}><X size={16} /></button> : null}
      {account?.connected ? <button type="button" aria-label="断开 Google 账号" title="撤销 Google 授权并移除本机凭据" disabled={!!busy} onClick={() => setConfirmLogout(true)}><LogOut size={16} /></button> : null}
    </div>
    <p className="plugin-notice">选择 Google Desktop OAuth 客户端 JSON 后自动打开系统浏览器。登录后自动补齐 Google 凭据与 Gmail 插件配置，保留已有 Gmail 设置及禁用状态。邮件发送需要账号身份及 gmail.send 权限；凭据保存在系统钥匙串。默认使用已登录账号作为收件人，通知集成仍需单独配置。</p>
    {error ? <p role="alert">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {confirmLogout ? <SshConfirmDialog title="断开 Google 账号" description="撤销 Google 授权并移除本机凭据，后续 Gmail 通知需要重新登录。" confirmLabel="断开" confirmAriaLabel="确认断开 Google 账号" onCancel={() => setConfirmLogout(false)} onConfirm={() => { setConfirmLogout(false); void run("logout"); }} /> : null}
  </section>;
}
