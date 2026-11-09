#!/usr/bin/env bash
# Makes the PCS roadmap generator available at vendor/cft-workspace.
#
# The generator (apps/pcs/.claude/scripts/lib/roadmap/roadmap-runner.ts) lives in the private
# hmcts/cft-workspace repo. CI checks it out at the commit in cft-workspace.ref (see
# .github/workflows/publish.yml). Locally, point CFT_WORKSPACE at your own checkout:
#
#   CFT_WORKSPACE=~/work/cft-workspace npm run vendor
#
# Either way this then installs the generator's own dependency (pdfkit) beside it.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ref="$(cat cft-workspace.ref)"
vendor=vendor/cft-workspace
runner_dir=apps/pcs/.claude/scripts/lib/roadmap

if [[ -n "${CFT_WORKSPACE:-}" ]]; then
    [[ -f "$CFT_WORKSPACE/workspace.yaml" ]] || { echo "CFT_WORKSPACE=$CFT_WORKSPACE is not a cft-workspace checkout" >&2; exit 1; }
    mkdir -p vendor
    ln -sfn "$(cd "$CFT_WORKSPACE" && pwd)" "$vendor"
    if ! git -C "$vendor" diff --quiet "$ref" -- "$runner_dir" 2>/dev/null; then
        echo "warning: $runner_dir in $CFT_WORKSPACE differs from the pinned commit ${ref:0:7}" >&2
    fi
fi

[[ -f "$vendor/$runner_dir/roadmap-runner.ts" ]] || {
    echo "no roadmap generator at $vendor/$runner_dir. Set CFT_WORKSPACE to a cft-workspace checkout." >&2
    exit 1
}

if [[ ! -d "$vendor/$runner_dir/node_modules/pdfkit" ]]; then
    # A subshell, not --prefix: under `npm run`, npm would resolve --prefix against this project.
    (cd "$vendor/$runner_dir" && env -u npm_config_local_prefix npm ci --omit=dev --no-audit --no-fund --loglevel=error)
fi
echo "roadmap generator ready at $vendor/$runner_dir"
