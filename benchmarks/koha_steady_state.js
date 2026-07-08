/**
 * Koha Steady-State Combined Test ( daily operations )
 *
 * Post-go-live, the staff interface and the patron catalog share one
 * Starman/Plack worker pool. This test runs both loads at once, as independent
 * arrival-rate streams, to measure how they contend for that pool - the real
 * daily-ops scenario. The load shapes are modeled on real access logs from 12
 * ByWater Koha libraries ( see docs/CAPACITY.md ), not a synthetic guess.
 *
 * Two concurrent scenarios:
 *   - staff:  a weighted action mix from the logs - checkin (~40%), checkout
 *             (~24%), biblio detail (~13%), catalog search (~9%), holds (~4%),
 *             patron lookup (~3%), cataloging (~3%). Checkin/checkout are real
 *             writes ( self-cleaning: check out then check back in ).
 *   - patron: PATRON_MODE selects the public-catalog shape:
 *       aspen ( default, 10/12 libraries ) - emulate Aspen Discovery's load on
 *         Koha's REST API: patron account + the checkouts/allows_renewal
 *         polling that dominates ( ~56% of Aspen's Koha calls ).
 *       opac ( direct Koha OPAC, e.g. PWPL, hccc, helm ) - opac-main -> search
 *         -> detail -> subject browse CGI.
 *
 * Vary STAFF_TRANSACTIONS_PER_HOUR and PATRON_SESSIONS_PER_HOUR to find the
 * sustainable combined operating point. Self-contained single file - pasteable
 * into the Grafana Cloud script editor.
 *
 * Requirements: superlibrarian ( STAFF_USER/STAFF_PASS ) with RESTBasicAuth
 * enabled; the ingress header token if behind Cloudflare; a staging clone, not
 * production ( it checks items out/in to real patrons ).
 */
import http from "k6/http";
import { sleep, check } from "k6";
import { parseHTML } from "k6/html";
import exec from "k6/execution";
import { b64encode } from "k6/encoding";
import { Trend, Rate } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

// ------------------------------------------------------------
// ENVIRONMENT
// ------------------------------------------------------------
const STAFF_URL = __ENV.STAFF_URL || "http://kohadev-intra.localhost";
const OPAC_URL = __ENV.OPAC_URL || "http://kohadev.localhost";
const STAFF_HOST_HEADER = __ENV.STAFF_HOST_HEADER || "";
const OPAC_HOST_HEADER = __ENV.OPAC_HOST_HEADER || "";
const [STAFF_PROTOCOL, STAFF_HOST] = STAFF_URL.split("://");
const STAFF_BASE_URL = `${STAFF_PROTOCOL}://${STAFF_HOST}`;
const STAFF_USER = __ENV.STAFF_USER || "koha";
const STAFF_PASS = __ENV.STAFF_PASS || "koha";
const API = `${STAFF_PROTOCOL}://${STAFF_HOST}/api/v1`;
const CGI = `${STAFF_BASE_URL}/cgi-bin/koha`;

const STAFF_TRANSACTIONS_PER_HOUR = parseFloat(__ENV.STAFF_TRANSACTIONS_PER_HOUR) || 1000;
const PATRON_MODE = (__ENV.PATRON_MODE || "aspen").toLowerCase();
const PATRON_SESSIONS_PER_HOUR = parseFloat(__ENV.PATRON_SESSIONS_PER_HOUR) || 2000;
// opac mode: a session issues 2 searches, so its session rate = searches/2
const OPAC_SEARCHES_PER_HOUR = parseFloat(__ENV.OPAC_SEARCHES_PER_HOUR) || 0;

const DURATION = __ENV.DURATION || "5m";
const RAMP_TIME = __ENV.RAMP_TIME || "30s";
const THINK_S = parseFloat(__ENV.THINK_S) || 1;
const STAFF_MAX_VUS = parseInt(__ENV.STAFF_MAX_VUS) || 0;
const PATRON_MAX_VUS = parseInt(__ENV.PATRON_MAX_VUS) || 0;

