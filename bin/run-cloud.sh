#!/bin/bash
# run-cloud.sh - Run a benchmark on Grafana Cloud with 'k6 cloud run', so the
# resulting test is re-runnable from the UI's Run button.
#
# Why this exists: the REST-API-synced tests ( from sync-cloud-tests.pl /
# new-cloud-project.pl ) store only a script, no archive - so the UI Run button
# won't run them, it just prints the CLI command. 'k6 cloud run' uploads an
# archive, which the UI CAN re-run. This wraps it: reads CLOUD_PROJECT_ID and
# the per-server settings from .env, names the cloud test with its friendly
# name ( matching the sync tool ), and fires the run.
#
# Usage:
#   ./bin/run-cloud.sh koha_training_browser.js
#   ./bin/run-cloud.sh aspen_http.js --project 8112621
#   ./bin/run-cloud.sh aspen_http.js --project PWPL      # by name ( "Stress Testing - " prefix added )
#   ./bin/run-cloud.sh --list                 # show the script -> test-name map
#
# Needs 'k6 cloud login --token <token>' first, and a project - either
# CLOUD_PROJECT_ID or CLOUD_PROJECT_NAME in .env, or --project <id-or-name>. A
# name is resolved to its id via the k6 Cloud API ( matched as given or with the
# "Stress Testing - " prefix ), so you needn't store the number. After the first
# run, re-run it from the UI Run button.

set -e

SCRIPT_DIR="$(dirname "$0")"
PROJECT_DIR="$SCRIPT_DIR/.."
ENV_FILE="$PROJECT_DIR/.env"

# script file -> friendly cloud test name ( matches sync-cloud-tests.pl @SYNC_TESTS )
map_name() {
    case "$1" in
        koha_opac_http.js)         echo "OPAC Stress Test - HTTP Only" ;;
        koha_opac_browser.js)      echo "OPAC Stress Test - Browser" ;;
        koha_steady_state.js)      echo "Daily Operations" ;;
        koha_training_protocol.js) echo "Training Simulation - HTTP Only" ;;
        koha_training_browser.js)  echo "Training Simulation - End to End" ;;
        aspen_http.js)             echo "Aspen Stress Test - HTTP Only" ;;
        aspen_browser.js)          echo "Aspen Stress Test - Browser" ;;
        *)                         echo "" ;;
    esac
}
ALL_SCRIPTS="koha_opac_http.js koha_opac_browser.js koha_steady_state.js koha_training_protocol.js koha_training_browser.js aspen_http.js aspen_browser.js"

if [ "$1" == "--list" ]; then
    echo "script -> cloud test name:"
    for s in $ALL_SCRIPTS; do printf "  %-28s -> %s\n" "$s" "$(map_name "$s")"; done
    exit 0
fi

# Parse flags + the script argument
PROJECT_OVERRIDE=""
BENCH=""
while [ -n "$1" ]; do
    case "$1" in
        --project) PROJECT_OVERRIDE="$2"; shift 2 ;;
        --*) echo "Unknown flag: $1"; exit 1 ;;
        *) BENCH="$1"; shift ;;
    esac
done

if [ -z "$BENCH" ]; then
    echo "Usage: $0 <script.js> [--project ID]   ( --list to see the test names )"
    exit 1
fi

SCRIPT_PATH="$PROJECT_DIR/benchmarks/$BENCH"
if [ ! -f "$SCRIPT_PATH" ]; then
    echo "Error: script not found: $SCRIPT_PATH"
    echo "Available:"; ls -1 "$PROJECT_DIR/benchmarks/"*.js 2>/dev/null | xargs -n1 basename
    exit 1
fi

TEST_NAME="$(map_name "$BENCH")"
[ -z "$TEST_NAME" ] && TEST_NAME="${BENCH%.js}"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env not found ( copy env-template to .env and configure it )"
    exit 1
fi

