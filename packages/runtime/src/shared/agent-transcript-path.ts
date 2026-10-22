export function claudeProjectSlug(workspace: string): string {
  return workspace.replace(/[/.]/g, '-');
}
