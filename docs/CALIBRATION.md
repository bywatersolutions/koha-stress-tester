# Calibration: making the load tests model real human usage

The stock test profiles are stress harnesses: they prove the server survives
*a* load, not *the* load your patrons and staff actually generate. Out of the
box the scripts search for uniform random dictionary words, click a fixed
number of results, and pause for uniform random think times - none of which
matches real traffic. Real queries are heavily repeated (warm caches), real
users mostly click one result or none, and real think times have a long tail.

This runbook closes that gap in three steps:

1. **Measure** - extract a workload model from production ground truth
   (Apache access logs + the Koha database).
2. **Calibrate** - feed the measurements into the k6 scripts.
3. **Validate** - prove the synthetic load looks like the real thing by
   comparing server-side fingerprints, using the same analyzer on both sides.

## Closed vs open load models

The staged profiles (`MAX_VUS`/`RAMP_TIME`/`HOLD_TIME`) are a *closed* model:
a fixed pool of virtual users each waits for the server before starting the
next action. When the server slows down, the offered load politely slows down
with it - useful for finding a breaking point, but it can't answer "will we
survive Tuesday at 4pm", because real patrons don't slow down their arrival
just because the server is busy.

Setting `OPAC_SEARCHES_PER_HOUR` (or `WORKFLOW_RATE_PER_HOUR` for the staff
workflow) switches to an *open* model: k6's `ramping-arrival-rate` executor
starts sessions at the measured hourly rate no matter how slow the server
gets. If the server can't keep up, latency climbs and (eventually)
`dropped_iterations` appear - which is exactly the honest signal you want
from a validation run.

## 1) Measure

### Apache access logs (patron side)

Optional but recommended first: add `%D` (response time in microseconds) to
the Apache `LogFormat` on production *before* the measurement window, so the
calibration includes per-endpoint latency percentiles:

```
LogFormat "%h %l %u %t \"%r\" %>s %b \"%{Referer}i\" \"%{User-agent}i\" %D" combined
```

Run the analyzer without a window first to find the busy hour:

```bash
bin/analyze-koha-logs.pl /var/log/apache2/opac-access.log* 2>&1 >/dev/null | less
# STDERR summary shows the per-minute peak; the JSON per_minute array has the full curve
```

Then re-run windowed on the busiest hour and write both outputs:

```bash
bin/analyze-koha-logs.pl \
  --from '2026-01-06 16:00' --to '2026-01-06 17:00' \
  --out calibration.json \
  --terms search_terms.json \
  /var/log/apache2/opac-access.log /var/log/apache2/opac-access.log.1.gz
```

Notes:

- Combined and `vhost_combined` formats are handled automatically, gzipped
  or plain, in any mix.
- Bots are filtered by User-Agent and reported as a percentage (20-50% is
  normal). `--include-bots` disables the filter.
- A "search" is `opac-search.pl` with a `q=` parameter and no offset;
  paginated result pages are counted separately as `paging_rate`.
- Sessions are rebuilt per IP + User-Agent with a 30 minute idle timeout
  (`--session-timeout` to change).

**Privacy:** real patron queries can contain PII (names, card numbers typed
into the wrong search box). `benchmarks/data/` is gitignored for this reason.
Treat `search_terms.json` like log data and delete it when the engagement
ends.

### Koha database (staff side)

```sql
-- 1. Top 20 busiest circulation hours (sets WORKFLOW_RATE_PER_HOUR)
SELECT DATE(datetime) AS day, HOUR(datetime) AS hr,
       SUM(type='issue') AS checkouts, SUM(type='return') AS checkins,
       SUM(type='renew') AS renewals, COUNT(*) AS total
FROM statistics
WHERE datetime >= '2026-06-01' AND datetime < '2026-07-01'
GROUP BY day, hr ORDER BY total DESC LIMIT 20;

-- 2. Same per branch, if load is branch-skewed
SELECT branch, HOUR(datetime) AS hr,
       COUNT(*)/COUNT(DISTINCT DATE(datetime)) AS avg_txn_per_hour
FROM statistics WHERE datetime >= '2026-06-01'
GROUP BY branch, hr ORDER BY avg_txn_per_hour DESC LIMIT 20;

-- 3. Logged-in patron search terms (supplements the Apache-derived list)
SELECT COUNT(*) AS w, LOWER(TRIM(query_desc)) AS t
FROM search_history
WHERE time >= '2026-06-01'
GROUP BY t ORDER BY w DESC LIMIT 5000;
```

One `koha_workflow_http.js` iteration performs 1 checkout + 1 checkin, so set
`WORKFLOW_RATE_PER_HOUR` to the peak-hour `checkouts` value from query 1.

Query 3's output can be merged into the term list automatically: save it as
tab-separated `weight<TAB>term` lines and pass `--extra-terms file.tsv` to
the analyzer.

## 2) Calibrate

```bash
cp calibration.json search_terms.json benchmarks/data/
cp env-templates/realistic.env .env
# then edit .env
```

