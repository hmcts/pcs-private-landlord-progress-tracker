#!/usr/bin/env bash
# Stores a twg login made in a throwaway home as a Key Vault secret the Publish workflow can
# restore (README.md, "Jira sign-in"), then deletes that home. Prints only success or failure
# and the value's size: never the sign-in.
#
#   scripts/seed-twg-secret.sh <vault> <secret> <dir>
#
# <dir> is the throwaway home the login was made in, with
# HOME=<dir> XDG_CONFIG_HOME=<dir>/.config twg login --force --site hmcts.
set -euo pipefail
umask 077

if (( $# != 3 )); then
  echo "usage: $0 <vault> <secret> <dir>" >&2
  exit 2
fi
export TWG_VAULT=$1 TWG_SECRET=$2
dir=$(cd "$3" 2>/dev/null && pwd -P) || { echo "error: $3 isn't a directory" >&2; exit 1; }

tmp_root=$(cd "$(dirname "$(mktemp -u)")" && pwd -P)
case "$dir/" in
  "$tmp_root"/?*/) ;;
  *) echo "error: $dir isn't under $tmp_root, so it isn't a throwaway home this script may delete" >&2; exit 1 ;;
esac
if [[ ! -d "$dir/.config/twg" ]]; then
  echo "error: $dir/.config/twg doesn't exist. Sign in with HOME=$dir XDG_CONFIG_HOME=$dir/.config first" >&2
  exit 1
fi
if ! tar --version 2>/dev/null | grep -q GNU; then
  echo "error: this needs GNU tar (on macOS, install gnu-tar and put its gnubin first on PATH)" >&2
  exit 1
fi
for tool in az jq base64 sha256sum timeout twg; do
  command -v "$tool" > /dev/null || { echo "error: this needs $tool" >&2; exit 1; }
done

RUNNER_TEMP=$(mktemp -d)
export RUNNER_TEMP
trap 'rm -rf "$RUNNER_TEMP"' EXIT
# The seed's own config, never yours; az keeps your real HOME.
export XDG_CONFIG_HOME="$dir/.config"

# shellcheck source=../.github/actions/twg-sign-in/twg-auth.sh
source "$(dirname "$0")/../.github/actions/twg-sign-in/twg-auth.sh"
twg_cli() { HOME="$dir" XDG_CONFIG_HOME="$dir/.config" timeout 60 twg "$@"; }
echo archive > "$RUNNER_TEMP/twg-auth.format"

if ! twg_check; then
  echo "error: $(twg_check_failure) in $dir. Check that twg auth storage status reports the file backend, then sign in again" >&2
  exit 1
fi
if ! twg_store; then
  code=$(twg_kv_code)
  echo "error: could not store $TWG_SECRET (${code:-no Key Vault error code}). $dir is kept" >&2
  exit 1
fi
rm -rf "$dir"
echo "stored $TWG_SECRET ($twg_stored_bytes bytes) and deleted $dir"
