import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppearancePreferences } from "../../shared/ipc-contract";

export const DEFAULT_APPEARANCE: AppearancePreferences = { locale: "system", fontFamily: "system", fontScale: "medium", accent: "violet", theme: "light" };

function preferencePath() {
  return path.join(app.getPath("userData"), "appearance.json");
}

export function cleanAppearance(value: unknown): AppearancePreferences {
  const candidate = value !== null && typeof value === "object" ? value as Partial<AppearancePreferences> : {};
  return {
    locale: candidate.locale === "zh-CN" || candidate.locale === "en-US" ? candidate.locale : "system",
    fontFamily: candidate.fontFamily === "serif" || candidate.fontFamily === "mono" ? candidate.fontFamily : "system",
    fontScale: candidate.fontScale === "small" || candidate.fontScale === "large" ? candidate.fontScale : "medium",
    accent: candidate.accent === "teal" || candidate.accent === "amber" ? candidate.accent : "violet",
    theme: candidate.theme === "graphite" ? "graphite" : "light",
  };
}

export async function readAppearance(): Promise<AppearancePreferences> {
  try {
    return cleanAppearance(JSON.parse(await fs.readFile(preferencePath(), "utf8")));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export async function saveAppearance(value: unknown): Promise<AppearancePreferences> {
  const appearance = cleanAppearance(value);
  await fs.mkdir(path.dirname(preferencePath()), { recursive: true });
  await fs.writeFile(preferencePath(), JSON.stringify(appearance, null, 2) + "\n", "utf8");
  return appearance;
}