| calibration.json field                | .env variable                       |
| ------------------------------------- | ----------------------------------- |
| `arrival.searches_per_hour`            | `OPAC_SEARCHES_PER_HOUR`            |
| (whole file)                           | `CALIBRATION_FILE=data/calibration.json` |
| (terms file)                           | `SEARCH_TERMS_FILE=data/search_terms.json` |
| `sessions.click_through_rate`          | automatic; `CLICK_THROUGH_RATE` overrides |
| `sessions.detail_views_per_search`     | automatic; `DETAIL_VIEWS_PER_SEARCH` overrides |
| `sessions.paging_rate`                 | automatic (gates the subject-browse step) |
| `sessions.think_time_s.quantiles`      | automatic when `THINK_TIME` is blank (capped at 120s) |
| statistics SQL peak-hour checkouts     | `WORKFLOW_RATE_PER_HOUR` (staff run) |

To model a specific search volume (e.g. "12,929 searches in the peak hour"),
just set `OPAC_SEARCHES_PER_HOUR` to that number - the script converts it to a
session arrival rate internally by dividing by the searches each session
issues (one main search plus the subject browse).

For headroom testing, run again at 2-3x the measured rate - the measured
hour is an average, and the peak minutes inside it run hotter.

The `setup()` log echoes which term source and load model actually loaded -
check it on every run. A typo'd `SEARCH_TERMS_FILE` falls back loudly to the
dictionary (370,105 entries is the giveaway).

## 3) Validate

Target a **staging clone with a copy of the production bib database** - real
terms against a different database return different hit counts, which changes
result-page cost and click-through mechanics.

Record the same fingerprint on both sides:

| Metric                          | Production (busy hour)                  | Staging (during the run)  |
| ------------------------------- | --------------------------------------- | ------------------------- |
| req/s, endpoint mix, latencies  | analyzer on prod log                     | analyzer on staging log   |
| CPU / load average              | `sar -u 60`, `sar -q 60`                 | same                      |
| MySQL queries/sec               | `mysqladmin -r -i 60 extended-status \| grep -w Questions` | same    |
| Zebra query rate                | zebrasrv log line rate                   | same                      |
| Elasticsearch query rate        | `_nodes/stats` `indices.search.query_total` delta | same             |

All k6 traffic comes from the load generator's single IP, so
`koha_opac_http.js` sends a unique per-iteration User-Agent
(`k6-stress-test/<vu>-<iteration>`); the analyzer keys sessions on IP +
User-Agent, so each synthetic session is reconstructed individually from the
staging log and the session metrics (think times, CTR, searches per session)
are directly comparable to production's.

Procedure:

1. Run the calibrated test against staging while capturing its Apache access
   log (with `%D`).
2. Re-run the analyzer on the staging log for the run window, and diff
   against production directly:

   ```bash
   bin/analyze-koha-logs.pl \
     --from '2026-07-10 14:00' --to '2026-07-10 15:00' \
     --compare production-calibration.json \
     --out staging-calibration.json \
     /var/log/apache2/staging-opac-access.log
   ```

3. **First check the load generator, then the server.** Staging req/s,
   searches/hr, and sessions/hr should be within ~10% of production. If not,
   the *generator* is miscalibrated - fix `OPAC_SEARCHES_PER_HOUR` /
   `PRE_ALLOCATED_VUS` before reading anything into server metrics.
4. Then compare the server fingerprint at equal request rate. Suggested
   tolerances: ±20% on CPU, MySQL QPS, and endpoint mix percentages; ±25% on
   p95 latencies (note any hardware difference between prod and staging).

Within tolerance = the synthetic workload is a credible stand-in for real
usage, and you can trust what higher-rate runs say about capacity.

### Reading dropped_iterations

The arrival-rate executor doesn't queue work:

- Drops while latencies are still healthy = the VU pool is too small; raise
  `PRE_ALLOCATED_VUS` and re-run.
- Drops appearing only after latency climbs = real saturation; that's the
  server's capacity ceiling, not a test artifact.

## 4) Iterate

- Endpoint mix off (too many/few detail views, searches)? Adjust
  `CLICK_THROUGH_RATE` / `DETAIL_VIEWS_PER_SEARCH`, and check the bot filter
  didn't eat real traffic (STDERR bot percentage).
- Rates match but CPU/QPS don't? Look for cache-state differences: restart
  Koha/plack on staging, warm it for 5 minutes at low rate, then start the
  measured window. Confirm the staging bib DB matches production size.
- Think times or session shape off? Re-check the measurement window (school
  visits and OPAC kiosks have very different session shapes than evening
  at-home traffic).

## Known caveats

- Logged-in vs anonymous OPAC traffic isn't modeled separately; all synthetic
  sessions are anonymous.
- Cover images, cart/list actions, and ILS-DI/SIP side traffic are not
  generated.
- The staff-side workflow drives the REST API, not the staff CGI interface -
  it exercises circulation and the database, but underweights Template
  Toolkit rendering and session handling on the intranet.
- Zebra and Elasticsearch behave differently under identical query streams;
  validate against the same search engine production runs.
