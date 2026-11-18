#!/bin/bash
set -eu
umask 077
product=$(realpath "${1:?pass the installed afk launcher}")
chromium=$(realpath "${2:?pass a local Chromium executable}")
receipts=$(mktemp -d "${3:?pass an existing evidence directory}/browser-check.XXXXXX")
receipts=$(cd "$receipts" && pwd -P)
node_bin=$(command -v node)
probe=$(realpath tests/qualification/w10/browser-check.cjs)
playwright=$(realpath apps/desktop/node_modules/@playwright/test)
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
  printf 'Product: %s\nChromium: %s\n' "$product" "$chromium"
  isolated "$product" --version
  isolated "$node_bin" --version
  isolated "$node_bin" "$playwright/cli.js" --version
  shasum -a 256 "$product" "$chromium" "$probe"
} > "$receipts/tools.txt"
jq -n --args '$ARGS.positional | {command:.}' "$node_bin" "$probe" "$playwright" "$chromium" > config.json
jq -n --arg target "$project" '{target:$target}' > input.json
isolated "$product" plugin configure verification.browser-check --builtin --file config.json > "$receipts/configured.txt"
isolated git -C "$project" init -q
cat > "$project/parcel.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Parcel</title>
<link rel="stylesheet" href="parcel.css">
<button onclick="document.querySelector('output').textContent='Parcel ready'">Check parcel</button>
<output>Pending</output>
HTML

check_page() {
  label=$1
  printf 'output { display: %s; }\n' "$2" > "$project/parcel.css"
  isolated git -C "$project" add parcel.html parcel.css
  isolated git -C "$project" -c user.name=Qualification -c user.email=local@example.invalid commit -qm "$label"
  isolated git -C "$project" rev-parse HEAD > "$receipts/$label.revision"
  exit_code=0
  isolated env PARCEL_SCREENSHOT="$receipts/$label.png" PARCEL_OBSERVATION="$receipts/$label.render.json" \
    "$product" plugin invoke verification.provider browser-check verify --input input.json --json \
    > "$receipts/$label.json" 2> "$receipts/$label.stderr" || exit_code=$?
  printf '%s\n' "$exit_code" > "$receipts/$label.exit"
  test "$exit_code" = "$3"
  test -s "$receipts/$label.png"
  test -z "$(isolated git -C "$project" status --porcelain)"
  jq -e --argjson expected "$4" --slurpfile render "$receipts/$label.render.json" \
    '.passed == $expected and (.output | fromjson) == $render[0] and ($render[0] | .text == "Parcel ready" and .visible == $expected and ((.width > 0) == $expected) and (.browser | length > 0))' \
    "$receipts/$label.json" >/dev/null
}
check_page hidden none 1 false
check_page visible block 0 true
printf '%s\n' 'PASS: installed browser-check rejected the hidden status and accepted the visible status.'
