# Training-session certification: N librarians in lockstep

`benchmarks/koha_training_browser.js` answers one question: **will this Koha
server survive a training class?** A class is not average load - it is
TRAINING_ATTENDEES people doing the *same thing at the same moment* because the
trainer just said "now click Check out". The test reproduces exactly that:
one real Chromium browser per attendee, all pacing through a shared
curriculum on a trainer clock (`STEP_INTERVAL_S` between ticks, a few seconds
of `STEP_JITTER_S` human reaction spread), producing the synchronized burst
that actually breaks training sessions. Steps where attendees type - patron
search, catalog search - spread over the wider `TYPING_JITTER_S` (default
15s) instead, because thirty humans don't finish typing at the same second;
`place_hold` deliberately keeps the tight jitter, since that collision is
the point of the exercise. Login is different again: trainers deliberately
have trainees stagger their logins, so the class trickles in over its own
`LOGIN_JITTER_S` window (default 60s) and the first exercise tick starts
after that window closes.

The curriculum, one tick each:

| step           | what every attendee does                                          |
| -------------- | ----------------------------------------------------------------- |
| login          | staff login (own account, or shared `STAFF_USER`)                 |
| patron_search  | header patron search for their own training patron                |
| checkout       | check their own item barcode out to that patron                   |
| checkin        | check it back in                                                  |
| catalog_search | everyone searches the *same* term at once                         |
| place_hold     | everyone places a hold on the *same* bib (deliberate collision)   |
| wrap_up        | the trainer (VU 1) cancels the holds and checks the demo item in  |
| logout         | staff logout                                                      |

No records are created or deleted: setup selects **existing** patrons and
available items through the REST API (one of each per attendee - active,
unrestricted patrons with cardnumbers; items that are not lost/withdrawn/
not-for-loan, not checked out, and whose bib has no holds). The only state
the test produces is checkouts and holds, and those are put back: attendees
check their items in during the `checkin` exercise, the `wrap_up` step
cancels the class's holds and returns anything left out, and teardown
double-checks both.

The shared hold target is a bib whose copies are all checked out (holdable
under any on-shelf-holds policy): set `HOLD_BIBLIO_ID` to use a specific
record, otherwise the test finds one, or arranges one by checking a spare
item out to a spare patron (returned during `wrap_up`).

**Pass criteria:** at least `CHECKS_RATE` of all step executions complete
(default 0.98 - a real class tolerates a trainee retrying, so a perfect 1.0
would fail the certification on a single hiccup in 600 steps) and
`training_step_duration` p95 under `STEP_P95_MS` (default 15s) per step -
"nobody's screen hung when everyone clicked at once". The
`wrap_up` cleanup is reported separately as `training_cleanup_duration`
with no latency threshold: it makes O(class size) API calls by design.
The first tick starts after `STARTUP_GRACE_S` (default 15s) so all the
browsers finish launching and log in as one burst. The failure
mode to expect on an undersized server is Plack worker exhaustion at tick
boundaries: the last few attendees' pages time out while the first few look
fine, which shows up as per-step max/p95 blowing out.

## Prerequisites

- A superlibrarian login on the target (`STAFF_USER`/`STAFF_PASS`) for API
  record selection, and the **`RESTBasicAuth` system preference enabled** -
  it's off by default, and without it every API call fails with
  `401 Basic authentication disabled`.
- Enough existing records: `TRAINING_ATTENDEES + 1` active patrons and available
  items. `LIBRARY_ID` / `PATRON_CATEGORY_ID` scope the selection to a branch
  or category; leave blank to pick from the whole catalog.
- Circulation rules on the target must allow the selected patrons to check
  out the selected items and place holds.
- `CATALOG_SEARCH_TERM` should return hits in the target catalog.
- k6 v1.0+ with browser support and Chromium/Chrome for local runs (the
  `k6/secrets` import needs a modern k6; v1.4 tested).
- Still never point this at production: real patrons get transient checkouts
  and holds on their accounts, which lands in their circulation history and
  can queue checkout notices if the patron has messaging enabled. Use the
  staging clone, and confirm its outbound email is disabled.

## Running locally (small scale)

Each VU is a whole Chromium instance. 2-5 browsers on a laptop is fine for
rehearsing the curriculum against a test server; 75 is not - a saturated
load generator corrupts the latency numbers you are trying to certify.

```bash
cp env-templates/training.env .env    # edit STAFF_URL etc.
./bin/run-with-env.sh                 # local: k6 run
```

Failed steps drop `benchmarks/training_<step>_vu<N>.png` screenshots
(gitignored) - read those before blaming the server.

## Running at 75 from Grafana Cloud

Grafana Cloud k6 runs browser tests on managed headless Chromium fleets,
which is exactly what 75 concurrent browsers needs. Browser VUs bill at 10x
protocol VUs; a 15-minute run at 75 browsers is roughly 190
VUH-equivalents - a bounded, occasional certification cost.

One-time setup (per Grafana Cloud stack, e.g. `bws.grafana.net`):

