# Stress Testing Suite

Load testing scripts for [Koha ILS](https://koha-community.org/), [Aspen Discovery](https://aspendiscovery.org/), and Solr using [k6](https://k6.io/).

## What This Does

This tool simulates many users hitting your catalog simultaneously to measure performance and find breaking points. It sends HTTP requests (or controls real browsers) to your system and records response times, error rates, and throughput.

**Use cases:**

- Verify a system can handle expected traffic before go-live
- Find the point where response times degrade unacceptably
- Detect memory leaks or stability issues under sustained load
- Benchmark before/after infrastructure changes

### Key Configuration Values

| Variable            | What It Controls                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `MAX_VUS`           | Maximum concurrent virtual users (simultaneous connections). Start low (10-20), increase gradually.              |
| `RAMP_TIME`         | How long to ramp from 0 to MAX_VUS (e.g., `2m` = 2 minutes). Gradual ramps reveal when performance degrades.     |
| `HOLD_TIME`         | Duration to maintain peak load after ramping (e.g., `5m` = 5 minutes at MAX_VUS).                                |
| `ABORT_MS`          | Response time threshold in milliseconds. If p95 response time exceeds this, the test aborts (system overloaded). |
| `MAX_FAIL_CON_RATE` | Maximum consecutive failure rate (e.g., `0.1` = 10%). Aborts if exceeded.                                        |
| `THINK_TIME`        | Pause between actions per user (seconds). Use `off` to disable, blank for random 1-3s, or a number like `2`.     |

**Example:** `MAX_VUS=100` with `RAMP_TIME=5m` and `HOLD_TIME=10m` means: gradually add users over 5 minutes until you have 100 concurrent users, then maintain that load for 10 minutes.

## Available Tests

| Script             | Type    | Run With     | Description                             |
| ------------------ | ------- | ------------ | --------------------------------------- |
| `aspen_http.js`    | HTTP    | Docker or k6 | High-volume Aspen Discovery stress test |
| `solr_http.js`     | HTTP    | Docker or k6 | Direct Solr query stress test           |
| `aspen_browser.js` | Browser | k6 only      | Aspen Discovery with real browser       |
| `koha.js`          | Browser | k6 only      | Koha ILS staff interface (template)     |
| `koha_training_browser.js` | Browser | k6 or Grafana Cloud | N librarians in lockstep - training-session certification |
| `koha_steady_state.js` | HTTP | k6 or Grafana Cloud | Daily-ops: staff + patron ( Aspen or OPAC ) sharing the pool |

**HTTP tests** are the primary focus - they can simulate hundreds of concurrent users and run in Docker.  
**Browser tests** require the k6 binary installed locally (not Docker).

## Running from Grafana Cloud (no local setup)

The Koha tests are also published to Grafana Cloud as clone-and-run templates,
so anyone can point them at any server from the browser - no local k6 needed.
Open the [Koha Stress Tests project](https://bws.grafana.net/a/k6-app/projects/8020159),
clone a test, edit the values marked `<<< SET` at the top of its script, and Run.
See [docs/GRAFANA_CLOUD.md](docs/GRAFANA_CLOUD.md).

Stand up a fresh project of all four tests with one command:
`./bin/new-cloud-project.pl "Partner X - Stress Tests"`. Push later script
changes with `./bin/sync-cloud-tests.pl`. Both use the k6 Cloud REST API and
just need `k6 cloud login` done once.

> **WARNING:** Do not run these tests blindly. Always review and configure the `.env` file before running. These scripts can generate significant load on target systems - ensure you have permission to test the target and understand the configured VU counts and durations.

## Quick Start (Docker) - HTTP Tests

1. **Copy a test profile:**

   ```bash
   # Pick a profile from env-templates/
   cp env-templates/smoke.env .env        # Quick sanity check (~2 min)
   cp env-templates/baseline.env .env     # Establish normal metrics (~15 min)
   cp env-templates/saturation.env .env   # Find breaking point (~25 min)
   cp env-templates/soak.env .env         # Extended stability test (2-4 hours)
   cp env-templates/firestarter.env .env  # Aggressive spike/DoS sim (~10 min)

   # Or use the full reference template:
   cp env-template .env
   ```

2. **Configure `.env`** - Set your UID/GID and target URLs:

   ```bash
   # Your user/group IDs (run: id -u and id -g)
   UID=1000
   GID=1000

   # Target URLs and credentials - CONFIGURE THESE
   BASE_URL=https://your-aspen-instance.org
   HOST_HEADER=your-aspen-instance.org  # Comment out if not needed

   SOLR_URL=http://your-solr-server:8983
   SOLR_CORE=grouped_works
   ```

3. **Run:**

   ```bash
   docker compose up
   ```

## Running with k6 Binary

Install k6: <https://k6.io/docs/get-started/installation/>

### Using run-with-env.sh (Recommended)

The `bin/run-with-env.sh` script reads your `.env` file and passes all variables to k6 automatically:

```bash
# Configure .env first, then:
./bin/run-with-env.sh                  # Runs the BENCH script specified in .env
./bin/run-with-env.sh solr_http.js     # Override to run a specific script
./bin/run-with-env.sh aspen_http.js
./bin/run-with-env.sh aspen_browser.js
```

### Manual k6 Commands

```bash
# Load .env and run
env $(grep -v '^#' .env | xargs) k6 run benchmarks/aspen_http.js

# Or pass variables directly
k6 run -e BASE_URL=https://my-catalog.org -e MAX_VUS=100 benchmarks/aspen_http.js
```

### Browser Tests (k6 Binary Only)

Browser tests require the k6 binary and Chromium installed on your system - they do not work in Docker.

> **WARNING:** Each VU spawns its own browser window. Running with `VUS=10` in visible mode will open 10 browser windows simultaneously. Start with `VUS=1` when testing, especially in non-headless mode.

```bash
# Using run-with-env.sh (recommended)
./bin/run-with-env.sh aspen_browser.js

# Visible browser window (set K6_BROWSER_HEADLESS=false in .env)
./bin/run-with-env.sh aspen_browser.js

# Or manually:
K6_BROWSER_HEADLESS=false k6 run -e BASE_URL=https://your-instance.org -e VUS=1 -e ITERATIONS=2 benchmarks/aspen_browser.js
```

## Test Profiles

Pre-configured templates in `env-templates/` for common scenarios:

| Profile           | Duration  | Max VUs | Purpose                                             |
| ----------------- | --------- | ------- | --------------------------------------------------- |
| `smoke.env`       | ~2 min    | 10      | Quick sanity check - verify system responds         |
| `baseline.env`    | ~15 min   | 15      | Establish normal performance metrics                |
| `saturation.env`  | ~25 min   | 150     | Gradual ramp to find breaking point                 |
| `soak.env`        | 2-4 hours | 50      | Extended run to find memory leaks, stability issues |
| `firestarter.env` | ~10 min   | 300     | Aggressive spike - DoS simulation                   |
| `realistic.env`   | ~70 min   | (rate)  | Calibrated real-usage replay (open model)           |
| `training.env`    | ~12 min   | 75 browsers | Training-class lockstep certification (Koha staff client) |
| `steady-state.env`| ~6 min    | (rate)  | Daily-ops: staff + patron load on the shared pool           |

### Recommended Order

1. **Smoke** - Verify connectivity and basic function
2. **Baseline** - Capture normal response times
3. **Saturation** - Find where performance degrades
4. **Soak** - Confirm stability under sustained load

## Modeling Real Usage (Koha)

The profiles above answer "when does it break". To answer "will it handle
*our* actual traffic", the Koha scripts can replay a workload measured from
production instead of a synthetic one:

1. Run `bin/analyze-koha-logs.pl` on production Apache access logs. It emits
   a calibration JSON (arrival rates, session behavior, think-time
   distribution) and a weighted list of real patron search terms.
2. Copy both files into `benchmarks/data/` (gitignored - real search terms
   can contain patron PII) and start from `env-templates/realistic.env`.
3. With `OPAC_SEARCHES_PER_HOUR` set, `koha_opac_http.js` switches from the
   staged VU ramp to an arrival-rate model: sessions start at the measured
   hourly rate whether or not the server keeps up, searching real terms at their
   real frequencies with measured think times and click-through rates.
4. Validate by running the analyzer on the staging server's access log during
   the test and comparing against production with `--compare`.

See [docs/CALIBRATION.md](docs/CALIBRATION.md) for the full
measure-calibrate-validate runbook, including the Koha database SQL for
calibrating the staff-side circulation rate.

## Certifying Training Sessions (Koha)

`koha_training_browser.js` simulates a training class: N real Chromium
browsers all doing the same staff-client exercise at the same moment
(login, checkout, checkin, catalog search, a deliberate hold collision),
paced by a shared trainer clock. It selects existing patrons and items
rather than creating records - the only state it produces is checkouts and
holds, which it puts back afterward. Start from `env-templates/training.env`
and run at scale from Grafana Cloud with
`./bin/run-with-env.sh --cloud`. See [docs/TRAINING.md](docs/TRAINING.md)
for the full runbook, including Grafana Cloud setup (secrets, projects,
per-employee tokens) and cleanup semantics.

## Configuration

All configuration is in `env-template`. Copy to `.env` and customize.

The most important settings are at the top:

- **UID/GID** - Required for Docker
- **Target URLs & Credentials** - Configure these first

See `env-template` for all load test options.

## Output

All tests save JSON results to `./output/`:

```
./output/
├── aspen-001-20260117-1430.json       # aspen_http.js
├── aspen-browser-001-20260117-1435.json  # aspen_browser.js
├── solr-001-20260117-1440.json        # solr_http.js
└── helm-solr-001-20260117-1445.json   # helm/run-test.sh
```

Each run generates a new numbered JSON file containing:
- Test configuration
- All k6 metrics (response times, throughput, errors)
- Check results
- Solr system info (if applicable)

## Kubernetes / Helm

For running `solr_http.js` inside a Kubernetes cluster (closer to your Solr instances, no network bottlenecks).

### Setup

1. **Configure `.env`** with your Solr settings:

   ```bash
   cp env-template .env
   ```

   Key variables for Helm:

   ```bash
   # Required
   SOLR_URL=http://solr-service.solr-namespace.svc.cluster.local:8983
   SOLR_CORE=grouped_works

   # Optional: Deploy to same namespace as Solr to access existing secrets
   K6_NAMESPACE=solr-cloud

   # Optional: Use K8s secret for password (must exist in K6_NAMESPACE)
   SOLR_USER=admin
   SOLR_SECRET=solr-credentials
   SOLR_SECRET_KEY=password

   # Test parameters
   MAX_VUS=100
   VU_STEP=10
   RAMP_TIME=5s
   HOLD_TIME=5s
   ```

2. **Run:**

   ```bash
   ./helm/run-test.sh
   ```

   The script will:
   - Deploy k6 as a Kubernetes Job
   - Stream logs in real-time
   - Copy JSON results to `./output/helm-solr-{number}-{date}.json`
   - Clean up on completion or Ctrl+C

### Notes

- Use internal K8s service URLs for `SOLR_URL` (not external hostnames)
- Set `K6_NAMESPACE` to your Solr namespace to access existing secrets
- Results include Solr system info (version, memory, load average)

See `helm/k6-benchmark/README.md` for full configuration options.

## Troubleshooting

### Requests not hitting the expected domain

Comment out the `HOST_HEADER` variable in your `.env` file. The `HOST_HEADER` is only needed when testing via localhost with a custom Host header.

### 403 Forbidden / Cloudflare blocking requests

If the target site has Cloudflare or similar protection, automated requests may be blocked. To bypass this:

1. Set up a direct route to the server (e.g., via Tailscale, VPN, or internal network)
2. Add an entry to your `/etc/hosts` file mapping the domain to the direct IP:

   ```
   # Example: Map domain to Tailscale IP
   100.x.x.x  your-aspen-instance.aspendiscovery.org
   ```

3. Set `BASE_URL` to use the domain name (which now resolves to your direct route)

This allows you to test the actual domain while bypassing Cloudflare's bot protection.

### Tailscale / MagicDNS "no such host" errors

If curl works but k6 fails with `lookup ... no such host` for Tailscale hostnames, k6's Go-based DNS resolver isn't seeing Tailscale's MagicDNS.

**Solution:** Set `SOLR_HOST_IP` to map the hostname to its IP:

```bash
# In .env:
SOLR_URL=https://my-host.ts.net      # Keep the hostname for TLS
SOLR_HOST_IP=100.64.0.5              # Get with: tailscale ip -4 my-host
```

This uses k6's built-in `hosts` option to bypass DNS while preserving correct TLS SNI.