# Read .env into KEY=value entries ( plain indexed array - macOS ships bash 3.2,
# which has no associative arrays ).
ENV_LINES=()
while IFS='=' read -r key value; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    key=$(echo "$key" | xargs)
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    ENV_LINES+=("$key=$value")
done < "$ENV_FILE"

env_val() {
    local entry
    for entry in "${ENV_LINES[@]}"; do
        [[ "${entry%%=*}" == "$1" ]] && { echo "${entry#*=}"; return; }
    done
    echo "$2"
}

# Resolve a project name-or-id to a numeric id. All-digits passes through; a
# name is looked up via the k6 Cloud API ( cloud/v5/projects ), so you can pass
# --project "Stress Testing - PWPL" or set CLOUD_PROJECT_NAME instead of storing
# the numeric id. Uses the 'k6 cloud login' token; stdlib only.
resolve_project() {
    local want="$1"
    if [[ "$want" =~ ^[0-9]+$ ]]; then echo "$want"; return; fi
    python3 - "$want" <<'PY'
import json, os, sys, urllib.request
want = sys.argv[1]
cfg = os.path.expanduser("~/Library/Application Support/k6/config.json")
tok = json.load(open(cfg))["collectors"]["cloud"]["token"]
def api(url):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
    return json.load(urllib.request.urlopen(req))
# Match the name as given, or with the "Stress Testing - " prefix that
# new-cloud-project.pl adds - so "PWPL" finds "Stress Testing - PWPL".
targets = (want, "Stress Testing - " + want)
pid = None
for o in api("https://api.k6.io/v3/organizations").get("organizations", []):
    try:
        resp = api("https://api.k6.io/cloud/v5/projects?organization_id=%s" % o["id"])
        projects = resp.get("value") or resp.get("projects") or []
    except Exception:
        continue
    for p in projects:
        if p.get("name") in targets:
            pid = p["id"]; break
    if pid:
        break
if pid is None:
    sys.exit(3)
print(pid)
PY
}

PROJECT_RAW="${PROJECT_OVERRIDE:-$(env_val CLOUD_PROJECT_ID "$(env_val CLOUD_PROJECT_NAME "")")}"
if [ -z "$PROJECT_RAW" ]; then
    echo "Error: no project. Set CLOUD_PROJECT_ID or CLOUD_PROJECT_NAME in .env, or pass --project <id-or-name>."
    exit 1
fi
PROJECT_ID="$(resolve_project "$PROJECT_RAW")" || {
    echo "Error: could not find a project named '$PROJECT_RAW' for this token."
    exit 1
}

# Build the -e args: the friendly name + project win, then every .env var -
# EXCEPT secrets. Passing a secret via -e would bake it into the cloud archive;
# instead the scripts resolve them from the org-wide Grafana secrets at runtime
# ( leave STAFF_PASS/EXTERNAL_SERVICE_TOKEN blank and they call secrets.get() ),
# same as the sync-baked tests.
K6_ARGS=("-e" "CLOUD_TEST_NAME=$TEST_NAME" "-e" "CLOUD_PROJECT_ID=$PROJECT_ID")
for entry in "${ENV_LINES[@]}"; do
    key="${entry%%=*}"; value="${entry#*=}"
    case "$key" in
        UID|GID|K6_IMAGE_TAG|BENCH|CLOUD_TEST_NAME|CLOUD_PROJECT_ID) continue ;;
        STAFF_PASS|EXTERNAL_SERVICE_TOKEN|SOLR_PASS|TRAINING_USER_PASS) continue ;;  # secrets - resolve from org, don't bake
    esac
    [[ -z "$value" ]] && continue
    K6_ARGS+=("-e" "$key=$value")
done

echo "=========================================="
echo "k6 cloud run: $BENCH"
echo "  cloud test: $TEST_NAME"
echo "  project:    $PROJECT_ID"
echo "  ( once this run finishes, the UI Run button re-runs it )"
echo "=========================================="
echo ""
exec k6 cloud run "${K6_ARGS[@]}" "$SCRIPT_PATH"
