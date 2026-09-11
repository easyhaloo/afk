export interface FixedChrome {
  header: number;
  context: number;
  footer: number;
  spacer: number;
}

export function getListViewportHeight(height: number, chrome: FixedChrome): number {
  return Math.max(1, height - chrome.header - chrome.context - chrome.footer - chrome.spacer);
}

export function getRowColumns(width: number): { summary: boolean; metadataWidth: number } {
  return {
    summary: width >= 80,
    metadataWidth: width >= 120 ? 30 : 20,
  };
}
