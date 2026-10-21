import type { BrowserPort } from '@afk/application';

/**
 * The operating system's browser, reached through the port.
 *
 * The module loads the opener only when a link is actually opened, so a
 * program that never opens one does not carry the dependency.
 */
export const browserPort: BrowserPort = {
  async open(url: string): Promise<void> {
    const { default: open } = await import('open');
    await open(url);
  },
};
