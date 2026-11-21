#!/bin/bash
set -eu
umask 077

product=$(realpath "${1:?pass the installed afk launcher}")
receipts=$(mktemp -d "${2:?pass an existing evidence directory}/static-scan.XXXXXX")
receipts=$(cd "$receipts" && pwd -P)
compiler=$(realpath node_modules/typescript/bin/tsc)
node_bin=$(command -v node)
project="$receipts/project"
mkdir -p "$project" "$receipts/profile" "$receipts/tmp" "$receipts/control"
printf 'Receipts: %s\n' "$receipts"
cd "$receipts/control"

isolated() {
  env -i HOME="$receipts/profile" USERPROFILE="$receipts/profile" TMPDIR="$receipts/tmp" \
    XDG_CONFIG_HOME="$receipts/profile/config" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    PATH="$(dirname "$node_bin"):/usr/bin:/bin" "$@"
}

isolated "$product" plugin configure --help > "$receipts/configure-help.txt"
isolated "$product" plugin invoke --help > "$receipts/invoke-help.txt"
{
  printf 'Installed CLI: %s\nCompiler: %s\n' "$product" "$compiler"
  isolated "$product" --version
  isolated "$node_bin" --version
  isolated "$node_bin" "$compiler" --version
  shasum -a 256 "$product" "$compiler"
} > "$receipts/tools.txt"
jq -n --arg node "$node_bin" --arg tsc "$compiler" \
  '{command:[$node,$tsc,"--project","tsconfig.json","--pretty","false"]}' > config.json
jq -n --arg target "$project" '{target:$target}' > input.json
isolated "$product" plugin configure verification.static-scan --builtin --file config.json > "$receipts/configured.txt"
isolated git -C "$project" init -q
printf '%s\n' '{"compilerOptions":{"strict":true,"noEmit":true,"types":[]},"files":["parcel.ts"]}' > "$project/tsconfig.json"

scan() {
  label=$1
  isolated git -C "$project" add parcel.ts tsconfig.json
  isolated git -C "$project" -c user.name=Qualification -c user.email=local@example.invalid commit -qm "$label"
  isolated git -C "$project" rev-parse HEAD > "$receipts/$label.revision"
  test -z "$(isolated git -C "$project" status --porcelain)"
  exit_code=0
  isolated "$product" plugin invoke verification.provider static-scan verify --input input.json --json \
    > "$receipts/$label.json" 2> "$receipts/$label.stderr" || exit_code=$?
  printf '%s\n' "$exit_code" > "$receipts/$label.exit"
  test -z "$(isolated git -C "$project" status --porcelain)"
}

printf '%s\n' 'export const parcelCount: number = "three";' > "$project/parcel.ts"
scan rejected
test "$(cat "$receipts/rejected.exit")" = 1
jq -e '.passed == false and (.output | contains("parcel.ts(1,14): error TS2322"))' "$receipts/rejected.json" >/dev/null
printf '%s\n' 'export const parcelCount: number = 3;' > "$project/parcel.ts"
scan accepted
test "$(cat "$receipts/accepted.exit")" = 0
jq -e '.passed == true and .output == ""' "$receipts/accepted.json" >/dev/null
test "$(cat "$receipts/rejected.revision")" != "$(cat "$receipts/accepted.revision")"
printf '%s\n' 'PASS: installed static-scan rejected TS2322 and accepted the corrected revision.'
