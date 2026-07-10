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
3. In your copy's script, edit the values in the **`RUN CONFIG` block** at the
   top (every editable line is there, each marked `<<< SET`). At minimum that's
   the **target URL**; tests that log in also want the **superlibrarian username
   and password**, and each test has a **load knob** (searches/hour,
   transactions/hour, or number of attendees).
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

## Standing up a whole new project

To give a partner or engagement its own project, pre-filled with all four
templates, one command does it — no clicking, no pasting:

```bash
./bin/new-cloud-project.pl "Partner X - Stress Tests"
```

It discovers your org, creates the project, populates the four tests, and
prints the project link. Share that link; people run tests from there exactly
as above (clone → edit `<<< SET` → Run). Secrets are org-wide, so the new
project inherits `staff-pass` and the ingress token automatically.

VU limits are the one thing the API can't set (it's an admin/plan action) — if
a big run (e.g. the OPAC peak) needs more than the project default, raise them
in the project's settings in the UI.

## Maintainers: updating the templates

The templates are generated from `benchmarks/*.js` in this repo. When the code
changes, push the update with:

```bash
./bin/sync-cloud-tests.pl          # create/update all four, in place
./bin/sync-cloud-tests.pl --dry-run
./bin/sync-cloud-tests.pl --project <ID>   # target another project
```

It talks to the k6 Cloud REST API (reusing your `k6 cloud login` token) and
updates each test's script by name — it never touches clones people have made.
See the script header for `--env` / filter options.

Both scripts just need `k6 cloud login --token <token>` done once (token from
the k6 app).
