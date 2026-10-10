export type CliInvocation = { command: string; args: string[] };

export function normalizeCliInvocation(value: string | CliInvocation): CliInvocation {
  return typeof value === "string" ? { command: value, args: [] } : value;
}
