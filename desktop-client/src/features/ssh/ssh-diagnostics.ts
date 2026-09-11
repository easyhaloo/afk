import type { SshDiagnostic } from "../../../shared/ssh-contract";

export type GroupedSshDiagnostic = {
  code: string;
  severity: SshDiagnostic["severity"];
  message: string;
  path?: string;
  count: number;
  hostAliases: string[];
};

function normalizeMessage(diagnostic: SshDiagnostic) {
  if (!diagnostic.hostAlias) return diagnostic.message;
  return diagnostic.message.replace(/^Host\s+\S+(?:\s*[:：]\s*|\s+)/, "").trim();
}

function compareStrings(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function groupSshDiagnostics(diagnostics: SshDiagnostic[]): GroupedSshDiagnostic[] {
  const groups = new Map<string, GroupedSshDiagnostic>();

  for (const diagnostic of diagnostics) {
    const message = normalizeMessage(diagnostic);
    const key = JSON.stringify([diagnostic.severity, diagnostic.code, message, diagnostic.path]);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (diagnostic.hostAlias && !existing.hostAliases.includes(diagnostic.hostAlias)) {
        existing.hostAliases.push(diagnostic.hostAlias);
        existing.hostAliases.sort(compareStrings);
      }
      continue;
    }

    const group: GroupedSshDiagnostic = {
      code: diagnostic.code,
      severity: diagnostic.severity,
      message,
      count: 1,
      hostAliases: diagnostic.hostAlias ? [diagnostic.hostAlias] : [],
    };
    if (diagnostic.path !== undefined) group.path = diagnostic.path;
    groups.set(key, group);
  }

  return [...groups.values()];
}
