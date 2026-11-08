import { configureGoogleAccountPlugins, GoogleOAuthCredentialProvider, GoogleOAuthError } from "@afk/runtime/plugin-sdk";
import type { GoogleAccountStatus } from "../../shared/plugin-contract.js";

const messages: Record<string, string> = {
  "authorization.timeout": "Google 登录超时，回调已关闭。请重新登录。",
  "token.network": "无法连接 Google，请检查本机网络或代理后重试。",
  "token.exchange": "Google 授权失败，请检查 Desktop OAuth 客户端及授权权限。",
  "token.scope": "缺少 Google 邮件发送或账号身份权限，请重新授权。",
  "token.offline": "Google 未提供离线凭据，请重新同意授权。",
  "account.identity": "无法确认 Google 账号身份，请重新登录。",
  "account.storage": "无法保存 Google 凭据，请解锁系统钥匙串后重试。",
};

export function createGoogleAuthService(options: {
  chooseClientFile: () => Promise<string | undefined>;
  openExternal: (url: string) => Promise<void>;
  provider?: Pick<GoogleOAuthCredentialProvider, "status" | "login" | "logout">;
  configurePlugins?: () => Promise<void>;
}) {
  const provider = options.provider ?? new GoogleOAuthCredentialProvider({ openBrowser: async url => {
    const target = new URL(url);
    if (target.origin !== "https://accounts.google.com" || target.pathname !== "/o/oauth2/v2/auth") throw new Error("Invalid authorization URL");
    await options.openExternal(url);
  } });
  let pending: { controller: AbortController; result: Promise<GoogleAccountStatus | null> } | undefined;
  let disconnecting = false;

  async function status(): Promise<GoogleAccountStatus> {
    try {
      const account = await provider.status();
      return { connected: account.connected, ...(account.email ? { email: account.email } : {}), ...(account.expiresAt ? { expiresAt: account.expiresAt } : {}) };
    } catch { throw new Error("无法读取 Google 账号，请检查系统钥匙串，或重新登录修复账号记录。"); }
  }

  return {
    status,
    login(): Promise<GoogleAccountStatus | null> {
      if (pending || disconnecting) return Promise.reject(new Error("Google 账号操作正在进行，请等待或取消后重试。"));
      const controller = new AbortController();
      const result = (async () => {
        let connected = false;
        try {
          const file = await options.chooseClientFile();
          if (!file || controller.signal.aborted) return null;
          const account = await provider.login(file, { signal: controller.signal });
          connected = true;
          await (options.configurePlugins ?? configureGoogleAccountPlugins)();
          return { connected: true, email: account.email };
        } catch (error) {
          if (connected) throw new Error("Google 账号已连接但配置失败，请在插件管理中检查 Google 凭据与 Gmail 配置后重试；账号凭据已保留。");
          if (controller.signal.aborted) return null;
          if (error instanceof GoogleOAuthError) throw new Error(Object.hasOwn(messages, error.code) ? messages[error.code] : "Google 授权失败，请检查授权权限、网络与系统钥匙串后重试。");
          throw new Error("Google 登录失败，请选择 Google Desktop OAuth 客户端 JSON，并检查浏览器、回调端口及系统钥匙串后重试。");
        } finally { pending = undefined; }
      })();
      pending = { controller, result };
      return result;
    },
    async cancel(): Promise<void> {
      const operation = pending;
      operation?.controller.abort();
      await operation?.result.catch(() => undefined);
    },
    async logout(): Promise<void> {
      if (pending || disconnecting) throw new Error("Google 账号操作正在进行，请等待或取消后重试。");
      disconnecting = true;
      try { await provider.logout(); }
      catch { throw new Error("Google 断开失败；本机凭据已保留，请检查网络与系统钥匙串后重试。"); }
      finally { disconnecting = false; }
    },
  };
}
