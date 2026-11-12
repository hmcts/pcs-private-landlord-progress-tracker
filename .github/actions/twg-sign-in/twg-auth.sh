# shellcheck shell=bash
# Sourced by twg-sign-in, twg-store and scripts/seed-twg-secret.sh: how a twg sign-in is restored
# from, checked, packed and stored back to Key Vault. Callers set HOME and XDG_CONFIG_HOME first,
# and RUNNER_TEMP, TWG_VAULT and TWG_SECRET. This repo is public: nothing here may print the
# sign-in or any value in it.
#
# A secret holds one of two formats:
#   legacy   twg's auth.conf (key=value), without its access token.
#   archive  "twg-config-tgz:v1:" then the base64 of a gzipped tar of twg/auth-profiles.json
#            and/or twg/auth.conf, without access tokens. Nothing else in the config directory
#            is the sign-in: the rest is caches twg re-derives, and install state. A seed packed
#            from the whole directory restores too: only its sign-in files are extracted, and
#            the first store packs those alone.

TWG_ARCHIVE_PREFIX='twg-config-tgz:v1:'
TWG_ARCHIVE_FILES=(auth-profiles.json auth.conf)
# Key Vault's limit on a secret's value.
TWG_SECRET_MAX_BYTES=25600
# Deletes access tokens (credentials.primary.oauthAccessToken in twg's profile store) wherever
# they are. walk is defined here because jq before 1.6 lacks it.
TWG_JQ_STRIP='def walk(f): . as $in | if type == "object" then reduce keys_unsorted[] as $k ({}; . + {($k): ($in[$k] | walk(f))}) | f elif type == "array" then map(walk(f)) | f else f end;
  walk(if type == "object" then with_entries(select(.key | test("^(oauth_?)?access_?token$"; "i") | not)) else . end)'

twg_err="$RUNNER_TEMP/twg-kv.err"

twg_gha() { [[ "${GITHUB_ACTIONS:-}" == true ]]; }
twg_mask() { if twg_gha; then echo "::add-mask::$1"; fi; }
twg_error() { if twg_gha; then echo "::error::$*"; else echo "error: $*" >&2; fi; }

# The Key Vault error code from the last az call, never its message.
twg_kv_code() { grep -oE '\([A-Za-z]+\)' "$twg_err" 2>/dev/null | head -1 | tr -d '()' || true; }

# twg with the caller's HOME and XDG_CONFIG_HOME. The seed script redefines it to point twg at
# the seed's home.
twg_cli() { timeout 60 twg "$@"; }

