import type { AppearancePreferences } from "../../shared/ipc-contract";
import { enUS, type MessageKey, zhCN } from "./catalogs";

export type Locale = Exclude<AppearancePreferences["locale"], "system">;
export const catalogs = { "zh-CN": zhCN, "en-US": enUS } as const;

export function resolveLocale(preference: AppearancePreferences["locale"], systemLocale: string): Locale {
  if (preference !== "system") return preference;
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function translate(locale: Locale, key: MessageKey, variables: Record<string, string | number> = {}): string {
  return Object.entries(variables).reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)), catalogs[locale][key] as string);
}
