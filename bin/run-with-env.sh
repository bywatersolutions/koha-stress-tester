#!/bin/bash
# K6 local test runner (requires k6 binary installed)
# Reads configuration from .env and passes all vars to k6
#
# Usage:
#   ./bin/run-with-env.sh                  # Uses BENCH from .env
#   ./bin/run-with-env.sh solr_http.js     # Override script
#   ./bin/run-with-env.sh aspen_http.js

set -e

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

# Read all non-comment, non-empty lines from .env
declare -A ENV_VARS
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
    ENV_VARS["$key"]="$value"
done < "$ENV_FILE"

# Determine which script to run
if [ -n "$1" ]; then
    BENCH="$1"
else
    BENCH="${ENV_VARS[BENCH]:-solr_http.js}"
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
for key in "${!ENV_VARS[@]}"; do
    value="${ENV_VARS[$key]}"
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
        echo "  SOLR_URL: ${ENV_VARS[SOLR_URL]:-not set}"
        echo "  SOLR_CORE: ${ENV_VARS[SOLR_CORE]:-not set}"
        echo "  MAX_VUS: ${ENV_VARS[MAX_VUS]:-150}"
        ;;
    aspen_http.js)
        echo "  BASE_URL: ${ENV_VARS[BASE_URL]:-not set}"
        echo "  HOST_HEADER: ${ENV_VARS[HOST_HEADER]:-not set}"
        echo "  MAX_VUS: ${ENV_VARS[MAX_VUS]:-150}"
        ;;
    aspen_browser.js|koha.js)
        echo "  BASE_URL: ${ENV_VARS[BASE_URL]:-not set}"
        echo "  VUS: ${ENV_VARS[VUS]:-1}"
        echo "  ITERATIONS: ${ENV_VARS[ITERATIONS]:-1}"
        echo "  K6_BROWSER_HEADLESS: ${ENV_VARS[K6_BROWSER_HEADLESS]:-true}"
        ;;
esac
echo "  Output: $OUTPUT_DIR/"
echo "=========================================="
echo ""

# Run k6
exec k6 run "${K6_ARGS[@]}" "$SCRIPT_PATH"

