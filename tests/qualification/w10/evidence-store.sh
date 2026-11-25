#!/bin/sh
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'Usage: sh evidence-store.sh /path/to/installed/afk [expected-version]' >&2
  exit 2
fi
recipe=$(cd "$(dirname "$0")" && pwd -P)
cli=$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$1")
scratch=$(mktemp -d "${TMPDIR:-/tmp}/w10-evidence.XXXXXXXX")
scratch=$(cd "$scratch" && pwd -P)
mkdir "$scratch/home" "$scratch/tmp"
cd "$(dirname "$cli")/.."
exec env -i HOME="$scratch/home" TMPDIR="$scratch/tmp" W10_DB="$scratch/store.sqlite" \
  PATH="$(dirname "$(command -v node)"):/usr/bin:/bin:$(dirname "$(command -v sqlite3)")" \
  node --input-type=module -e '
    import * as sdk from "@afk/runtime/plugin-sdk";
    import { pathToFileURL } from "node:url";
    const [recipe, cli, scratch, expectedVersion] = process.argv.slice(1);
    await (await import(pathToFileURL(recipe))).qualify(sdk, cli, scratch, expectedVersion);
  ' "$recipe/evidence-store.mjs" "$cli" "$scratch" "${2-0.2.147}"