1. In the k6 app (`https://bws.grafana.net/a/k6-app`), create a project for
   these runs (e.g. "Partner certifications") and note its project ID for
   `CLOUD_PROJECT_ID`.
2. If the target sits behind a restricted ingress that allowlists a header:
   store the header value as a **secret** under *Testing & synthetics >
   Performance > Settings > Secrets*, named
   `x-grafana-cloud-external-service-token` (or set
   `EXTERNAL_SERVICE_TOKEN_SECRET` to whatever name you choose). The staff
   password works the same way: store it as a secret named `staff-pass`
   (`STAFF_PASS_SECRET` overrides the name) and leave the `STAFF_PASS`
   environment variable unset for cloud runs. Secrets are
   write-only in the UI and redacted from logs; the script reads them at
   runtime via the `k6/secrets` module. Locally the same header comes from
   the `EXTERNAL_SERVICE_TOKEN` env var instead - never commit the value.
3. Each person running tests: create a Personal API token in the k6 app and
   authenticate once with `k6 cloud login --token <token>`.

Per-certification run:

```bash
cp env-templates/training.env .env    # edit STAFF_URL, TRAINING_ATTENDEES, CLOUD_PROJECT_ID
./bin/run-with-env.sh --cloud         # k6 cloud run: archives script + data, executes on cloud runners
```

Everything in `.env` travels as `-e` flags, so a new partner deployment is a
new `.env` (or just edited `STAFF_URL`) - no script changes. Cloud runs
ignore `handleSummary`, so results live in the k6 app UI (per-step
`training_step_duration` percentiles are under the test run's custom
metrics; thresholds still decide pass/fail).

If the target is *not* reachable from the public internet (and can't
allowlist the header), use `./bin/run-with-env.sh --cloud-output` from a
generator that can reach it: the test executes locally but streams results
to the Grafana Cloud dashboards. For a permanent in-cluster answer, Grafana
Private Load Zones (k6-operator in Kubernetes) replace the local generator.

## Letting other employees run certifications

- Grafana Cloud handles access: anyone in the stack with Editor access to
  the k6 app and the project can see results, re-run tests, and create their
  own API token for CLI runs. No shared credentials needed - tokens are
  personal.
- The repeatable procedure per new partner deployment is: clone this repo,
  `cp env-templates/training.env .env`, set `STAFF_URL` (+ host header,
  superlibrarian credentials, `TRAINING_ATTENDEES`, `CLOUD_PROJECT_ID`),
  `k6 cloud login --token <their token>` once, then
  `./bin/run-with-env.sh --cloud`.
- A re-run from the k6 app UI replays the uploaded archive with the same
  environment values baked in - fine for repeating the identical
  certification, but changing the target or class size means a fresh CLI
  run. Organization-wide *Environment variables* (Settings > Execution
  resources) are also injected at runtime and can carry stack-wide values,
  but per-partner parameters are cleaner as CLI `-e` flags from `.env`.

## Per-attendee logins (optional, more realistic)

By default all attendees log in as `STAFF_USER`. Koha happily runs N
concurrent sessions for one account, but real classes have real accounts,
and per-account sessions are marginally more honest. Create them on the
target server:

```bash
koha-shell <instance> -c "perl seed-training-users.pl --count 75 --password 'S3cretTraining!'"
```

(`bin/seed-training-users.pl`; add `--delete` to clean up afterwards.) Then
set `TRAINING_USER_PREFIX=training` and `TRAINING_USER_PASS` in `.env`.

## Cleanup semantics

Community Koha has **no REST checkin endpoint**, which shapes the cleanup:

- Attendee items are checked in during the `checkin` exercise itself.
- During `wrap_up`, VU 1 (the trainer) cancels the class's holds via the API
  (only holds belonging to the selected patrons - the bib may carry real
  holds too) and checks back in, through the UI, the arranged hold-target
  checkout plus anything a failed `checkin` exercise left out.
- Teardown re-checks both and cancels any class holds that remain. What it
  *can't* do is check items in, so if anything is still out (a `wrap_up`
  failure), it logs the exact barcodes: `Still checked out and needing a
  manual checkin: ...`. Scan those through the staff client and the target
  is back to its pre-test state. Nothing else persists.

## Adjusting the curriculum

The exercise list is the `STEPS` array plus one `runStep(...)` block per
exercise in `benchmarks/koha_training_browser.js`. To certify a specific
partner's training plan, ask the trainer for their lesson steps and mirror
them - add or reorder `runStep` blocks and keep `STEPS` in sync (it drives
the tick schedule and the per-step thresholds).

## Caveats

- Staff-client markup drifts between Koha versions; the selectors are tested
  against current main. A step failing on an older release usually means a
  selector changed - check the failure screenshot first.
- All attendees come from one IP with distinct per-VU browser sessions;
  session handling is exercised, network diversity is not.
- The `place_hold` collision is verified via the API because the
  existing-holds DataTable fills asynchronously; the browser still performs
  the full UI flow.
