import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dump, load } from "js-yaml";

const artifactRoot = process.argv[2];
const outputRoot = process.argv[3];

if (!artifactRoot || !outputRoot) {
  throw new Error("Usage: assemble-update-feed.mjs <artifact-root> <output-root>");
}

const platforms = [
  { artifact: "desktop-windows", metadata: "latest.yml" },
  { artifact: "desktop-linux", metadata: "latest-linux.yml" },
  { artifact: "desktop-macos-arm64", metadata: "latest-mac.yml" },
  { artifact: "desktop-macos-x64", metadata: "latest-mac.yml" },
];

function readMetadata(artifact, filename) {
  const artifactDirectory = path.join(artifactRoot, artifact);
  const metadataPath = path.join(artifactDirectory, filename);
  const parsed = load(readFileSync(metadataPath, "utf8"));

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid update metadata: ${metadataPath}`);
  }
  if (typeof parsed.version !== "string" || !parsed.version) {
    throw new Error(`Update metadata has no version: ${metadataPath}`);
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(`Update metadata has no downloadable files: ${metadataPath}`);
  }

  return { parsed, metadataPath };
}

function metadataFile(file) {
  return file.endsWith(".yml") || file.endsWith(".yaml");
}

mkdirSync(outputRoot, { recursive: true });

const versions = new Set();
const metadata = new Map();
for (const platform of platforms) {
  const { parsed, metadataPath } = readMetadata(platform.artifact, platform.metadata);
  versions.add(parsed.version);

  if (platform.metadata === "latest-mac.yml") {
    const current = metadata.get(platform.metadata) ?? [];
    current.push({ artifact: platform.artifact, metadataPath, parsed });
    metadata.set(platform.metadata, current);
  } else {
    metadata.set(platform.metadata, [{ artifact: platform.artifact, metadataPath, parsed }]);
  }
}

if (versions.size !== 1) {
  throw new Error(`Update metadata version mismatch: ${[...versions].join(", ")}`);
}

for (const platform of platforms) {
  const sourceDirectory = path.join(artifactRoot, platform.artifact);
  const assets = readdirSync(sourceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !metadataFile(entry.name) && entry.name !== "builder-debug.yml");

  if (assets.length === 0) {
    throw new Error(`No installer assets found in ${sourceDirectory}`);
  }

  for (const asset of assets) {
    const source = path.join(sourceDirectory, asset.name);
    const destination = path.join(outputRoot, asset.name);
    if (readdirSync(outputRoot).includes(asset.name)) {
      throw new Error(`Duplicate release asset name across platform builds: ${asset.name}`);
    }
    copyFileSync(source, destination);
  }
}

for (const [filename, entries] of metadata) {
  let combined = entries[0].parsed;

  if (filename === "latest-mac.yml") {
    const filesByUrl = new Map();
    for (const entry of entries) {
      for (const file of entry.parsed.files) {
        if (!file || typeof file.url !== "string" || !file.url) {
          throw new Error(`Invalid downloadable file entry in ${entry.metadataPath}`);
        }
        const existing = filesByUrl.get(file.url);
        if (existing && (existing.sha512 !== file.sha512 || existing.size !== file.size)) {
          throw new Error(`Conflicting macOS update metadata for ${file.url}`);
        }
        filesByUrl.set(file.url, file);
      }
    }

    combined = {
      ...combined,
      files: [...filesByUrl.values()],
    };
    // The per-architecture fallback fields describe only one architecture.
    // The merged files array is the authoritative list for MacUpdater.
    delete combined.path;
    delete combined.sha512;
  }

  writeFileSync(path.join(outputRoot, filename), dump(combined, { lineWidth: -1, noRefs: true }));
}

for (const platform of platforms) {
  if (!readdirSync(outputRoot).some((name) => name.endsWith(path.extname(platform.metadata)) && name === platform.metadata)) {
    throw new Error(`Failed to assemble update metadata: ${platform.metadata}`);
  }
}

console.log(`Assembled ${readdirSync(outputRoot).length} desktop release files for version ${[...versions][0]}`);
