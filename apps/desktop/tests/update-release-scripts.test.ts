import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assembleScript = path.join(desktopDirectory, "scripts/assemble-update-feed.mjs");
const rewriteScript = path.join(desktopDirectory, "scripts/rewrite-update-feed.mjs");
const temporaryDirectories: string[] = [];

function createWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "afk-desktop-release-test-"));
  temporaryDirectories.push(root);
  return {
    root,
    artifacts: path.join(root, "artifacts"),
    output: path.join(root, "output"),
  };
}

function writeManifest(directory: string, filename: string, version: string, asset: string) {
  const body = [
    `version: ${version}`,
    "files:",
    `  - url: ${asset}`,
    "    sha512: dGVzdC1zaGE1MTI=",
    "    size: 123",
    `path: ${asset}`,
    "sha512: dGVzdC1zaGE1MTI=",
    "releaseDate: '2026-10-28T00:00:00.000Z'",
    "",
  ].join("\n");
  writeFileSync(path.join(directory, filename), body);
}

function writeArtifact(artifacts: string, name: string, metadata: string, metadataName: string, asset: string) {
  const directory = path.join(artifacts, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, asset), "installer artifact");
  writeManifest(directory, metadataName, "0.1.0", asset);
}

describe("desktop release metadata assembly", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("merges macOS architectures and rewrites all feed URLs to encoded release asset URLs", () => {
    const workspace = createWorkspace();
    mkdirSync(workspace.artifacts, { recursive: true });
    writeArtifact(workspace.artifacts, "desktop-windows", "latest.yml", "latest.yml", "AFK Control-0.1.0-win-x64.exe");
    writeArtifact(workspace.artifacts, "desktop-linux", "latest-linux.yml", "latest-linux.yml", "AFK Control-0.1.0-linux-x64.AppImage");
    writeArtifact(workspace.artifacts, "desktop-macos-arm64", "latest-mac.yml", "latest-mac.yml", "AFK Control-0.1.0-mac-arm64.zip");
    writeArtifact(workspace.artifacts, "desktop-macos-x64", "latest-mac.yml", "latest-mac.yml", "AFK Control-0.1.0-mac-x64.zip");

    execFileSync(process.execPath, [assembleScript, workspace.artifacts, workspace.output], { cwd: desktopDirectory });

    const macManifest = load(readFileSync(path.join(workspace.output, "latest-mac.yml"), "utf8")) as {
      version: string;
      files: Array<{ url: string; sha512: string; size: number }>;
      path?: string;
      sha512?: string;
    };
    expect(macManifest.version).toBe("0.1.0");
    expect(macManifest.files.map((file) => file.url).sort()).toEqual([
      "AFK Control-0.1.0-mac-arm64.zip",
      "AFK Control-0.1.0-mac-x64.zip",
    ]);
    expect(macManifest.path).toBeUndefined();
    expect(macManifest.sha512).toBeUndefined();
    expect(readFileSync(path.join(workspace.output, "latest.yml"), "utf8")).toContain("version: 0.1.0");
    expect(readFileSync(path.join(workspace.output, "latest-linux.yml"), "utf8")).toContain("version: 0.1.0");

    execFileSync(process.execPath, [rewriteScript, workspace.output], {
      cwd: desktopDirectory,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "easyhaloo/afk",
        RELEASE_TAG: "desktop-v0.1.0",
      },
    });

    const rewrittenMacManifest = load(readFileSync(path.join(workspace.output, "latest-mac.yml"), "utf8")) as {
      files: Array<{ url: string }>;
    };
    expect(rewrittenMacManifest.files.map((file) => file.url).sort()).toEqual([
      "https://github.com/easyhaloo/afk/releases/download/desktop-v0.1.0/AFK%20Control-0.1.0-mac-arm64.zip",
      "https://github.com/easyhaloo/afk/releases/download/desktop-v0.1.0/AFK%20Control-0.1.0-mac-x64.zip",
    ]);
    expect(readFileSync(path.join(workspace.output, "latest.yml"), "utf8")).toContain(
      "https://github.com/easyhaloo/afk/releases/download/desktop-v0.1.0/AFK%20Control-0.1.0-win-x64.exe",
    );
  });

  it("fails closed when platform metadata describes different versions", () => {
    const workspace = createWorkspace();
    mkdirSync(workspace.artifacts, { recursive: true });
    writeArtifact(workspace.artifacts, "desktop-windows", "latest.yml", "latest.yml", "AFK Control-0.1.0-win-x64.exe");
    writeArtifact(workspace.artifacts, "desktop-linux", "latest-linux.yml", "latest-linux.yml", "AFK Control-0.1.0-linux-x64.AppImage");
    writeArtifact(workspace.artifacts, "desktop-macos-arm64", "latest-mac.yml", "latest-mac.yml", "AFK Control-0.1.0-mac-arm64.zip");
    writeArtifact(workspace.artifacts, "desktop-macos-x64", "latest-mac.yml", "latest-mac.yml", "AFK Control-0.1.0-mac-x64.zip");

    const windowsManifest = path.join(workspace.artifacts, "desktop-windows", "latest.yml");
    writeManifest(path.dirname(windowsManifest), "latest.yml", "0.2.0", "AFK Control-0.2.0-win-x64.exe");

    expect(() => execFileSync(process.execPath, [assembleScript, workspace.artifacts, workspace.output], { cwd: desktopDirectory }))
      .toThrow();
  });
});
