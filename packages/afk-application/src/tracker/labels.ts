/**
 * The labels AFK reads off a tracker issue.
 *
 * Two adapters read the same labels and reach the same conclusions about
 * them. The rules live here, so a label means one thing: the retry count a
 * `retry-count::N` label carries, and the branch a `base::prd-N` label
 * points at.
 */

/** The retry count an issue's labels carry, zero when they carry none. */
export function retryCountFromLabels(labels: readonly string[]): number {
  const label = labels.find(candidate => /^retry-count::\d+$/.test(candidate));
  if (!label) return 0;
  return parseInt(label.split('::')[1], 10);
}

/**
 * The branch an issue's labels point at.
 *
 * An explicit branch wins, then a `base::prd-N` label, then the fallback —
 * the same order in every adapter.
 */
export function targetBranchFromLabels(labels: readonly string[], explicit?: string, fallback = "main"): string {
  if (explicit) return explicit;
  const prdLabel = labels.find(candidate => /^base::prd-\d+$/.test(candidate));
  if (prdLabel) return `prd/${prdLabel.replace('base::prd-', '')}`;
  return fallback;
}
