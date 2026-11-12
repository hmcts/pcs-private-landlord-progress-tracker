# shellcheck shell=bash
# Sourced by twg-sign-in and twg-store: how a twg sign-in is restored from, checked, packed and
# stored back to Key Vault. Callers set HOME and XDG_CONFIG_HOME first, and TWG_VAULT and
# TWG_SECRET. This repo is public: nothing here may print the sign-in or any value in it.
#
# A secret holds one of two formats:
#   legacy   twg's auth.conf (key=value), without its access token.
#   archive  "twg-config-tgz:v1:" then the base64 of a gzipped tar of the whole twg config
#            directory, whose entries are all under twg/.

TWG_ARCHIVE_PREFIX='twg-config-tgz:v1:'
# Key Vault's limit on a secret's value.
TWG_SECRET_MAX_BYTES=25600

twg_err="$RUNNER_TEMP/twg-kv.err"

# The Key Vault error code from the last az call, never its message.
twg_kv_code() { grep -oE '\([A-Za-z]+\)' "$twg_err" 2>/dev/null | head -1 | tr -d '()' || true; }

# The format restored by twg-sign-in. Runs restored before formats were recorded are legacy.
twg_format() { cat "$RUNNER_TEMP/twg-auth.format" 2>/dev/null || echo legacy; }

