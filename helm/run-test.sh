#!/bin/bash
# One-command k6 load test runner
# Usage: ./run-test.sh [values-file]

set -e

NAMESPACE="k6-tests"
RELEASE="k6-bench"
CHART_DIR="$(dirname "$0")/k6-benchmark"
VALUES_FILE="${1:-}"

# Create namespace if needed
kubectl create namespace "$NAMESPACE" 2>/dev/null || true

# Clean up any previous run
helm uninstall "$RELEASE" -n "$NAMESPACE" 2>/dev/null || true

# Wait for old job to be deleted
kubectl delete job -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE" --ignore-not-found=true 2>/dev/null

# Install
echo "Starting k6 load test..."
if [ -n "$VALUES_FILE" ]; then
    helm install "$RELEASE" "$CHART_DIR" -n "$NAMESPACE" -f "$VALUES_FILE"
else
    helm install "$RELEASE" "$CHART_DIR" -n "$NAMESPACE"
fi

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



