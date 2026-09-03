import { load as loadYaml } from "js-yaml";

export type ConfigObject = Record<string, unknown>;
export type ConfigScalar = string | number | boolean;

function asConfigObject(value: unknown): ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ConfigObject : {};
}

export function parseConfig(raw: string): ConfigObject {
  if (!raw.trim()) return {};
  try {
    return asConfigObject(loadYaml(raw));
  } catch {
    return {};
  }
}

export function configValue(document: ConfigObject, key: string): unknown {
  return key.split(".").reduce<unknown>((current, segment) => asConfigObject(current)[segment], document);
}

export function configString(document: ConfigObject, key: string, fallback: string) {
  const value = configValue(document, key);
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function configNumber(document: ConfigObject, key: string, fallback: number) {
  const value = configValue(document, key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