const P95_MS = parseInt(__ENV.P95_MS) || 10000;

const EXTERNAL_SERVICE_HEADER = __ENV.EXTERNAL_SERVICE_HEADER || "x-grafana-cloud-external-service";
const EXTERNAL_SERVICE_TOKEN = __ENV.EXTERNAL_SERVICE_TOKEN || "";

const CLOUD_TEST_NAME = __ENV.CLOUD_TEST_NAME || "koha-steady-state";
const CLOUD_PROJECT_ID = __ENV.CLOUD_PROJECT_ID || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";

// Embedded high-hit terms ( large result sets = the expensive render path )
const SEARCH_TERMS = [
  ["history", 12], ["mystery", 11], ["love", 10], ["children", 9],
  ["war", 8], ["biography", 8], ["science", 7], ["spanish", 6],
  ["cooking", 6], ["music", 5], ["james patterson", 5], ["harry potter", 5],
  ["art", 4], ["travel", 4],
];
const terms = (function () {
  let cum = 0;
  return SEARCH_TERMS.map(function (e) { cum += e[1]; return { t: e[0], c: cum }; });
})();
function weightedTerm() {
  const r = Math.random() * terms[terms.length - 1].c;
  let lo = 0, hi = terms.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (terms[mid].c <= r) lo = mid + 1; else hi = mid; }
  return terms[lo].t;
}

// Staff action weights ( from the 12-library aggregate, normalized )
const STAFF_ACTIONS = [
  ["circulation", 64], // checkout + checkin ( returns.pl 40% + circulation.pl 24% )
  ["detail", 13],
  ["search", 9],
  ["holds", 4],
  ["cataloging", 3],
  ["patron", 3],
];
const staffActions = (function () {
  let cum = 0;
  return STAFF_ACTIONS.map(function (e) { cum += e[1]; return { a: e[0], c: cum }; });
})();
function weightedStaffAction() {
  const r = Math.random() * staffActions[staffActions.length - 1].c;
  for (const e of staffActions) if (r < e.c) return e.a;
  return "detail";
}

// ------------------------------------------------------------
// METRICS ( per scenario )
// ------------------------------------------------------------
const staffDuration = new Trend("staff_iteration_duration", true);
const patronDuration = new Trend("patron_session_duration", true);
const staffFailed = new Rate("staff_failed");
const patronFailed = new Rate("patron_failed");

// ------------------------------------------------------------
// OPTIONS - two concurrent arrival-rate scenarios
// ------------------------------------------------------------
function poolFor(ratePerHour, override) {
  // Generous ( 45s x 2 ) so dropped_iterations means the server saturated,
  // not the pool was too small. Override with *_MAX_VUS if drops appear healthy.
  return override || Math.ceil((ratePerHour / 3600) * 45 * 2);
}
const staffRate = Math.max(1, Math.round(STAFF_TRANSACTIONS_PER_HOUR));
const patronRate = Math.max(1, Math.round(OPAC_SEARCHES_PER_HOUR && PATRON_MODE === "opac"
  ? OPAC_SEARCHES_PER_HOUR / 2
  : PATRON_SESSIONS_PER_HOUR));
const staffPool = poolFor(staffRate, STAFF_MAX_VUS);
const patronPool = poolFor(patronRate, PATRON_MAX_VUS);

const cloudConfig = { name: CLOUD_TEST_NAME };
if (CLOUD_PROJECT_ID) cloudConfig.projectID = parseInt(CLOUD_PROJECT_ID);

function arrivalScenario(execName, rate, pool) {
  return {
    executor: "ramping-arrival-rate",
    exec: execName,
    startRate: 0,
    timeUnit: "1h",
    stages: [
      { duration: RAMP_TIME, target: rate },
      { duration: DURATION, target: rate },
      { duration: RAMP_TIME, target: 0 },
    ],
    preAllocatedVUs: pool,
    maxVUs: pool,
    gracefulStop: "15s",
  };
}

