#!/bin/bash
# Sync the benchmark scripts up to Grafana Cloud as CLI-managed k6 tests.
#
# Each script edit in benchmarks/*.js can be pushed to its cloud test with one
# command, instead of re-pasting into the web script editor. 'k6 cloud upload'
# keys a test by (project, name): re-uploading the same name updates that test
# in place, so running this repeatedly keeps the cloud copy in lockstep with
# the repo.
#
# IMPORTANT: this only works for tests that were CREATED BY THE CLI. A test
# created in the web editor ("in the App") rejects archive uploads with
#   (400/E2) Archive upload is not allowed for test created in the App
# so a colliding App test must be deleted in the GUI first (see --help).
#
# Usage:
#   ./bin/sync-cloud-tests.sh                 # sync all tests, config from .env
#   ./bin/sync-cloud-tests.sh --dry-run       # print the k6 commands, run nothing
#   ./bin/sync-cloud-tests.sh --env prod.env  # use a different config file
#   ./bin/sync-cloud-tests.sh opac steady     # only tests whose script/name matches
#   ./bin/sync-cloud-tests.sh --project 12345 # override CLOUD_PROJECT_ID
#
# Needs 'k6 cloud login --token <token>' once first (token from the Grafana
# Cloud k6 app, e.g. https://bws.grafana.net/a/k6-app).

set -e

SCRIPT_DIR="$(dirname "$0")"
PROJECT_DIR="$SCRIPT_DIR/.."
BENCH_DIR="$PROJECT_DIR/benchmarks"

# script file | cloud test name. Uploading with these names updates the
# matching CLI-managed test in place. Edit this table to add/rename tests.
SYNC_TESTS=(
    "koha_opac_http.js|OPAC Stress Test - HTTP Only"
    "koha_steady_state.js|Daily Operations"
    "koha_training_protocol.js|Training Simulation - HTTP Only"
    "koha_training_browser.js|Training Simulation - End to End"
)

# Defaults, overridable by flags
ENV_FILE="$PROJECT_DIR/.env"
PROJECT_OVERRIDE=""
DRY_RUN=""
FILTERS=()

usage() {
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)      ENV_FILE="$2"; shift 2 ;;
        --project)  PROJECT_OVERRIDE="$2"; shift 2 ;;
        --dry-run)  DRY_RUN="1"; shift ;;
        -h|--help)  usage 0 ;;
        --*)        echo "Unknown flag: $1" >&2; usage 1 ;;
        *)          FILTERS+=("$1"); shift ;;
    esac
done

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: env file not found: $ENV_FILE" >&2
    echo "Copy env-templates/steady-state.env (or another) to .env and configure it." >&2
    exit 1
fi

# Read all non-comment, non-empty lines from the env file into 'KEY=value'
# entries. Plain indexed array + lookup helper, because macOS ships bash 3.2
# which has no associative arrays. (Same parser as run-with-env.sh.)
ENV_LINES=()
while IFS='=' read -r key value; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    key=$(echo "$key" | xargs)
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    ENV_LINES+=("$key=$value")
done < "$ENV_FILE"

env_val() {
    local entry
    for entry in "${ENV_LINES[@]}"; do
        if [[ "${entry%%=*}" == "$1" ]]; then echo "${entry#*=}"; return; fi
    done
    echo "$2"
}

# Resolve the project id: --project wins, else CLOUD_PROJECT_ID from the env file
PROJECT_ID="$PROJECT_OVERRIDE"
[ -z "$PROJECT_ID" ] && PROJECT_ID="$(env_val CLOUD_PROJECT_ID)"
if [ -z "$PROJECT_ID" ]; then
    echo "Error: no project id. Set CLOUD_PROJECT_ID in $ENV_FILE or pass --project <id>." >&2
    exit 1
fi

# True if the entry matches one of the positional filters (script or name
# substring). No filters given => everything matches.
matches_filter() {
    [ ${#FILTERS[@]} -eq 0 ] && return 0
    local hay="$1" f
    for f in "${FILTERS[@]}"; do
        [[ "$hay" == *"$f"* ]] && return 0
    done
    return 1
}

echo "=========================================="
echo "Syncing cloud tests  (project $PROJECT_ID)"
echo "  config: $ENV_FILE"
[ -n "$DRY_RUN" ] && echo "  DRY RUN - nothing will be uploaded"
echo "=========================================="

fail_count=0
done_count=0

for entry in "${SYNC_TESTS[@]}"; do
    script="${entry%%|*}"
    name="${entry#*|}"

    matches_filter "$script|$name" || continue

    script_path="$BENCH_DIR/$script"
    if [ ! -f "$script_path" ]; then
        echo ">> SKIP  $name  (script not found: $script)"
        fail_count=$((fail_count + 1))
        continue
    fi

    # Build -e flags from every env var, forcing the per-test name and project.
    K6_ARGS=()
    for e in "${ENV_LINES[@]}"; do
        k="${e%%=*}"; v="${e#*=}"
        case "$k" in
            UID|GID|K6_IMAGE_TAG|BENCH|OUTPUT_DIR|TEST_NUMBER) continue ;;
            CLOUD_TEST_NAME|CLOUD_PROJECT_ID) continue ;;  # forced below
            # Cloud runs read these from Grafana secrets (named by
            # EXTERNAL_SERVICE_TOKEN_SECRET / STAFF_PASS_SECRET), so keep the raw
            # token and password out of the uploaded archive. Requires the
            # 'x-grafana-cloud-external-service-token' and 'staff-pass' secrets
            # to exist in the project.
            EXTERNAL_SERVICE_TOKEN|STAFF_PASS) continue ;;
        esac
        [[ -z "$v" ]] && continue
        K6_ARGS+=("-e" "$k=$v")
    done
    K6_ARGS+=("-e" "CLOUD_PROJECT_ID=$PROJECT_ID")
    K6_ARGS+=("-e" "CLOUD_TEST_NAME=$name")

    echo ""
    echo ">> $name"
    echo "   $script"

    if [ -n "$DRY_RUN" ]; then
        printf '   k6 cloud upload'
        printf ' %q' "${K6_ARGS[@]}" "$script_path"
        printf '\n'
        done_count=$((done_count + 1))
        continue
    fi

    # Capture output so we can surface the run URL or the App-collision error.
    out="$(k6 cloud upload "${K6_ARGS[@]}" "$script_path" 2>&1)" || true
    run_url="$(printf '%s\n' "$out" | sed -E 's/\x1b\[[0-9;]*m//g' | grep -oE 'https://[^ ]*/runs/[0-9]+' | head -1)"

    if [ -n "$run_url" ]; then
        echo "   OK  -> $run_url"
        done_count=$((done_count + 1))
    elif printf '%s' "$out" | grep -q 'not allowed for test created in the App'; then
        echo "   FAILED  a test named '$name' already exists in the App (web editor)."
        echo "           Delete it in the GUI, then re-run this script to create the"
        echo "           CLI-managed replacement."
        fail_count=$((fail_count + 1))
    else
        echo "   FAILED  $(printf '%s' "$out" | sed -E 's/\x1b\[[0-9;]*m//g' | grep -iE 'error|level=' | head -1)"
        fail_count=$((fail_count + 1))
    fi
done

echo ""
echo "=========================================="
echo "Done: $done_count synced, $fail_count failed"
echo "=========================================="
[ "$fail_count" -eq 0 ]
