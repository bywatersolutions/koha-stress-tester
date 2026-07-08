# Capacity model: how many concurrent staff a Koha box holds

The training-session tests (`koha_training_browser.js`, `koha_training_protocol.js`)
don't just pass or fail - run them up a ladder of `LIBRARIANS` values and they
map a server's saturation curve. This note is the model that curve follows,
how to read it, and the worked example from PWPL.

## The model

Koha's staff interface runs behind a fixed pool of Starman (Plack) workers.
The pool size is the number of requests it can process **at once**; request
N+1 queues behind them. So a lockstep burst of `N` staff all doing the same
action produces:

```
p95 latency  ≈  ceil(N / workers) × single_request_time
```

That's it. The curve is stair-stepped in units of the worker count. A burst
that fits in one batch (`N ≤ workers`) is fast; each additional batch adds
one more `single_request_time` to the tail.

Find the worker count on the box:

```
ps aux | grep starman        # count the "starman worker" lines, or read --workers
nproc                        # CPU cores - the real ceiling (see below)
```

Workers are usually ~2× cores (one worker uses the CPU while another waits on
a query). **Raising workers past that mostly spreads the same cores thinner** -
it helps only to the extent requests idle on I/O (search backend, DB). If the
database is fast (check `SHOW STATUS LIKE 'Threads_running'` - low means the DB
isn't the bottleneck), staff requests are CPU-bound on Template Toolkit
rendering, and **more cores, not more workers, is the real lever.**

## Reading the curve

Run the protocol test up a ladder (it's cheap - no browsers - so one generator
drives hundreds of VUs):

```bash
for N in 25 50 75 100; do
  LIBRARIANS=$N ./bin/run-with-env.sh          # protocol test, STEP_INTERVAL_S=30
done
```

Read `training_step_duration{step:...}` p95 per step. Use `checkout` and
`place_hold` (heavy writes) and `catalog_search` (heavy read) - they show
saturation first. `login`/`patron_search`/`logout` stay flat (light, and login
is staggered) so they're not the signal.

The **safe unstaggered class size** is where p95 crosses your tolerance
(~10s): roughly `2 × workers` (two batches). Beyond that, latency climbs
linearly and eventually requests start failing.

## Worked example: PWPL (becoming production)

Box: **8 cores, 16 Starman workers, 16 GB RAM**, MariaDB `max_connections=5000`
(idle - `Threads_running=1`, so the DB is not the constraint). Origin at
Rackspace Dallas behind Cloudflare.

Measured `checkout` p95 vs the model (`single_request_time ≈ 3.2s`):

| concurrent staff | measured p95 | `ceil(N/16) × 3.2s` |
| ---------------- | ------------ | ------------------- |
| 3 (baseline)     | 3.2s         | 3.2s                |
| 50               | 13.1s        | 12.8s               |
| 75               | 20.7s        | 16s (+ per-req slowdown) |
| 100              | 23.1s        | 22.4s               |

The 16-worker model predicts the curve almost exactly. `place_hold` degrades
faster still at 100 (26s) because 100 concurrent holds on **one** bib add row-
lock contention on top of worker queuing.

**Verdict for PWPL:** safe unstaggered lockstep class ≈ **30**. That covers the
50-person training requirement **only if the trainer staggers actions** (which
they do - spreading a class's clicks over 60-90s keeps the instantaneous burst
near the 16 lanes). For the 78-workstation daily-operations requirement, normal
varied work rarely produces >16 truly-simultaneous requests, so the box is
likely fine - but that should be certified with a steady-state (arrival-rate)
run, not the lockstep test.

## The three levers (cheapest first)

1. **Stagger training actions (free).** Real trainers already do this. Spread a
   class's actions over 60-90s and the instantaneous burst stays inside the
   worker pool. For all-at-once demos, cap the group near `2 × workers`.
2. **Raise workers a little (cheap, test it).** RAM and DB usually allow it.
   Helps only for the I/O-wait fraction of a request; measure before/after, and
   raise `--max-requests` alongside (e.g. to 1000) so workers don't cold-recycle
   mid-class. Not a fix for a CPU-bound ceiling.
3. **More cores (the real fix for big bursts).** Target: safe lockstep class
   ≈ `4 × cores`. PWPL at 8 cores → ~30; 16 cores + 32 workers → ~60; 20 cores
   → ~75.

## Daily operations: the shared pool ( staff + patron together )

Training is pre-go-live ( staff only ). In daily operations the staff interface
and the public catalog **share the same worker pool**, so they contend.
`koha_steady_state.js` runs both as concurrent arrival-rate streams and reports
each side's per-request p95 separately, so you can find the sustainable combined
operating point ( "the box sustains X staff txn/hr + Y patron sessions/hr at
acceptable latency" ).

The load shapes come from real access logs across **12 ByWater libraries**, not
a guess:
- **Staff** = a weighted write-heavy action mix: checkin ( `returns.pl` ~40% ),
  checkout ( `circulation.pl` ~24% ), biblio detail ~13%, catalog search ~9%,
  holds ~4%, cataloging ~3%, patron lookup ~3%. Checkin/checkout are real
  writes; the action checks an item out and back in ( self-cleaning ), and
  teardown force-returns any straggler.
- **Patron** = `PATRON_MODE`: `aspen` ( default; 10/12 libraries front the
  catalog with Aspen Discovery, so patron load is Aspen's Koha-API calls -
  patron account plus the `checkouts/{id}/allows_renewal` polling that
  dominates ) or `opac` ( direct Koha OPAC CGI browse - for the 2/12 libraries
  like hccc/helm, and PWPL ).

Method: hold one side at a realistic baseline and raise the other until either
`http_req_duration{scenario:staff}` or `{scenario:patron}` p95 crosses the SLO
or `dropped_iterations` appear. Because the whole point is that these share the
pool, watch how adding patron load pushes up *staff* latency and vice versa.

## Sizing rule of thumb

```
safe unstaggered lockstep class  ≈  2 × workers  ≈  4 × cores
```

For any new partner box: count workers and cores, apply the rule, and if the
target class size exceeds it, either stagger the training or add cores before
go-live.

## Caveats

- These numbers are the **lockstep worst case** (everyone acts together). Daily
  operations at the same headcount are far lighter.
- At large `LIBRARIANS`, the tests' setup screens many records via sequential
  REST calls; raise `SETUP_TIMEOUT_S` (default 600) if setup is slow, and on
  macOS raise the shell `ulimit -n` before very large local runs.
- The protocol test reproduces the dynamic CGI/REST load the origin sees
  (assets are CDN-cached); it does not measure client render time. Use the
  browser test at 15-30 VUs for that.
