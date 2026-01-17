# K6 Benchmark Helm Chart

Run k6 load tests inside your Kubernetes cluster for accurate benchmarking without network bottlenecks.

## Prerequisites

1. **Create the namespace**:

   ```bash
   kubectl create namespace k6-tests
   ```

2. **(Optional) Create a secret for Solr password**:

   ```bash
   kubectl create secret generic solr-credentials \
     --from-literal=password=your-solr-pass \
     -n k6-tests
   ```

## Installation

```bash
# Install with required values
helm install k6-bench ./helm/k6-benchmark -n k6-tests \
  --set solr.url=http://my-solr-service.solr-namespace.svc.cluster.local \
  --set solr.core=my_collection \
  --set solr.existingSecret=solr-credentials

# Watch the test
kubectl logs -f job/k6-bench -n k6-tests
```

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `solr.url` | Solr service URL (internal cluster URL) | `""` |
| `solr.core` | Solr collection name | `grouped_works` |
| `solr.user` | Solr username | `""` |
| `solr.pass` | Solr password (use existingSecret instead) | `""` |
| `solr.existingSecret` | K8s secret name containing password | `""` |
| `solr.existingSecretKey` | Key in secret for password | `password` |
| `test.maxVUs` | Maximum virtual users | `300` |
| `test.vuStep` | VU increment per stage | `10` |
| `test.rampTime` | Duration of ramp phase | `5s` |
| `test.holdTime` | Duration of hold phase | `5s` |
| `test.timeout` | Request timeout | `30s` |
| `namespace` | Namespace to deploy into | `k6-tests` |

## Usage

### Quick start with run-test.sh

The script reads configuration from `../.env` (same file used by Docker):

```bash
# 1. Configure .env in project root
cp env-template .env
vim .env   # Set SOLR_URL, SOLR_CORE, MAX_VUS, etc.

# 2. Run
./helm/run-test.sh
```

The script uses these variables from `.env`:

| Variable | Description |
|----------|-------------|
| `SOLR_URL` | Solr service URL (required) |
| `SOLR_CORE` | Solr collection name (required) |
| `SOLR_USER` | Solr username |
| `SOLR_PASS` | Solr password (if not using secret) |
| `SOLR_SECRET` | K8s secret name containing password |
| `MAX_VUS` | Maximum virtual users |
| `VU_STEP` | VU increment per stage |
| `RAMP_TIME` | Duration of ramp phase |
| `HOLD_TIME` | Duration of hold phase |

If `SOLR_SECRET` is set, the password is read from the Kubernetes secret. Username always comes from `SOLR_USER`.

### Manual run

```bash
helm install k6-bench ./helm/k6-benchmark -n k6-tests \
  --set solr.url=http://my-solr:8983 \
  --set solr.core=my_collection \
  --set solr.existingSecret=solr-credentials \
  --set test.maxVUs=200
```

### Watch logs

```bash
kubectl logs -f job/k6-bench -n k6-tests
```

### Clean up

```bash
helm uninstall k6-bench -n k6-tests
```

### Run again

```bash
# Delete previous job
kubectl delete job k6-bench -n k6-tests 2>/dev/null

# Install fresh
helm install k6-bench ./helm/k6-benchmark -n k6-tests -f my-values.yaml
```

## Custom Values File

Create a `my-values.yaml`:

```yaml
solr:
  url: "http://my-solr-service.solr-namespace.svc.cluster.local"
  core: "my_collection"
  existingSecret: "solr-credentials"

test:
  maxVUs: 500
  vuStep: 25
  rampTime: "10s"
  holdTime: "30s"
```

Then install:

```bash
helm install k6-bench ./helm/k6-benchmark -n k6-tests -f my-values.yaml
```