export const options = {
  cloud: cloudConfig,
  insecureSkipTLSVerify: true,
  scenarios: {
    staff: arrivalScenario("staffTransaction", staffRate, staffPool),
    patron: arrivalScenario("patronSession", patronRate, patronPool),
  },
  thresholds: {
    "http_req_duration{scenario:staff}": [`p(95)<${P95_MS}`],
    "http_req_duration{scenario:patron}": [`p(95)<${P95_MS}`],
    "staff_failed": ["rate<0.05"],
    "patron_failed": ["rate<0.05"],
  },
};

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------
function baseHeaders(accept) {
  const h = { Accept: accept };
  if (EXTERNAL_SERVICE_TOKEN) h[EXTERNAL_SERVICE_HEADER] = EXTERNAL_SERVICE_TOKEN;
  return h;
}
function pageParams(contentType) {
  const h = baseHeaders("text/html");
  if (contentType) h["Content-Type"] = contentType;
  if (STAFF_HOST_HEADER) h["Host"] = STAFF_HOST_HEADER;
  return { headers: h, tags: { scenario: "staff" } };
}
function staffApiParams() {
  const h = baseHeaders("application/json");
  h["Authorization"] = `Basic ${b64encode(`${STAFF_USER}:${STAFF_PASS}`)}`;
  if (STAFF_HOST_HEADER) h["Host"] = STAFF_HOST_HEADER;
  return { headers: h, tags: { scenario: "staff" } };
}
function patronApiParams() {
  const h = baseHeaders("application/json");
  h["Authorization"] = `Basic ${b64encode(`${STAFF_USER}:${STAFF_PASS}`)}`;
  if (STAFF_HOST_HEADER) h["Host"] = STAFF_HOST_HEADER;
  return { headers: h, tags: { scenario: "patron" } };
}
function opacParams() {
  const h = baseHeaders("text/html,application/xhtml+xml,*/*;q=0.8");
  if (OPAC_HOST_HEADER) h["Host"] = OPAC_HOST_HEADER;
  return { headers: h, tags: { scenario: "patron" } };
}
function csrfFrom(body) {
  const tag = body && body.match(/<input[^>]*name="csrf_token"[^>]*>/i);
  if (!tag) return null;
  const v = tag[0].match(/value="([^"]*)"/i);
  return v ? v[1] : null;
}
function jsonQ(obj) { return encodeURIComponent(JSON.stringify(obj)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ------------------------------------------------------------
// SETUP - shared pools of patrons, items, biblios
// ------------------------------------------------------------
export function setup() {
  console.log("========================================");
  console.log("KOHA STEADY-STATE COMBINED TEST");
  console.log("========================================");
  console.log(`STAFF_URL: ${STAFF_URL}`);
  console.log(`PATRON_MODE: ${PATRON_MODE}${PATRON_MODE === "opac" ? ` (OPAC_URL ${OPAC_URL})` : " (Aspen REST API emulation)"}`);
  console.log(`staff:  ${staffRate} txn/hour (pool ${staffPool} workstations, each logs in once)`);
  console.log(`patron: ${patronRate} sessions/hour (pool ${patronPool})`);
  console.log(`${EXTERNAL_SERVICE_HEADER}: ${EXTERNAL_SERVICE_TOKEN ? "set" : "not sent"}`);
  console.log("========================================");

  const params = staffApiParams();
  const must = (res, what) => {
    if (res.status !== 200) {
      const hint = String(res.body || "").includes("Basic authentication disabled")
        ? " - enable RESTBasicAuth on the target" : "";
      throw new Error(`${what} failed (${res.status})${hint}`);
    }
    return res.json();
  };

  const staffRes = http.get(`${API}/patrons?q=${jsonQ({ userid: STAFF_USER })}`, params);
  const staffPatron = must(staffRes, "Loading staff user")[0];
  const staffBranch = staffPatron ? staffPatron.library_id : "";

  // Patrons: id + cardnumber
  const patronsRes = http.get(`${API}/patrons?_per_page=100`, params);
  const patrons = must(patronsRes, "Loading patrons")
    .filter((p) => p.cardnumber && !p.expired && !p.restricted)
    .map((p) => ({ id: p.patron_id, card: p.cardnumber }))
    .slice(0, 60);
  if (patrons.length < 5) throw new Error(`Need >=5 usable patrons, found ${patrons.length}`);

  // Available items for the circulation action ( not checked out / lost / etc )
  const itemFilter = { lost_status: 0, not_for_loan_status: 0, withdrawn: 0, damaged_status: 0 };
  const itemsRes = http.get(`${API}/items?q=${jsonQ(itemFilter)}&_per_page=200`, params);
  const items = [];
  const biblioIds = new Set();
  for (const it of must(itemsRes, "Loading items")) {
    if (!it.external_id) continue;
    items.push({ id: it.item_id, barcode: it.external_id });
    if (it.biblio_id) biblioIds.add(it.biblio_id);
    if (items.length >= 80) break;
  }
  if (items.length < 5) throw new Error(`Need >=5 available items, found ${items.length}`);

  console.log(`Pools: ${patrons.length} patrons, ${items.length} items, ${biblioIds.size} biblios; staff branch ${staffBranch}`);
  return { staffBranch, patrons, items, biblioIds: Array.from(biblioIds).slice(0, 40) };
}

// ------------------------------------------------------------
// STAFF TRANSACTION - one action per iteration on a persistent login
// ------------------------------------------------------------
// A VU models a workstation: it logs in ONCE ( real stations stay logged in to
// one account all day, they don't re-auth per transaction ) and reuses the
// session cookie across iterations. So logins scale with the number of active
// workstations ( ~ the VU pool ), not with the transaction rate - matching the
// logs, where mainpage.pl login is only ~3% of staff requests.
let staffLoggedIn = false; // module-level = per-VU in k6

function ensureStaffLogin(pp) {
  if (staffLoggedIn) return true;
  const form = http.get(`${CGI}/mainpage.pl`, pp);
  const csrf = csrfFrom(form.body);
  if (!csrf) return false;
  const login = http.post(`${CGI}/mainpage.pl`, {
    csrf_token: csrf, login_op: "cud-login", koha_login_context: "intranet",
    login_userid: STAFF_USER, login_password: STAFF_PASS, branch: "",
  }, pageParams("application/x-www-form-urlencoded"));
  staffLoggedIn = login.status === 200 && login.body.includes("loggedinusername");
  return staffLoggedIn;
}

export function staffTransaction(data) {
  const started = Date.now();
  let ok = true;
  const pp = pageParams();
  try {
    if (!ensureStaffLogin(pp)) {
      ok = false;
    } else {
      ok = staffAction(weightedStaffAction(), data, pp);
      sleep(THINK_S);
    }
  } catch (e) {
    ok = false;
    staffLoggedIn = false; // force re-login next iteration on any error
  } finally {
    staffDuration.add(Date.now() - started);
    staffFailed.add(!ok);
    check(ok, { "staff transaction ok": (v) => v === true });
  }
}

function staffAction(action, data, pp) {
  if (action === "circulation") {
    // checkout an available item to a patron, then check it back in ( self-cleaning )
    const patron = pick(data.patrons);
    const item = pick(data.items);
    const page = http.get(`${CGI}/circ/circulation.pl?borrowernumber=${patron.id}`, pp);
    const csrf = csrfFrom(page.body);
    if (!csrf) return false;
    const co = http.post(`${CGI}/circ/circulation.pl`, {
      csrf_token: csrf, op: "cud-checkout", restoreduedatespec: "", barcode: item.barcode,
      duedatespec: "", borrowernumber: String(patron.id), branch: data.staffBranch, debt_confirmed: "1",
    }, pageParams("application/x-www-form-urlencoded"));
    // Confirm it actually went out, then check it back in and verify it went
    // in ( retry once ) - concurrent VUs share the item pool, so be defensive
    const stillOut = () => {
      const c = http.get(`${API}/checkouts?q=${jsonQ({ item_id: item.id })}`, staffApiParams());
      return c.status === 200 && c.json().length > 0;
    };
    if (stillOut()) {
      for (let attempt = 0; attempt < 2 && stillOut(); attempt++) {
        const ret = http.get(`${CGI}/circ/returns.pl`, pp);
        const rcsrf = csrfFrom(ret.body);
        http.post(`${CGI}/circ/returns.pl`, { csrf_token: rcsrf, barcode: item.barcode, op: "cud-checkin" },
          pageParams("application/x-www-form-urlencoded"));
      }
    }
    return co.status === 200;
  }
  if (action === "search") {
    const r = http.get(`${CGI}/catalogue/search.pl?q=${encodeURIComponent(weightedTerm())}`, pp);
    return r.status === 200;
  }
  if (action === "detail") {
    if (!data.biblioIds.length) return true;
    const r = http.get(`${CGI}/catalogue/detail.pl?biblionumber=${pick(data.biblioIds)}`, pp);
    return r.status === 200;
  }
  if (action === "holds") {
    if (!data.biblioIds.length) return true;
    const r = http.get(`${CGI}/reserve/request.pl?biblionumber=${pick(data.biblioIds)}`, pp);
    return r.status === 200;
  }
  if (action === "cataloging") {
    if (!data.biblioIds.length) return true;
    const r = http.get(`${CGI}/catalogue/moredetail.pl?biblionumber=${pick(data.biblioIds)}`, pp);
    return r.status === 200;
  }
  if (action === "patron") {
    const r = http.get(`${CGI}/members/moremember.pl?borrowernumber=${pick(data.patrons).id}`, pp);
    return r.status === 200;
  }
  return true;
}

// ------------------------------------------------------------
// PATRON SESSION - aspen ( API ) or opac ( CGI )
// ------------------------------------------------------------
export function patronSession(data) {
  const started = Date.now();
  let ok = true;
  try {
    ok = PATRON_MODE === "opac" ? opacBrowse() : aspenAccount(data);
  } catch (e) {
    ok = false;
  } finally {
    patronDuration.add(Date.now() - started);
    patronFailed.add(!ok);
    check(ok, { "patron session ok": (v) => v === true });
  }
}

// Emulate Aspen loading a patron's account: profile, fines, checkouts, and the
// per-checkout allows_renewal polling that dominates real Aspen->Koha traffic.
function aspenAccount(data) {
  const ap = patronApiParams();
  const patron = pick(data.patrons);
  let ok = true;
  const p = http.get(`${API}/patrons/${patron.id}`, ap);
  ok = ok && p.status === 200;
  sleep(THINK_S);
  http.get(`${API}/patrons/${patron.id}/account`, ap);
  const co = http.get(`${API}/checkouts?q=${jsonQ({ patron_id: patron.id })}&_per_page=50`, ap);
  if (co.status === 200) {
    for (const c of co.json()) {
      http.get(`${API}/checkouts/${c.checkout_id}/allows_renewal`, ap);
    }
  } else {
    ok = false;
  }
  return ok;
}

function opacBrowse() {
  const op = opacParams();
  const term = weightedTerm();
  const home = http.get(`${OPAC_URL}/cgi-bin/koha/opac-main.pl`, op);
  if (home.status !== 200) return false;
  sleep(THINK_S);
  const sr = http.get(`${OPAC_URL}/cgi-bin/koha/opac-search.pl?q=${encodeURIComponent(term)}`, op);
  if (sr.status !== 200) return false;
  sleep(THINK_S);
  const doc = parseHTML(sr.body);
  let href = null;
  doc.find(".title a, .record-title a, td.title a").each((i, el) => {
    const h = el.attr("href");
    if (!href && h && h.includes("opac-detail")) href = h;
  });
  if (href) {
    const url = href.startsWith("/") ? `${OPAC_URL}${href}` : href;
    http.get(url, op);
    sleep(THINK_S);
  }
  const br = http.get(`${OPAC_URL}/cgi-bin/koha/opac-search.pl?idx=su&q=${encodeURIComponent(term)}`, op);
  return br.status === 200;
}

// ------------------------------------------------------------
// TEARDOWN - return anything the circulation action left checked out
// ------------------------------------------------------------
export function teardown(data) {
  const params = staffApiParams();
  const stillOut = (item) => {
    const res = http.get(`${API}/checkouts?q=${jsonQ({ item_id: item.id })}`, params);
    return res.status === 200 && res.json().length > 0;
  };
  const lingering = data.items.filter(stillOut);
  if (lingering.length) {
    // Log in and force each straggler back in ( interrupted / raced circulation
    // actions ) so the run never leaves real items checked out
    const pp = pageParams();
    const form = http.get(`${CGI}/mainpage.pl`, pp);
    const csrf = csrfFrom(form.body);
    http.post(`${CGI}/mainpage.pl`, {
      csrf_token: csrf, login_op: "cud-login", koha_login_context: "intranet",
      login_userid: STAFF_USER, login_password: STAFF_PASS, branch: "",
    }, pageParams("application/x-www-form-urlencoded"));
    let returned = 0;
    for (const item of lingering) {
      for (let attempt = 0; attempt < 2 && stillOut(item); attempt++) {
        const ret = http.get(`${CGI}/circ/returns.pl`, pp);
        http.post(`${CGI}/circ/returns.pl`, { csrf_token: csrfFrom(ret.body), barcode: item.barcode, op: "cud-checkin" },
          pageParams("application/x-www-form-urlencoded"));
      }
      if (!stillOut(item)) returned++;
    }
    console.log(`teardown: returned ${returned}/${lingering.length} lingering checkouts`);
    const stuck = lingering.filter(stillOut).map((i) => i.barcode);
    if (stuck.length) console.warn(`STILL checked out, scan manually: ${stuck.join(", ")}`);
  }
  console.log("========================================");
  console.log("STEADY-STATE TEST COMPLETE");
  console.log("========================================");
}

// ------------------------------------------------------------
// SUMMARY ( self-contained )
// ------------------------------------------------------------
export function handleSummary(data) {
  const m = data.metrics;
  const reqDur = (scenario) => {
    const t = m[`http_req_duration{scenario:${scenario}}`];
    const v = t ? t.values : {};
    return { med_ms: v.med != null ? v.med.toFixed(0) : null, p95_ms: v["p(95)"] != null ? v["p(95)"].toFixed(0) : null, max_ms: v.max != null ? v.max.toFixed(0) : null };
  };
  const summary = {
    metadata: { testScript: "koha_steady_state.js", testNumber: TEST_NUMBER, timestamp: new Date().toISOString() },
    config: {
      staffUrl: STAFF_URL, patronMode: PATRON_MODE,
      staffTransactionsPerHour: staffRate, patronSessionsPerHour: patronRate,
      duration: DURATION, p95Ms: P95_MS,
    },
    result: {
      staff: Object.assign(reqDur("staff"), {
        iterations: m.staff_iteration_duration?.values?.count || 0,
        failRate: `${((m.staff_failed?.values?.rate || 0) * 100).toFixed(2)}%`,
      }),
      patron: Object.assign(reqDur("patron"), {
        sessions: m.patron_session_duration?.values?.count || 0,
        failRate: `${((m.patron_failed?.values?.rate || 0) * 100).toFixed(2)}%`,
      }),
      droppedIterations: m.dropped_iterations?.values?.count || 0,
      httpReqFailed: `${((m.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%`,
    },
  };
  const now = new Date();
  const outputDir = __ENV.OUTPUT_DIR || "/output";
  const path = OUTPUT_FILE ||
    `${outputDir}/koha-steady-state-${TEST_NUMBER}-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${now.toISOString().slice(11, 16).replace(/:/g, "")}.json`;
  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + `\n  Output: ${path}\n`,
    [path]: JSON.stringify(summary, null, 2),
  };
}
