#!/bin/bash
# K6 Helm test runner for solr_http.js
# Reads Solr configuration from ../.env
#
# Usage:
#   1. Configure ../.env with SOLR_URL, SOLR_CORE, etc.
#   2. Run: ./run-test.sh
#
# Prerequisites (if using auth):
#   kubectl create secret generic solr-credentials \
#     --from-literal=password=PASS -n k6-tests

set -e

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    helm uninstall "$RELEASE" -n "$NAMESPACE" 2>/dev/null || true
    [ -n "$TEMP_LOG" ] && rm -f "$TEMP_LOG"
    echo "Done."
}
trap cleanup EXIT INT TERM

SCRIPT_DIR="$(dirname "$0")"
ENV_FILE="$SCRIPT_DIR/../.env"
CHART_DIR="$SCRIPT_DIR/k6-benchmark"
RELEASE="k6-bench"

# Load only the variables we need from .env (avoids readonly UID conflict)
if [ -f "$ENV_FILE" ]; then
    echo "Loading configuration from .env..."
    eval "$(grep -E '^(K6_NAMESPACE|SOLR_URL|SOLR_CORE|SOLR_USER|SOLR_PASS|SOLR_SECRET|SOLR_SECRET_KEY|MAX_VUS|VU_STEP|RAMP_TIME|HOLD_TIME)=' "$ENV_FILE" | grep -v '^#')"
else
    echo "Error: .env file not found at $ENV_FILE"
    echo "Copy env-template to .env and configure it first."
    exit 1
fi

# Default namespace if not set
NAMESPACE="${K6_NAMESPACE:-k6-tests}"

# Validate required vars
if [ -z "$SOLR_URL" ] || [ -z "$SOLR_CORE" ]; then
    echo "Error: SOLR_URL and SOLR_CORE must be set in .env"
    exit 1
fi

# Create namespace if needed
kubectl create namespace "$NAMESPACE" 2>/dev/null || true

# Clean up any previous run
helm uninstall "$RELEASE" -n "$NAMESPACE" 2>/dev/null || true
kubectl delete job -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE" --ignore-not-found=true 2>/dev/null

# Build helm install command
echo "Starting k6 load test..."
echo "  NAMESPACE=$NAMESPACE"
echo "  SOLR_URL=$SOLR_URL"
echo "  SOLR_CORE=$SOLR_CORE"
[ -n "$SOLR_USER" ] && echo "  SOLR_USER=$SOLR_USER"
[ -n "$SOLR_SECRET" ] && echo "  SOLR_SECRET=$SOLR_SECRET (key: ${SOLR_SECRET_KEY:-password})"
[ -n "$MAX_VUS" ] && echo "  MAX_VUS=$MAX_VUS"

helm install "$RELEASE" "$CHART_DIR" -n "$NAMESPACE" \
    --set namespace="$NAMESPACE" \
    --set solr.url="$SOLR_URL" \
    --set solr.core="$SOLR_CORE" \
    ${SOLR_SECRET:+--set solr.existingSecret="$SOLR_SECRET"} \
    ${SOLR_SECRET_KEY:+--set solr.existingSecretKey="$SOLR_SECRET_KEY"} \
    ${SOLR_USER:+--set solr.user="$SOLR_USER"} \
    ${SOLR_PASS:+--set solr.pass="$SOLR_PASS"} \
    ${MAX_VUS:+--set test.maxVUs="$MAX_VUS"} \
    ${VU_STEP:+--set test.vuStep="$VU_STEP"} \
    ${RAMP_TIME:+--set test.rampTime="$RAMP_TIME"} \
    ${HOLD_TIME:+--set test.holdTime="$HOLD_TIME"}

# Wait for pod to be ready and stream logs
echo "Waiting for pod..."
kubectl wait --for=condition=Ready pod -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE" --timeout=60s 2>/dev/null || true

# Create output directory and set output file path
OUTPUT_DIR="$SCRIPT_DIR/../output"
mkdir -p "$OUTPUT_DIR"
TEST_NUM=$(find "$OUTPUT_DIR" -name "helm-solr-*.json" 2>/dev/null | wc -l)
TEST_NUM=$((TEST_NUM + 1))
TEST_NUM=$(printf "%03d" $TEST_NUM)
TIMESTAMP=$(date +%Y%m%d-%H%M)
OUTPUT_FILE="$OUTPUT_DIR/helm-solr-${TEST_NUM}-${TIMESTAMP}.json"

# Stream logs in real-time while polling for completion in background
TEMP_LOG=$(mktemp)
echo "=========================================="

# Wait for pod to be ready
POD=""
for i in $(seq 1 30); do
    POD=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE" -o jsonpath="{.items[0].metadata.name}" 2>/dev/null)
    [ -n "$POD" ] && break
    sleep 1
done

if [ -z "$POD" ]; then
    echo "Error: Pod not found"
    exit 1
fi

# Poll for summary.json in background and copy when ready
(
    for i in $(seq 1 600); do
        if kubectl exec -n "$NAMESPACE" "$POD" -- test -f /tmp/summary.json 2>/dev/null; then
            sleep 1
            kubectl cp "$NAMESPACE/$POD:/tmp/summary.json" "$OUTPUT_FILE" 2>&1 | grep -v "tar: removing leading"
            exit 0
        fi
        sleep 1
    done
) &
POLL_PID=$!

# Stream logs in foreground (real-time)
kubectl logs -f -n "$NAMESPACE" "$POD" 2>/dev/null | tee "$TEMP_LOG" || true

# Wait for background copy to finish
wait $POLL_PID 2>/dev/null || true

# Show output file location
[ -f "$OUTPUT_FILE" ] && echo "" && echo "Output: $OUTPUT_FILE"

echo "=========================================="



