# AFK Control Desktop Releases

## Release a version

1. Update `apps/desktop/package.json` `version` and commit the change to `main`.
2. Create and push a matching annotated tag, for example:

   ```sh
   git tag -a desktop-v0.1.0 -m "AFK Control 0.1.0"
   git push origin desktop-v0.1.0
   ```

3. The `Release Desktop` workflow builds installers on Windows, macOS Apple Silicon, macOS Intel, and Linux, runs typecheck/tests, calculates SHA-256 checksums, and attaches artifacts to the matching GitHub Release.

The tag must exactly match `apps/desktop/package.json`'s version. CLI releases use `cli-v*`; desktop releases use `desktop-v*` and do not use GitHub's repository-wide `--latest` marker.

## Installer formats

- Windows: NSIS `.exe`, configured for one-click per-user installation.
- macOS: `.dmg` and `.zip` for Intel and Apple Silicon.
- Linux: `.AppImage` and `.deb`.

## Auto-update status and prerequisites

No update feed is configured yet. This workflow publishes installers to GitHub Releases only; it does **not** publish update metadata or wire an updater UI into the running app. GitHub Pages is not enabled for this repository, so a generic feed URL must not be configured until its hosting and publishing workflow exist. Do not advertise in-app automatic updates until those pieces are implemented and tested.

Production macOS distribution also needs Developer ID code signing and notarization for a trustworthy first install and update experience. Store signing credentials in GitHub Actions secrets; never commit certificates or passwords. Windows code signing is recommended.
