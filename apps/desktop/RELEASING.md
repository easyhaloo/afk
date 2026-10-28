# AFK Control Desktop Releases

## Release a version

1. Update `apps/desktop/package.json` `version` and commit the change to `main`.
2. Create and push a matching annotated tag, for example:

   ```sh
   git tag -a desktop-v0.1.0 -m "AFK Control 0.1.0"
   git push origin desktop-v0.1.0
   ```

3. The `Release Desktop` workflow builds installers on Windows, macOS Apple Silicon, macOS Intel, and Linux, runs typecheck/tests, calculates SHA-256 checksums, and attaches artifacts to the matching GitHub Release.

The tag must exactly match `apps/desktop/package.json`'s version. CLI releases use `cli-v*`; desktop releases use `desktop-v*`. The workflow explicitly uses `--latest=false`, so a desktop release does not replace the repository-wide Latest release used by other release streams.

## Installer formats

- Windows: NSIS `.exe`, configured for one-click per-user installation.
- macOS: `.dmg` and `.zip` for Intel and Apple Silicon.
- Linux: `.AppImage` and `.deb`.

## Auto-update status and prerequisites

The packaged app uses `electron-updater` with a generic feed hosted on the `desktop-updates` branch (`raw.githubusercontent.com`). The release workflow publishes installers to GitHub Releases, then publishes `latest.yml`, `latest-mac.yml`, and `latest-linux.yml` metadata to that branch. The publish job keeps each platform's build metadata separate and merges the Intel and Apple Silicon entries into one `latest-mac.yml`; this is required because the two macOS builds produce the same metadata filename. Metadata URLs point directly to assets on the matching `desktop-v*` release, with spaces URL-encoded.

Production desktop releases require macOS Developer ID code signing and notarization. Before running the release workflow, configure these GitHub Actions secrets: `MACOS_CERTIFICATE_P12_BASE64` (base64-encoded Developer ID `.p12` certificate), `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. The preparation job validates all five and fails before packaging if any are missing; signing secrets are passed to electron-builder only in the packaging step. Never commit certificates or passwords. Windows code signing is recommended. Linux in-app updates support AppImage; `.deb` users must install new packages manually.
