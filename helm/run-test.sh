#!/bin/bash
# K6 Helm test runner - reads configuration from ../.env
#
# Usage:
#   1. Configure ../.env with your SOLR_URL, SOLR_CORE, etc.
#   2. Run: ./run-test.sh
#
# Prerequisites:
#   Create credentials secret (if using auth):
#     kubectl create secret generic solr-credentials \
#       --from-literal=username=USER --from-literal=password=PASS -n k6-tests

set -e

SCRIPT_DIR="$(dirname "$0")"
ENV_FILE="$SCRIPT_DIR/../.env"
CHART_DIR="$SCRIPT_DIR/k6-benchmark"
NAMESPACE="k6-tests"
RELEASE="k6-bench"

# Load .env file
if [ -f "$ENV_FILE" ]; then
    echo "Loading configuration from .env..."
    set -a
    source "$ENV_FILE"
    set +a
else
    echo "Error: .env file not found at $ENV_FILE"
    echo "Copy env-template to .env and configure it first."
    exit 1
fi

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
echo "  SOLR_URL=$SOLR_URL"
echo "  SOLR_CORE=$SOLR_CORE"
[ -n "$SOLR_SECRET" ] && echo "  SOLR_SECRET=$SOLR_SECRET"
[ -n "$MAX_VUS" ] && echo "  MAX_VUS=$MAX_VUS"

helm install "$RELEASE" "$CHART_DIR" -n "$NAMESPACE" \
    --set solr.url="$SOLR_URL" \
    --set solr.core="$SOLR_CORE" \
    ${SOLR_SECRET:+--set solr.existingSecret="$SOLR_SECRET"} \
    ${SOLR_USER:+--set solr.user="$SOLR_USER"} \
    ${SOLR_PASS:+--set solr.pass="$SOLR_PASS"} \
    ${MAX_VUS:+--set test.maxVUs="$MAX_VUS"} \
    ${VU_STEP:+--set test.vuStep="$VU_STEP"} \
    ${RAMP_TIME:+--set test.rampTime="$RAMP_TIME"} \
    ${HOLD_TIME:+--set test.holdTime="$HOLD_TIME"}

# Wait for pod to be ready and stream logs
echo "Waiting for pod..."
kubectl wait --for=condition=Ready pod -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE" --timeout=60s 2>/dev/null || true

echo "Streaming logs (Ctrl+C to stop watching, test will continue)..."
echo "=========================================="
kubectl logs -f -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE"

# Cleanup after completion
echo "=========================================="
echo "Test complete. Cleaning up..."
helm uninstall "$RELEASE" -n "$NAMESPACE" 2>/dev/null || true
echo "Done."



