import { createGoogleAuthService as createMainGoogleAuthService } from "../../../electron/services/google-auth-service.js";

export function createGoogleAuthService(options: Parameters<typeof createMainGoogleAuthService>[0]) {
  let connected = true;
  return createMainGoogleAuthService({
    ...options,
    configurePlugins: async () => undefined,
    provider: {
      async status() { return connected ? { connected, email: "fixture@example.test", expiresAt: "2000-01-01T00:00:00Z" } : { connected }; },
      async login(_file, operation) {
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("Simulated Google consent cancelled"));
          if (operation?.signal?.aborted) abort();
          else operation?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
      async logout() { connected = false; },
    },
  });
}