twg_config_dir() { printf '%s/twg\n' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

# The format twg-sign-in restored.
twg_format() { cat "$RUNNER_TEMP/twg-auth.format"; }

# The format of a raw secret value in a file.
twg_format_of() {
  if [[ "$(head -c "${#TWG_ARCHIVE_PREFIX}" "$1")" == "$TWG_ARCHIVE_PREFIX" ]]; then
    echo archive
  else
    echo legacy
  fi
}

# --- legacy: auth.conf --------------------------------------------------------------------

twg_legacy_pack() { tr -d '\r' < "$(twg_config_dir)/auth.conf" | grep -v '^oauth-access-token='; }

twg_legacy_present() { [[ -f "$(twg_config_dir)/auth.conf" ]]; }

# Masks the refresh token. Fails if there isn't one.
twg_legacy_check() {
  local refresh
  refresh=$(twg_legacy_pack | sed -n 's/^oauth-refresh-token=//p' | head -1)
  [[ -n "$refresh" ]] || return 1
  twg_mask "$refresh"
}

twg_legacy_restore() {
  local raw=$1 refresh
  refresh=$(tr -d '\r' < "$raw" | sed -n 's/^oauth-refresh-token=//p' | head -1)
  if [[ -z "$refresh" ]]; then
    twg_error "$TWG_SECRET holds no oauth-refresh-token. Re-seed it (README.md)"
    return 1
  fi
  twg_mask "$refresh"
  # Stored without its access token (an hour's life, and most of the file).
  mkdir -p "$(twg_config_dir)" || return 1
  tr -d '\r' < "$raw" | grep -v '^oauth-access-token=' > "$(twg_config_dir)/auth.conf" || return 1
}

twg_legacy_hash() { twg_legacy_pack | sha256sum | cut -d' ' -f1; }

# --- archive: the sign-in files of the twg config directory -------------------------------

# Copies the sign-in files into $1/twg without access tokens, never touching the live files.
twg_archive_stage() {
  local live dest f
  live=$(twg_config_dir)
  dest="$1/twg"
  mkdir -p "$dest" || return 1
  for f in "${TWG_ARCHIVE_FILES[@]}"; do
    [[ -f "$live/$f" ]] || continue
    case "$f" in
      *.json) jq "$TWG_JQ_STRIP" "$live/$f" > "$dest/$f" 2>/dev/null || return 1 ;;
      *)
        tr -d '\r' < "$live/$f" | grep -v '^oauth-access-token=' > "$dest/$f"
        (( PIPESTATUS[0] == 0 && PIPESTATUS[1] <= 1 )) || return 1
        ;;
    esac
  done
}

# Whether the staged set in $1/twg holds an OAuth refresh token. Reads only a boolean.
twg_archive_has_token() {
  local d="$1/twg"
  if [[ -f "$d/auth-profiles.json" ]] && jq -e \
      '[.profiles[]? | .credentials.primary.oauthRefreshToken? | strings | select(length > 0)] | length > 0' \
      "$d/auth-profiles.json" > /dev/null 2>&1; then
    return 0
  fi
  [[ -f "$d/auth.conf" ]] && grep -q '^oauth-refresh-token=.' "$d/auth.conf"
}

# Whether twg itself sees a file-backed login profile that isn't a PAT. Reads only a boolean
# from a listing that holds no credentials, and prints nothing.
twg_archive_profiles_ok() {
  twg_cli auth profile list -o json --output-summary none 2>/dev/null | jq -e \
    '(.data.storage == "file" or .data.storage == "legacy")
       and ([.data.profiles[]? | select((.authMethod // "oauth") == "oauth")] | length > 0)' \
    > /dev/null 2>&1
}

twg_with_stage() {
  local stage rc=0
  stage=$(mktemp -d "$RUNNER_TEMP/twg-stage.XXXXXX") || return 1
  if twg_archive_stage "$stage"; then "$@" "$stage" || rc=$?; else rc=1; fi
  rm -rf "$stage"
  return "$rc"
}

twg_archive_pack_stage() {
  local stage=$1 tgz rc=0
  twg_archive_has_token "$stage" || return 1
  tgz=$(mktemp "$RUNNER_TEMP/twg-config.XXXXXX") || return 1
  tar -C "$stage" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    -czf "$tgz" twg 2>/dev/null || rc=$?
  if (( rc == 0 )); then
    { printf '%s' "$TWG_ARCHIVE_PREFIX" && base64 -w0 < "$tgz"; } || rc=1
  fi
  rm -f "$tgz"
  return "$rc"
}

# Fails, printing nothing, unless the packed set holds a refresh token.
twg_archive_pack() { twg_with_stage twg_archive_pack_stage; }

twg_archive_present() { [[ -d "$(twg_config_dir)" ]]; }

# Masks every value that could be a token in the live sign-in files: long JSON strings, and
# the values of *token*= lines.
twg_archive_mask() {
  local dir f value
  dir=$(twg_config_dir)
  for f in "${TWG_ARCHIVE_FILES[@]}"; do
    [[ -f "$dir/$f" ]] || continue
    while IFS= read -r value; do
      if [[ -n "$value" ]]; then twg_mask "$value"; fi
    done < <(jq -r '.. | strings | select(length >= 32)' "$dir/$f" 2>/dev/null || true
             tr -d '\r' < "$dir/$f" | sed -n 's/^[a-z-]*token[a-z-]*=//p')
  done
}

twg_archive_check() {
  twg_archive_mask
  twg_with_stage twg_archive_has_token && twg_archive_profiles_ok
}

# Checks the gzipped tar $1 from one listing, and sets twg_archive_members to the sign-in files
# in it and twg_archive_skipped to the count of other entries. Every entry must be a plain file
# or directory under twg/, with no "..", and a name without whitespace or escapes; anything else
# (an absolute path, a link, a device) rejects the whole archive, as does having no sign-in
# file. Other files and directories under twg/, such as caches in a seed packed from the whole
# directory, are skipped.
twg_archive_safe() {
  local tgz=$1 list rc=0 line name member
  local -a f
  twg_archive_members=()
  twg_archive_skipped=0
  list=$(mktemp "$RUNNER_TEMP/twg-list.XXXXXX") || return 1
  LC_ALL=C tar -tvzf "$tgz" > "$list" 2>/dev/null || rc=1
  while (( rc == 0 )) && IFS= read -r line; do
    read -r -a f <<< "$line"
    if (( ${#f[@]} != 6 )); then rc=1; break; fi
    name=${f[5]}
    case "$name" in twg/*) ;; *) rc=1; break ;; esac
    case "/$name/" in */../* | */./* | *\\*) rc=1; break ;; esac
    case "${f[0]}" in
      d*) [[ "$name" == twg/ ]] || twg_archive_skipped=$((twg_archive_skipped + 1)) ;;
      -*)
        case "$name" in
          twg/auth-profiles.json | twg/auth.conf)
            for member in "${twg_archive_members[@]}"; do [[ "$member" == "$name" ]] && continue 2; done
            twg_archive_members+=("$name")
            ;;
          *) twg_archive_skipped=$((twg_archive_skipped + 1)) ;;
        esac
        ;;
      *) rc=1 ;;
    esac
  done < "$list"
  rm -f "$list"
  (( rc == 0 && ${#twg_archive_members[@]} > 0 ))
}

# Decodes the value in file $1 into the gzipped tar $2, and checks it.
twg_archive_decode() {
  tr -d '\r\n' < "$1" | sed "s/^$TWG_ARCHIVE_PREFIX//" | base64 -d > "$2" 2>/dev/null \
    && twg_archive_safe "$2"
}

# Whether the packed value in file $1 decodes to the sign-in files alone.
twg_archive_value_ok() {
  local tgz rc=0
  tgz=$(mktemp "$RUNNER_TEMP/twg-config.XXXXXX") || return 1
  twg_archive_decode "$1" "$tgz" && (( twg_archive_skipped == 0 )) || rc=1
  rm -f "$tgz"
  return "$rc"
}

twg_archive_restore() {
  local raw=$1 dir tgz rc=0
  dir=$(twg_config_dir)
  tgz=$(mktemp "$RUNNER_TEMP/twg-config.XXXXXX") || return 1
  if ! twg_archive_decode "$raw" "$tgz"; then
    rm -f "$tgz"
    twg_error "$TWG_SECRET isn't a usable ${TWG_ARCHIVE_PREFIX%:} archive of the twg sign-in. Re-seed it (README.md)"
    return 1
  fi
  # The vault's sign-in files alone, with nothing left over from an earlier sign-in.
  { rm -rf "$dir" && mkdir -p "$dir" \
    && tar -C "${dir%/twg}" --no-same-owner --no-same-permissions -xzf "$tgz" \
         -- "${twg_archive_members[@]}" 2>/dev/null \
    && chmod 700 "$dir"; } || rc=1
  rm -f "$tgz"
  if (( rc != 0 )); then
    twg_error "could not unpack $TWG_SECRET into the twg config directory"
    return 1
  fi
  if ! twg_archive_check; then
    twg_error "$TWG_SECRET holds no OAuth refresh token, or twg sees no file-backed OAuth login in it. Re-seed it (README.md)"
    return 1
  fi
}

twg_archive_hash_stage() {
  (cd "$1" && find twg -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1)
}

# The staged files' names and contents only, so neither tar metadata, caches nor access-token
# churn count as a change.
twg_archive_hash() { twg_with_stage twg_archive_hash_stage; }

# --- either format ------------------------------------------------------------------------

twg_restore() { "twg_$1_restore" "$2"; }
twg_present() { "twg_$(twg_format)_present"; }
twg_check() { "twg_$(twg_format)_check"; }
twg_pack() { "twg_$(twg_format)_pack"; }
twg_hash() { "twg_$(twg_format)_hash"; }

# What's missing when twg_check fails, for the error.
twg_check_failure() {
  if [[ "$(twg_format)" == archive ]]; then
    echo "the twg sign-in holds no OAuth refresh token, or twg sees no file-backed OAuth login"
  else
    echo "auth.conf holds no oauth-refresh-token"
  fi
}

# From a file, because --value would put the sign-in on a command line, and to /dev/null,
# because `secret set` echoes the value it stored. Leaves the az error in $twg_err and the
# value's size in $twg_stored_bytes.
twg_store() {
  local tmp rc=0
  twg_stored_bytes=0
  : > "$twg_err"
  if ! twg_check; then
    twg_error "$(twg_check_failure), so the twg sign-in wasn't stored"
    return 1
  fi
  tmp=$(mktemp "$RUNNER_TEMP/twg-auth.XXXXXX") || return 1
  if twg_pack > "$tmp"; then
    twg_stored_bytes=$(wc -c < "$tmp")
    if (( twg_stored_bytes > TWG_SECRET_MAX_BYTES )); then
      twg_error "the packed twg sign-in is $twg_stored_bytes bytes, over Key Vault's $TWG_SECRET_MAX_BYTES-byte limit for a secret"
      rc=1
    elif [[ "$(twg_format)" == archive ]] && ! twg_archive_value_ok "$tmp"; then
      twg_error "the packed twg sign-in didn't decode to the sign-in files alone, so it wasn't stored"
      rc=1
    else
      if [[ "$(twg_format)" == archive ]]; then twg_mask "$(< "$tmp")"; fi
      az keyvault secret set --vault-name "$TWG_VAULT" --name "$TWG_SECRET" \
        --file "$tmp" --encoding utf-8 > /dev/null 2> "$twg_err" || rc=$?
    fi
  else
    twg_error "could not pack the twg sign-in, or the packed set holds no OAuth refresh token"
    rc=1
  fi
  rm -f "$tmp"
  return "$rc"
}
