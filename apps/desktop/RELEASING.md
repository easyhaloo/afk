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

The packaged app uses `electron-updater` with a generic feed hosted on the `desktop-updates` branch (`raw.githubusercontent.com`). The release workflow publishes installers to GitHub Releases, then publishes `latest.yml`, `latest-mac.yml`, and `latest-linux.yml` metadata to that branch. Metadata points directly to assets on the matching `desktop-v*` release, independently of CLI releases.

Production macOS distribution needs Developer ID code signing and notarization. Until signing secrets are configured, macOS updates are not production-ready. Linux in-app updates support AppImage; `.deb` users must install new packages manually. Store signing credentials in GitHub Actions secrets; never commit certificates or passwords. Windows code signing is recommended.
