#!/bin/bash
# K6 local test runner (requires k6 binary installed)
# Reads configuration from .env and passes all vars to k6
#
# Usage:
#   ./bin/run-with-env.sh                          # Uses BENCH from .env
#   ./bin/run-with-env.sh solr_http.js             # Override script
#   ./bin/run-with-env.sh aspen_http.js
#   ./bin/run-with-env.sh --cloud                  # Run on Grafana Cloud runners (k6 cloud run)
#   ./bin/run-with-env.sh --cloud-output           # Run locally, stream results to Grafana Cloud (k6 run -o cloud)
#
# Cloud modes need 'k6 cloud login --token <token>' first (token from the
# Grafana Cloud k6 app under your stack, e.g. https://bws.grafana.net/a/k6-app).

set -e

CLOUD_MODE=""
while [[ "$1" == --* ]]; do
    case "$1" in
        --cloud) CLOUD_MODE="run" ;;
        --cloud-output) CLOUD_MODE="output" ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
    shift
done

SCRIPT_DIR="$(dirname "$0")"
PROJECT_DIR="$SCRIPT_DIR/.."
ENV_FILE="$PROJECT_DIR/.env"

# Check for .env
if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env file not found"
    echo "Copy env-template to .env and configure it first."
    exit 1
fi

echo "Loading configuration from .env..."

# Read all non-comment, non-empty lines from .env into 'KEY=value' entries.
# Plain indexed array + lookup helper, because macOS ships bash 3.2 which
# has no associative arrays.
ENV_LINES=()
while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    # Remove leading/trailing whitespace from key
    key=$(echo "$key" | xargs)
    # Store the value (preserve spaces, remove surrounding quotes if present)
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    ENV_LINES+=("$key=$value")
done < "$ENV_FILE"

# env_val KEY [default] - print the value of KEY from .env, or the default
env_val() {
    local entry
    for entry in "${ENV_LINES[@]}"; do
        if [[ "${entry%%=*}" == "$1" ]]; then
            echo "${entry#*=}"
            return
        fi
    done
    echo "$2"
}

# Determine which script to run
if [ -n "$1" ]; then
    BENCH="$1"
else
    BENCH="$(env_val BENCH solr_http.js)"
fi

# Check if script exists
SCRIPT_PATH="$PROJECT_DIR/benchmarks/$BENCH"
if [ ! -f "$SCRIPT_PATH" ]; then
    echo "Error: Script not found: $SCRIPT_PATH"
    echo "Available scripts:"
    ls -1 "$PROJECT_DIR/benchmarks/"*.js 2>/dev/null | xargs -n1 basename
    exit 1
fi

# Ensure output directory exists
OUTPUT_DIR="$PROJECT_DIR/output"
mkdir -p "$OUTPUT_DIR"

# Generate test number
TEST_NUM=$(find "$OUTPUT_DIR" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l)
TEST_NUM=$((TEST_NUM + 1))
TEST_NUM=$(printf "%03d" $TEST_NUM)

# Build the k6 command with -e flags
K6_ARGS=()

# Add output directory and test number
K6_ARGS+=("-e" "OUTPUT_DIR=$OUTPUT_DIR")
K6_ARGS+=("-e" "TEST_NUMBER=$TEST_NUM")

# Add each env var as a -e flag
for entry in "${ENV_LINES[@]}"; do
    key="${entry%%=*}"
    value="${entry#*=}"
    # Skip Docker-specific vars
    [[ "$key" == "UID" ]] && continue
    [[ "$key" == "GID" ]] && continue
    [[ "$key" == "K6_IMAGE_TAG" ]] && continue
    [[ "$key" == "BENCH" ]] && continue
    [[ "$key" == "OUTPUT_DIR" ]] && continue  # Already set above
    [[ "$key" == "TEST_NUMBER" ]] && continue  # Already set above
    # Skip empty values
    [[ -z "$value" ]] && continue
    K6_ARGS+=("-e" "$key=$value")
done

# Display config
echo "=========================================="
echo "Running: $BENCH (Test #$TEST_NUM)"
echo "=========================================="

# Show key settings based on script type
case "$BENCH" in
    solr_http.js)
        echo "  SOLR_URL: $(env_val SOLR_URL "not set")"
        echo "  SOLR_CORE: $(env_val SOLR_CORE "not set")"
        echo "  MAX_VUS: $(env_val MAX_VUS 150)"
        ;;
    aspen_http.js)
        echo "  BASE_URL: $(env_val BASE_URL "not set")"
        echo "  HOST_HEADER: $(env_val HOST_HEADER "not set")"
        echo "  MAX_VUS: $(env_val MAX_VUS 150)"
        ;;
    aspen_browser.js|koha.js)
        echo "  BASE_URL: $(env_val BASE_URL "not set")"
        echo "  VUS: $(env_val VUS 1)"
        echo "  ITERATIONS: $(env_val ITERATIONS 1)"
        echo "  K6_BROWSER_HEADLESS: $(env_val K6_BROWSER_HEADLESS true)"
        ;;
    koha_training_browser.js)
        echo "  STAFF_URL: $(env_val STAFF_URL "not set")"
        echo "  LIBRARIANS: $(env_val LIBRARIANS 75)"
        echo "  STEP_INTERVAL_S: $(env_val STEP_INTERVAL_S 90)"
        echo "  K6_BROWSER_HEADLESS: $(env_val K6_BROWSER_HEADLESS true)"
        ;;
esac
if [ -n "$CLOUD_MODE" ]; then
    echo "  Cloud mode: $([ "$CLOUD_MODE" == "run" ] && echo "Grafana Cloud runners" || echo "local run, cloud output")"
fi
echo "  Output: $OUTPUT_DIR/"
echo "=========================================="
echo ""

# Run k6
if [ "$CLOUD_MODE" == "run" ]; then
    exec k6 cloud run "${K6_ARGS[@]}" "$SCRIPT_PATH"
elif [ "$CLOUD_MODE" == "output" ]; then
    exec k6 run -o cloud "${K6_ARGS[@]}" "$SCRIPT_PATH"
else
    exec k6 run "${K6_ARGS[@]}" "$SCRIPT_PATH"
fi

