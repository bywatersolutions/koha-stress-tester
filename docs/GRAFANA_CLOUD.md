# Running the stress tests from Grafana Cloud

These tests run in the Grafana Cloud k6 app so anyone can run them from the
browser — no local k6, no CLI. Each server or engagement gets **its own
project**, created and pre-configured in one command with
`bin/new-cloud-project.pl`. Open the project, pick a test, click **Run**.

## The tests

A project gets the patron-facing tests for the partner's platform (Aspen **or**
OPAC) plus the shared Daily Operations and training tests, each pre-baked for
that server:

| Test | What it does | Login needed |
| ---- | ------------ | ------------ |
| **OPAC Stress Test - HTTP Only** | Anonymous Koha catalog searches at a target rate — finds the OPAC's ceiling | No |
| **OPAC Stress Test - Browser** | Real Chromium doing a patron search + record view — measures the rendered experience | No |
| **Daily Operations** | Staff transactions + patron catalog use sharing one worker pool | Yes |
| **Training Simulation - HTTP Only** | N staff logged in, doing the same exercise in lockstep (HTTP, cheap) | Yes |
| **Training Simulation - End to End** | Same, but real Chromium browsers (heavier, more realistic) | Yes |
| **Aspen Stress Test - HTTP Only** | High-volume Aspen Discovery search stress test — finds Aspen's ceiling | No |
| **Aspen Stress Test - Browser** | Real Chromium doing a patron search + record view against Aspen | No |

An **Aspen + Koha** partner gets the two Aspen tests; a **Koha-only** partner
gets the two OPAC tests. Daily Operations and both Training tests are created
either way.

## Standing up a project

To give a server or engagement its own project, pre-filled with the right tests:

```bash
./bin/new-cloud-project.pl "Partner X"              # asks: Aspen + Koha, or Koha-only?
./bin/new-cloud-project.pl "Partner X" --koha-only  # Koha-only, no prompt
```

First it asks the partner's **platform**, which decides the patron-facing tests:

- **Aspen + Koha** (default) — patrons search Aspen; the Koha OPAC is hit only by
  the Aspen API. Creates the **Aspen** tests + Daily Operations (`PATRON_MODE=aspen`)
  + training.
- **Koha-only** (`--koha-only`) — patrons search the Koha OPAC directly. Creates
  the **OPAC** tests + Daily Operations (`PATRON_MODE=opac`) + training.

Then it prompts (with an explanation and a default) for the settings that apply
to that platform — press Enter to accept a default:

| Setting | Platform | Feeds |
| ------- | -------- | ----- |
| `STAFF_URL` | both | staff + training tests, and the Koha API |
| `STAFF_USER` | both | superlibrarian username for the login tests (default `bwssupport`) |
| `STAFF_TRANSACTIONS_PER_HOUR` | both | Daily Operations staff load |
| `TRAINING_ATTENDEES` | both | training class size |
| `CATALOG_SEARCH_TERM` | both | a term with hits in the catalog (browser tests) |
| `ASPEN_BASE_URL` | Aspen + Koha | the Aspen tests — the patron catalog URL |
| `ASPEN_SEARCHES_PER_HOUR` | Aspen + Koha | Aspen search rate to certify (e.g. 5000) — sustained arrival-rate run |
| `PATRON_SESSIONS_PER_HOUR` | Aspen + Koha | Daily Operations patron load (Aspen→Koha API) |
| `OPAC_URL` | Koha-only | the Koha OPAC tests + patron catalog |
| `OPAC_SEARCHES_PER_HOUR` | Koha-only | the OPAC HTTP load rate |

`PATRON_MODE` is set from the platform, not prompted. Credentials are **not**
prompted — they stay on the org-wide secrets (below). Add `--defaults` to skip
the prompts, or `--set VAR=VALUE` to pre-seed one.

Share the project link; people just open a test and click **Run**. Each test is
already pointed at the right server. If someone wants to keep a tweaked variant
without disturbing the project's copy, they can use the script editor's
**Save as…** first, then edit the values marked `<<< SET` in its RUN CONFIG
block.

## Credentials and the two secrets

The login tests authenticate as a superlibrarian, and every test sends an
ingress header (`x-grafana-cloud-external-service`) that lets the load through
Cloudflare on ByWater-hosted servers. Two org-level secrets back these:

- **`staff-pass`** — used when you leave the password blank in the script.
  Handy for ByWater-standard servers that share a support login; for anything
  else, type that server's password into the `<<< SET` password line.
- **`x-grafana-cloud-external-service-token`** — the ingress token, sent
  automatically. You don't set this per run.

The target server also needs **RESTBasicAuth** enabled for the login tests.

VU limits are the one thing the API can't set (it's an admin/plan action) — if
a big run needs more than the project default, raise it in the project's
settings in the UI.

## Maintainers: updating a project's tests

The tests are generated from `benchmarks/*.js` in this repo. When the code
changes, push the update to an existing project with:

```bash
./bin/sync-cloud-tests.pl --project <ID>                    # update all, in place
./bin/sync-cloud-tests.pl --project <ID> --dry-run
./bin/sync-cloud-tests.pl --project <ID> opac aspen         # filter by name/script
./bin/sync-cloud-tests.pl --project <ID> --set ASPEN_BASE_URL=https://x   # re-bake a value
```

It talks to the k6 Cloud REST API (reusing your `k6 cloud login` token) and
updates each test's script by name. `new-cloud-project.pl` uses it under the
hood to populate a new project. See the script header for `--recreate` and other
options.

Both scripts just need `k6 cloud login --token <token>` done once (token from
the k6 app).
