#!/bin/bash
# Push the benchmark scripts up to Grafana Cloud as SCRIPT-EDITOR tests, so
# other people can run them from the web UI against any server: they open a
# test, clone it ( Save as… ), edit the values marked "<<< SET" at the top of
# the script, and click Run.
#
# These are script-editor tests ( the script text lives in the test and is
# editable/clonable in the browser ), NOT CLI archive tests - so this uses the
# k6 Cloud REST API to create/update each test's script, keyed by
# ( project, name ). Re-running updates the script in place; it never touches
# a clone someone made.
#
# Usage:
#   ./bin/sync-cloud-tests.sh                 # create/update all templates
#   ./bin/sync-cloud-tests.sh --dry-run       # show what would change, do nothing
#   ./bin/sync-cloud-tests.sh opac daily      # only tests whose script/name matches
#   ./bin/sync-cloud-tests.sh --project 12345 # override CLOUD_PROJECT_ID
#   ./bin/sync-cloud-tests.sh --env prod.env  # read CLOUD_PROJECT_ID from another file
#
# Auth: reuses the token from 'k6 cloud login' ( ~/Library/Application Support/
# k6/config.json ). Run that once first.

set -e

SCRIPT_DIR="$(dirname "$0")"
PROJECT_DIR="$SCRIPT_DIR/.."
BENCH_DIR="$PROJECT_DIR/benchmarks"

# script file | cloud test name. These names are the templates people clone.
SYNC_TESTS=(
    "koha_opac_http.js|OPAC Stress Test - HTTP Only"
    "koha_steady_state.js|Daily Operations"
    "koha_training_protocol.js|Training Simulation - HTTP Only"
    "koha_training_browser.js|Training Simulation - End to End"
)

ENV_FILE="$PROJECT_DIR/.env"
PROJECT_OVERRIDE=""
DRY_RUN=""
FILTERS=()

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

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

# Project id: --project wins, else CLOUD_PROJECT_ID from the env file
PROJECT_ID="$PROJECT_OVERRIDE"
if [ -z "$PROJECT_ID" ] && [ -f "$ENV_FILE" ]; then
    PROJECT_ID=$(grep -E '^[[:space:]]*CLOUD_PROJECT_ID[[:space:]]*=' "$ENV_FILE" | head -1 | cut -d= -f2- | xargs)
fi
if [ -z "$PROJECT_ID" ]; then
    echo "Error: no project id. Set CLOUD_PROJECT_ID in $ENV_FILE or pass --project <id>." >&2
    exit 1
fi

# The k6 CLI stores its cloud token here after 'k6 cloud login'.
K6_CONFIG="$HOME/Library/Application Support/k6/config.json"
if [ ! -f "$K6_CONFIG" ]; then
    echo "Error: k6 config not found at $K6_CONFIG - run 'k6 cloud login --token <token>' first." >&2
    exit 1
fi

# Build a newline-separated "file<TAB>name" list, applying any positional
# filters ( substring match against either field ), and hand it to python for
# the REST work ( JSON assembly + create/update is far cleaner there ).
selected=""
for entry in "${SYNC_TESTS[@]}"; do
    file="${entry%%|*}"; name="${entry#*|}"
    if [ ${#FILTERS[@]} -gt 0 ]; then
        keep=""
        for f in "${FILTERS[@]}"; do
            case "$file|$name" in *"$f"*) keep=1 ;; esac
        done
        [ -z "$keep" ] && continue
    fi
    selected+="${file}	${name}"$'\n'
done

SYNC_PROJECT_ID="$PROJECT_ID" \
SYNC_DRY_RUN="$DRY_RUN" \
SYNC_BENCH_DIR="$BENCH_DIR" \
SYNC_K6_CONFIG="$K6_CONFIG" \
SYNC_SELECTED="$selected" \
python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error

API = "https://api.k6.io/loadtests/v2/tests"
project_id = int(os.environ["SYNC_PROJECT_ID"])
dry = bool(os.environ.get("SYNC_DRY_RUN"))
bench_dir = os.environ["SYNC_BENCH_DIR"]
selected = [l.split("\t") for l in os.environ["SYNC_SELECTED"].splitlines() if l.strip()]

with open(os.environ["SYNC_K6_CONFIG"]) as f:
    token = json.load(f)["collectors"]["cloud"]["token"]
HDRS = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}

def call(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=HDRS, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]

# Existing tests in the project, name -> id
status, listing = call("GET", f"{API}?project_id={project_id}&page_size=100")
existing = {}
if isinstance(listing, dict):
    for t in (listing.get("k6-tests") or []):
        tt = t.get("k6-test", t)
        existing[tt.get("name")] = tt.get("id")

print("=" * 42)
print(f"Syncing script-editor templates  (project {project_id})")
if dry:
    print("  DRY RUN - nothing will be written")
print("=" * 42)

fails = 0
for file, name in selected:
    path = os.path.join(bench_dir, file)
    if not os.path.exists(path):
        print(f"\n>> SKIP  {name}  (script not found: {file})"); fails += 1; continue
    with open(path) as fh:
        script = fh.read()

    tid = existing.get(name)
    action = "update" if tid else "create"
    print(f"\n>> {name}\n   {file}  ->  {action}" + (f" (id {tid})" if tid else ""))
    if dry:
        continue

    if tid:
        st, resp = call("PATCH", f"{API}/{tid}", {"script": script})
    else:
        st, resp = call("POST", API, {"name": name, "project_id": project_id, "script": script})
        if st == 200 and isinstance(resp, dict):
            tid = (resp.get("k6-test", resp) or {}).get("id")

    if st == 200:
        print(f"   OK  https://bws.grafana.net/a/k6-app/tests/{tid}")
    else:
        print(f"   FAILED  HTTP {st}: {resp}"); fails += 1

print("\n" + "=" * 42)
print(f"Done: {len(selected) - fails} synced, {fails} failed")
print("=" * 42)
sys.exit(1 if fails else 0)
PY
