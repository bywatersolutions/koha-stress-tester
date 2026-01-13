# K6 Benchmark Helm Chart

Run k6 load tests inside your Kubernetes cluster for accurate benchmarking without network bottlenecks.

## Installation

```bash
# Install with default values
helm install k6-bench ./helm/k6-benchmark -n solr-cloud

# Install with custom values
helm install k6-bench ./helm/k6-benchmark -n solr-cloud \
  --set solr.url=http://my-solr-service:80 \
  --set solr.core=my_collection \
  --set test.maxVUs=200

# Watch the test
kubectl logs -f job/k6-bench -n solr-cloud
```

## Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `solr.url` | Solr service URL (internal) | `http://clevnet-solrcloud-solrcloud-common:80` |
| `solr.core` | Solr collection name | `grouped_works_v2` |
| `solr.user` | Solr username (optional) | `""` |
| `solr.pass` | Solr password (optional) | `""` |
| `test.maxVUs` | Maximum virtual users | `300` |
| `test.vuStep` | VU increment per stage | `10` |
| `test.rampTime` | Duration of ramp phase | `5s` |
| `test.holdTime` | Duration of hold phase | `5s` |
| `test.timeout` | Request timeout | `30s` |
| `namespace` | Namespace to deploy into | `solr-cloud` |

## Usage

### Run a test
```bash
helm install k6-bench ./helm/k6-benchmark -n solr-cloud
```

### Watch logs
```bash
kubectl logs -f job/k6-bench -n solr-cloud
```

### Clean up
```bash
helm uninstall k6-bench -n solr-cloud
```

### Run again
```bash
# Delete previous job
kubectl delete job k6-bench -n solr-cloud 2>/dev/null

# Install fresh
helm install k6-bench ./helm/k6-benchmark -n solr-cloud
```

## Custom Word List

To use your own word list, create a values file:

```yaml
# my-values.yaml
solr:
  url: "http://my-solr:80"
  core: "my_collection"
test:
  maxVUs: 500
```

Then install:
```bash
helm install k6-bench ./helm/k6-benchmark -n solr-cloud -f my-values.yaml
```