# The format of a raw secret value in a file.
twg_format_of() {
  if [[ "$(head -c "${#TWG_ARCHIVE_PREFIX}" "$1")" == "$TWG_ARCHIVE_PREFIX" ]]; then
    echo archive
  else
    echo legacy
  fi
}

# --- legacy: auth.conf --------------------------------------------------------------------

twg_legacy_conf() { printf '%s\n' "$HOME/.config/twg/auth.conf"; }

twg_legacy_pack() { tr -d '\r' < "$(twg_legacy_conf)" | grep -v '^oauth-access-token='; }

twg_legacy_present() { [[ -f "$(twg_legacy_conf)" ]]; }

# Masks the refresh token. Fails if there isn't one.
twg_legacy_check() {
  local refresh
  refresh=$(twg_legacy_pack | sed -n 's/^oauth-refresh-token=//p' | head -1)
  [[ -n "$refresh" ]] || return 1
  echo "::add-mask::$refresh"
}

twg_legacy_restore() {
  local raw=$1 refresh
  refresh=$(tr -d '\r' < "$raw" | sed -n 's/^oauth-refresh-token=//p' | head -1)
  if [[ -z "$refresh" ]]; then
    echo "::error::$TWG_SECRET holds no oauth-refresh-token. Re-seed it (README.md)"
    return 1
  fi
  echo "::add-mask::$refresh"
  # Stored without its access token (an hour's life, and most of the file).
  mkdir -p "$HOME/.config/twg" || return 1
  tr -d '\r' < "$raw" | grep -v '^oauth-access-token=' > "$(twg_legacy_conf)" || return 1
}

twg_legacy_hash() { twg_legacy_pack | sha256sum | cut -d' ' -f1; }

# --- archive: the whole twg config directory ----------------------------------------------

twg_config_parent() { printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

twg_archive_dir() { printf '%s/twg\n' "$(twg_config_parent)"; }

twg_archive_pack() {
  local tgz rc=0
  tgz=$(mktemp "$RUNNER_TEMP/twg-config.XXXXXX") || return 1
  tar -C "$(twg_config_parent)" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    -czf "$tgz" twg 2>/dev/null || rc=$?
  if (( rc == 0 )); then
    printf '%s' "$TWG_ARCHIVE_PREFIX" && base64 -w0 < "$tgz" || rc=1
  fi
  rm -f "$tgz"
  return "$rc"
}

twg_archive_present() { [[ -d "$(twg_archive_dir)" ]]; }

# Masks every long string in the directory's JSON files, which is where the tokens are. Fails
# if the directory holds no files.
twg_archive_check() {
  local dir file value
  dir=$(twg_archive_dir)
  [[ -n "$(find "$dir" -type f -print -quit 2>/dev/null)" ]] || return 1
  while IFS= read -r -d '' file; do
    while IFS= read -r value; do
      if [[ -n "$value" ]]; then echo "::add-mask::$value"; fi
    done < <(jq -r '.. | strings | select(length >= 32)' "$file" 2>/dev/null || true)
  done < <(find "$dir" -type f -print0)
}

# Only twg/ and the files and directories under it: no absolute paths, no "..", and no links,
# which could point an entry extracted after them outside it.
twg_archive_safe() {
  local tgz=$1 name type
  tar -tzf "$tgz" > /dev/null 2>&1 || return 1
  while IFS= read -r name; do
    case "$name" in twg | twg/ | twg/*) ;; *) return 1 ;; esac
    case "/$name/" in */../* | */./*) return 1 ;; esac
  done < <(tar -tzf "$tgz" 2>/dev/null)
  while IFS= read -r type; do
    case "$type" in -* | d*) ;; *) return 1 ;; esac
  done < <(tar -tvzf "$tgz" 2>/dev/null)
}

twg_archive_restore() {
  local raw=$1 parent tgz rc=0
  parent=$(twg_config_parent)
  tgz=$(mktemp "$RUNNER_TEMP/twg-config.XXXXXX") || return 1
  tr -d '\r\n' < "$raw" | sed "s/^$TWG_ARCHIVE_PREFIX//" | base64 -d > "$tgz" 2>/dev/null || rc=1
  if (( rc == 0 )) && ! twg_archive_safe "$tgz"; then rc=1; fi
  if (( rc != 0 )); then
    rm -f "$tgz"
    echo "::error::$TWG_SECRET isn't a usable ${TWG_ARCHIVE_PREFIX%:} archive of the twg config directory. Re-seed it (README.md)"
    return 1
  fi
  # Exactly what the vault holds, with nothing left over from an earlier sign-in.
  rm -rf "$(twg_archive_dir)" && mkdir -p "$parent" \
    && tar -C "$parent" --no-same-owner --no-same-permissions -xzf "$tgz" 2>/dev/null \
    && chmod 700 "$(twg_archive_dir)" || rc=1
  rm -f "$tgz"
  if (( rc != 0 )); then
    echo "::error::could not unpack $TWG_SECRET into the twg config directory"
    return 1
  fi
  twg_archive_check
}

# The files' names and contents only, so a repack with new tar metadata isn't a change.
twg_archive_hash() {
  (cd "$(twg_config_parent)" && find twg -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1)
}

# --- either format ------------------------------------------------------------------------

twg_restore() { "twg_$1_restore" "$2"; }
twg_present() { "twg_$(twg_format)_present"; }
twg_check() { "twg_$(twg_format)_check"; }
twg_pack() { "twg_$(twg_format)_pack"; }
twg_hash() { "twg_$(twg_format)_hash"; }

# What's missing when twg_check fails, for the error.
twg_check_failure() {
  if [[ "$(twg_format)" == archive ]]; then echo "the twg config directory holds no files"; else echo "auth.conf holds no oauth-refresh-token"; fi
}

# From a file, because --value would put the sign-in on a command line, and to /dev/null,
# because `secret set` echoes the value it stored. Leaves the az error in $twg_err.
twg_store() {
  local tmp rc=0 size
  : > "$twg_err"
  tmp=$(mktemp "$RUNNER_TEMP/twg-auth.XXXXXX") || return 1
  if twg_pack > "$tmp"; then
    size=$(wc -c < "$tmp")
    if (( size > TWG_SECRET_MAX_BYTES )); then
      echo "::error::the packed twg sign-in is $size bytes, over Key Vault's $TWG_SECRET_MAX_BYTES-byte limit for a secret"
      rc=1
    else
      if [[ "$(twg_format)" == archive ]]; then echo "::add-mask::$(< "$tmp")"; fi
      az keyvault secret set --vault-name "$TWG_VAULT" --name "$TWG_SECRET" \
        --file "$tmp" --encoding utf-8 > /dev/null 2> "$twg_err" || rc=$?
    fi
  else
    rc=1
  fi
  rm -f "$tmp"
  return "$rc"
}
