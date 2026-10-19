/**
 * The version of the AFK runtime.
 *
 * The CLI prints it for `--version`, and the desktop client reports the
 * version of the runtime it embeds. Both read it from here, so a packaged
 * desktop client and the CLI it ships with never disagree.
 */
export const AFK_VERSION = '0.1.0';
