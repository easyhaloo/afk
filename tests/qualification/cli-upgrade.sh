#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 4 || $2 == "$4" ]]; then
  echo 'Usage: bash cli-upgrade.sh OLD_RELEASE_DIR OLD_VERSION NEW_RELEASE_DIR NEW_VERSION' >&2
  exit 2
fi
old_release=$(cd "$1" && pwd)
new_release=$(cd "$3" && pwd)
old_version=$2
new_version=$4
asset=$(node -p "'afk-' + process.platform + '-' + process.arch + '.tar.gz'")
umask 077
cd "$(mktemp -d)"
profile=$PWD
echo "Upgrade evidence directory: $profile"
bin="$profile/.local/bin/afk"

isolated() {
  env -i PATH="$PATH" HOME="$profile" AFK_HOME="$profile/.afk" AFK_WORKSPACE_ROOT="$profile/work" "$@"
}
install_release() {
  isolated bash "$1/install.sh" --skip-completion --version "$2" --archive "$1/$asset" --checksum "$3"
}
check_profile() {
  test "$(isolated "$bin" --version)" = "$1"
  cmp plugins.before .afk/plugins.yml
  isolated "$bin" plugin list --json > list.current
  cmp list.before list.current
}

install_release "$old_release" "$old_version" "$old_release/$asset.sha256"
printf '%s\n' '{"endpoint":"http://127.0.0.1:4318","serviceName":"upgrade-probe"}' > settings.json
isolated "$bin" plugin configure observability.otlp --builtin --file "$profile/settings.json"
cp .afk/plugins.yml plugins.before
isolated "$bin" plugin list --json > list.before
node -e "const entries = JSON.parse(require('node:fs').readFileSync('list.before')); require('node:assert/strict').ok(entries.some(entry => entry.id === 'observability.otlp' && entry.enabled))"
old_target=$(readlink "$bin")
printf '%064d\n' 0 > invalid.sha256
if install_release "$new_release" "$new_version" "$profile/invalid.sha256" > rejected.log 2>&1; then exit 1; fi
grep -Fq 'release checksum does not match' rejected.log
test "$(readlink "$bin")" = "$old_target"
check_profile "$old_version"
install_release "$new_release" "$new_version" "$new_release/$asset.sha256"
check_profile "$new_version"
install_release "$old_release" "$old_version" "$old_release/$asset.sha256"
test "$(readlink "$bin")" = "$old_target"
check_profile "$old_version"
printf 'Verified offline upgrade %s -> %s, checksum rejection, configuration and rollback.\n' "$old_version" "$new_version"
