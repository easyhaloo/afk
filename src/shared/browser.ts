/** Open a URL with the operating system's default browser. */
export async function openInBrowser(url: string): Promise<void> {
  const { default: open } = await import('open');
  await open(url);
}
