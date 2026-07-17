# Stress-testing a new partner

Everything runs on Grafana Cloud, and everything is prompted. The **only thing
you store is your k6 API token**. Two steps.

## One-time: set your token

```bash
export GRAFANA_CLOUD_K6_PERSONAL_API_TOKEN=<token>
```

Get the token from the k6 app → your avatar → **Personal API token**
( https://bws.grafana.net/a/k6-app ). Put the `export` in your shell profile
( `~/.zshrc` / `~/.bashrc` ) so it's always set.

## Run

```bash
./bin/run-cloud.pl
```

It asks for everything and runs the test you pick:

1. **Partner name** ( e.g. `PWPL` ) — creates or reuses the project
   `Stress Testing - PWPL`.
2. **Platform** — Aspen + Koha, or Koha-only. This decides which tests and which
   questions you get.
3. **URLs and load targets** — staff URL, catalog URL, searches/hour,
   transactions/hour, class size, search term. Only what the platform needs.
   Load numbers are the **library's production targets** ( what they expect at
   go-live ), not current traffic. On a re-run the prompts default to what's
   already set — just press Enter through.
4. **Which test** — pick one, or `all`.

Each test runs via `k6 cloud run`, so afterward it's **re-runnable from the k6
UI's Run button**. Green = passed; point anyone at the run's URL to read it.

Credentials are **not** prompted — the superlibrarian password and the ingress
token come from the org-wide Grafana secrets. The target server needs
`RESTBasicAuth` enabled for the login-based tests.

## The tests

| Test | What it certifies |
| ---- | ----------------- |
| Aspen Stress Test - HTTP Only | Aspen search sustains the target rate ( Aspen + Koha ) |
| OPAC Stress Test - HTTP Only | Koha OPAC search sustains the target rate ( Koha-only ) |
| Daily Operations | Staff + patron load together, all day |
| Training Simulation - HTTP Only | A class of N attendees — **the real N-user load test** |
| Training Simulation - End to End | A class in real browsers — rendered-experience probe |
| Aspen / OPAC - Browser | Patron catalog in a real browser — experience probe |

## Gotchas

- **High search rates** need the project's VU limit raised in the k6 UI
  ( project settings ) before a run can reach the target — the API can't set it.
- **Browser tests are experience probes** and vary run-to-run on cloud
  generators; trust the **HTTP** tests for the load pass/fail, and re-run a
  browser test before calling it a failure.
