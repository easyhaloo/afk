import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../../src/cli/command-registry';
import { AFK_CAPABILITY_DEFINITIONS } from '../../desktop-client/electron/services/desktop-service';
import { DEMO_SNAPSHOT } from '../../desktop-client/src/mock-data';
import { AFK_VERSION } from '@afk/application';

/**
 * The desktop's snapshot tells other tools what AFK can do, and every
 * entry names the command to run.
 *
 * The list had drifted: it offered `afk board`, which the dispatcher
 * refuses - the TUI is `afk` with no arguments. A command that does not
 * exist is a promise the product does not keep, and the snapshot is what
 * a reader trusts.
 */
describe('the desktop capability list', () => {
  it('names commands the CLI actually has', () => {
    const names = new Set(COMMANDS.flatMap(entry => entry.names));
    const lists = [AFK_CAPABILITY_DEFINITIONS, DEMO_SNAPSHOT.capabilities];

    for (const list of lists) {
      for (const capability of list) {
        const [binary, ...rest] = capability.command.trim().split(/\s+/);
        expect(binary).toBe('afk');
        if (rest.length === 0) continue;
        expect(names.has(rest[0])).toBe(true);
      }
    }
  });

  it('reports the version the package is released under', () => {
    // The runtime's version is a constant in @afk/application: the CLI
    // prints it and the desktop reports it. The package's own version is
    // what pnpm and npm see. Nothing tied the two together, so a release
    // that bumped one and not the other made `afk --version` answer a
    // question about a version that no longer existed.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };

    expect(AFK_VERSION).toBe(manifest.version);
  });
});
