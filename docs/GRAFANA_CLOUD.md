# Running the stress tests from Grafana Cloud

These tests live in the Grafana Cloud k6 app as **script-editor templates** so
anyone can run them against any Koha server from the browser — no local k6, no
CLI. The project is
[**Koha Stress Tests** (8020159)](https://bws.grafana.net/a/k6-app/projects/8020159).

## The four templates

| Test | What it does | Login needed |
| ---- | ------------ | ------------ |
| **OPAC Stress Test - HTTP Only** | Anonymous catalog searches at a target rate — finds the OPAC's ceiling | No |
| **Daily Operations** | Staff transactions + patron catalog use sharing one worker pool | Yes |
| **Training Simulation - HTTP Only** | N staff logged in, doing the same exercise in lockstep (HTTP, cheap) | Yes |
| **Training Simulation - End to End** | Same, but real Chromium browsers (heavier, more realistic) | Yes |

## How to run one against your server

1. Open the [project](https://bws.grafana.net/a/k6-app/projects/8020159) and click the test you want.
2. **Clone it** so you don't disturb the template or someone else's run: open the
   script editor and choose **Save as…** (give it a name like `OPAC — PWPL`).
3. In your copy's script, edit the values marked **`<<< SET`** near the top —
   search the script for `<<< SET` to find them all. At minimum that's the
   **target URL**; tests that log in also want the **superlibrarian username and
   password**, and each test has a **load knob** (searches/hour, transactions/
   hour, or number of attendees).
4. Click **Run**.

That's it. Your clone keeps its own target and credentials, so several people
can test different servers at the same time without stepping on each other.

## Credentials and the two secrets

The login tests authenticate as a superlibrarian, and every test sends an
ingress header (`x-grafana-cloud-external-service`) that lets the load through
Cloudflare on ByWater-hosted servers. Two org-level secrets back these:

- **`staff-pass`** — used when you leave the password blank in the script.
  Handy for ByWater-standard servers that share a support login; for anything
  else, just type that server's password into the `<<< SET` password line.
- **`x-grafana-cloud-external-service-token`** — the ingress token, sent
  automatically. You don't set this per run.

The target server also needs **RESTBasicAuth** enabled for the login tests.

## Maintainers: updating the templates

The templates are generated from `benchmarks/*.js` in this repo. When the code
changes, push the update with:

```bash
./bin/sync-cloud-tests.sh          # create/update all four, in place
./bin/sync-cloud-tests.sh --dry-run
```

It talks to the k6 Cloud REST API (reusing your `k6 cloud login` token) and
updates each test's script by name — it never touches clones people have made.
See the script header for `--project` / `--env` / filter options.
