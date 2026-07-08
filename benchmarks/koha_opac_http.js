/**
 * koha_opac_http.js - Koha OPAC HTTP Stress Test
 *
 * Tests Koha OPAC (patron-facing catalog) under staged or arrival-rate load.
 * Uses HTTP requests only (no browser) for high-volume stress testing.
 *
 * Endpoints tested:
 * - OPAC homepage
 * - OPAC search
 * - OPAC record detail pages
 */
import http from "k6/http";
import { sleep, check } from "k6";
import { parseHTML } from "k6/html";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import secrets from "k6/secrets";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
// Inlined from lib/utils.js so this file is single-file and can be pasted
// into the Grafana Cloud script editor ( where its variables are editable and
// it re-runs from the web UI ).
function weightedElement(cumArr) {
  const r = Math.random() * cumArr[cumArr.length - 1].c;
  let lo = 0;
  let hi = cumArr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumArr[mid].c <= r) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return cumArr[lo].t;
}
function sampleQuantiles(q) {
  const u = Math.random() * (q.length - 1);
  const i = Math.floor(u);
  const f = u - i;
  return i + 1 < q.length ? q[i] + f * (q[i + 1] - q[i]) : q[i];
}
function buildLoadOptions(opts) {
  const { ratePerHour, duration, rampTime, preAllocatedVUs, maxVUs, gracefulStop, generateStages } = opts;
  if (!ratePerHour) {
    return { gracefulStop, stages: generateStages() };
  }
  const rate = Math.max(1, Math.round(ratePerHour));
  // Little's law estimate: concurrent sessions = rate x mean session length
  // (~90s), padded 1.5x. Tune via PRE_ALLOCATED_VUS if dropped_iterations > 0.
  const pool = preAllocatedVUs || Math.ceil((rate / 3600) * 90 * 1.5);
  return {
    scenarios: {
      open_model: {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: "1h",
        stages: [
          { duration: rampTime, target: rate },
          { duration: duration, target: rate },
          { duration: rampTime, target: 0 },
        ],
        preAllocatedVUs: pool,
        maxVUs: Math.max(pool, maxVUs || pool),
        gracefulStop,
      },
    },
  };
}

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const OPAC_URL = __ENV.OPAC_URL || "https://kohadev.localhost";
const OPAC_HOST_HEADER = __ENV.OPAC_HOST_HEADER || "";

// Extra header sent on every request, e.g. to skip a restricted ingress
// (Cloudflare bot rules). Required even from residential IPs on some
// deployments. Value from the EXTERNAL_SERVICE_TOKEN env var, or the Grafana
// Cloud secret named EXTERNAL_SERVICE_TOKEN_SECRET on cloud runs.
const EXTERNAL_SERVICE_HEADER = __ENV.EXTERNAL_SERVICE_HEADER || "x-grafana-cloud-external-service";
const EXTERNAL_SERVICE_TOKEN = __ENV.EXTERNAL_SERVICE_TOKEN || "";
const EXTERNAL_SERVICE_TOKEN_SECRET = __ENV.EXTERNAL_SERVICE_TOKEN_SECRET || "x-grafana-cloud-external-service-token";
// Resolved in setup() ( secrets.get is async ), threaded to the VU via data,
// and re-applied to opacHeaders per iteration.
let RESOLVED_TOKEN = EXTERNAL_SERVICE_TOKEN;
async function resolveToken() {
  if (EXTERNAL_SERVICE_TOKEN) return EXTERNAL_SERVICE_TOKEN;
  try { return await secrets.get(EXTERNAL_SERVICE_TOKEN_SECRET); }
  catch (e) { return ""; }
}

// Staged load test parameters
const MAX_VUS = parseInt(__ENV.MAX_VUS) || 150;
const VU_STEP = parseInt(__ENV.VU_STEP) || 10;
const RAMP_TIME = __ENV.RAMP_TIME || "5s";
const HOLD_TIME = __ENV.HOLD_TIME || "5s";
// Certification defaults: abort the run when the OPAC is clearly failing
// patrons. p95 ( not the twitchy p98 ) over 10s, or more than 5% of requests
// failing, both cleanly separate a loaded-but-usable OPAC ( ~6s p95, <1% fail
// in testing ) from a saturated one ( 15s timeouts, >50% fail ). For a
// characterization ladder, raise these so the run measures instead of aborting.
const ABORT_MS = parseInt(__ENV.KOHA_OPAC_ABORT_MS) || 10000;
const THRESHOLD_PERCENTILE = parseInt(__ENV.THRESHOLD_PERCENTILE) || 95;
const MAX_FAIL_CON_RATE = parseFloat(__ENV.KOHA_OPAC_MAX_FAIL_CON_RATE) || 0.05;
const REQUEST_TIMEOUT = __ENV.KOHA_OPAC_REQUEST_TIMEOUT || "15s";
const REQUEST_TIMEOUT_MS = parseInt(REQUEST_TIMEOUT) * 1000;
const HOLD_ON_FAIL = __ENV.HOLD_ON_FAIL || "30s";
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";

// Grafana Cloud test metadata. Without CLOUD_PROJECT_ID a cloud run lands in
// the org's default project ( and its VU limit ), not the project whose
// limit you raised - so set this to target a specific project.
const CLOUD_TEST_NAME = __ENV.CLOUD_TEST_NAME || "koha-opac";
const CLOUD_PROJECT_ID = __ENV.CLOUD_PROJECT_ID || "";
const SLOW_LOG_MS = parseInt(__ENV.KOHA_OPAC_SLOW_LOG_MS) || 3000;
const RESULTS_TO_CLICK = parseInt(__ENV.RESULTS_TO_CLICK) || 3;
const NO_CONNECTION_REUSE = ["1", "on", "true", "enabled"].includes((__ENV.NO_CONNECTION_REUSE || "").toLowerCase());

// Calibrated workload configuration (see docs/CALIBRATION.md). All optional -
// with none of these set, behavior is identical to the legacy staged test.
const CALIBRATION_FILE = __ENV.CALIBRATION_FILE || "";
// Optional: override the embedded terms with a weighted file of real extracted
// patron queries ( analyze-koha-logs.pl output ). Leave unset to use the
// self-contained embedded list.
const SEARCH_TERMS_FILE = __ENV.SEARCH_TERMS_FILE || "";
// Open-model target: actual opac-search.pl requests per hour ( the number the
// 12,929-peak requirement is stated in ). Converted to a session arrival rate
// internally, since a session issues more than one search.
const OPAC_SEARCHES_PER_HOUR = parseFloat(__ENV.OPAC_SEARCHES_PER_HOUR) || 0;
const ARRIVAL_RATE = parseFloat(__ENV.ARRIVAL_RATE) || 0;
const DURATION = __ENV.DURATION || "15m";
const PRE_ALLOCATED_VUS = parseInt(__ENV.PRE_ALLOCATED_VUS) || 0;
const CLICK_THROUGH_RATE = __ENV.CLICK_THROUGH_RATE ? parseFloat(__ENV.CLICK_THROUGH_RATE) : null;
const DETAIL_VIEWS_PER_SEARCH = __ENV.DETAIL_VIEWS_PER_SEARCH ? parseFloat(__ENV.DETAIL_VIEWS_PER_SEARCH) : null;
const THINK_TIME_CAP_S = 120;

// Think time configuration
const THINK_TIME_RAW = __ENV.THINK_TIME || "";
const THINK_TIME_DISABLED = ["0", "off", "false", "disabled"].includes(THINK_TIME_RAW.toLowerCase());
const THINK_TIME_FIXED = !THINK_TIME_DISABLED && THINK_TIME_RAW ? parseFloat(THINK_TIME_RAW) : null;

function thinkTime(maxRandom) {
  if (THINK_TIME_DISABLED) {
    return;
  }
  if (THINK_TIME_FIXED !== null) {
    sleep(THINK_TIME_FIXED);
  } else if (thinkQuantiles) {
    // Measured distribution; capped so a p100 outlier can't stall a VU
    sleep(Math.min(THINK_TIME_CAP_S, sampleQuantiles(thinkQuantiles)));
  } else {
    sleep(Math.random() * maxRandom);
  }
}

// How many search results to open. With a measured click-through rate the
// count is drawn per search: most searches click 0 or 1 results, with a
// geometric tail matching the measured detail views per search.
function sampleClickCount() {
  if (clickThroughRate === null) {
    return RESULTS_TO_CLICK;
  }
  if (Math.random() >= clickThroughRate) {
    return 0;
  }
  const meanPerClickingSearch =
    detailViewsPerSearch && clickThroughRate > 0
      ? Math.max(1, detailViewsPerSearch / clickThroughRate)
      : 1;
  const p = 1 / meanPerClickingSearch;
  let clicks = 1;
  while (clicks < 10 && Math.random() > p) {
    clicks++;
  }
  return clicks;
}

let __peakVUs = 0;

// Calibration data (optional): measured think times, click-through rate, and
// paging rate produced by bin/analyze-koha-logs.pl
let calibration = null;
if (CALIBRATION_FILE) {
  try {
    calibration = JSON.parse(open(`./${CALIBRATION_FILE}`));
  } catch (e) {
    console.warn(`CALIBRATION_FILE "${CALIBRATION_FILE}" could not be loaded (${e}), using built-in defaults`);
  }
}
const calSessions = (calibration && calibration.sessions) || {};
const thinkQuantiles = (calSessions.think_time_s && calSessions.think_time_s.quantiles) || null;
const clickThroughRate = CLICK_THROUGH_RATE !== null ? CLICK_THROUGH_RATE
  : (calSessions.click_through_rate != null ? calSessions.click_through_rate : null);
const detailViewsPerSearch = DETAIL_VIEWS_PER_SEARCH !== null ? DETAIL_VIEWS_PER_SEARCH
  : (calSessions.detail_views_per_search != null ? calSessions.detail_views_per_search : null);
// The subject browse step approximates result-page pagination; without
// calibration it runs every iteration (legacy behavior)
const browseProbability = calibration
  ? (calSessions.paging_rate != null ? calSessions.paging_rate : 0)
  : 1;

// Embedded search terms: common public-library queries that return large
// result sets - the expensive search-and-render path an OPAC capacity test
// must exercise ( random dictionary words return zero results and are cheap ).
// Weighted roughly by popularity. Kept in the script so the test is self-
// contained ( no data file to bundle ). Stored as { t: term, c: cumulative
// weight } for weightedElement().
const SEARCH_TERMS = [
  ["history", 12], ["mystery", 11], ["love", 10], ["children", 9],
  ["war", 8], ["biography", 8], ["science", 7], ["spanish", 6],
  ["cooking", 6], ["music", 5], ["james patterson", 5], ["harry potter", 5],
  ["art", 4], ["travel", 4],
];
// Embedded terms by default; a SEARCH_TERMS_FILE ( weighted { t, w } JSON from
// analyze-koha-logs.pl ) overrides them for calibration replay. SharedArray so
// a large extracted list isn't copied per VU.
const terms = new SharedArray("search terms", function () {
  if (SEARCH_TERMS_FILE) {
    try {
      const parsed = JSON.parse(open(`./${SEARCH_TERMS_FILE}`));
      let cum = 0;
      return parsed.terms.map(function (e) {
        cum += e.w;
        return { t: e.t, c: cum };
      });
    } catch (e) {
      console.warn(`SEARCH_TERMS_FILE "${SEARCH_TERMS_FILE}" could not be loaded (${e}), using embedded terms`);
    }
  }
  let cum = 0;
  return SEARCH_TERMS.map(function (e) {
    cum += e[1];
    return { t: e[0], c: cum };
  });
});

const opacHeaders = {
  "User-Agent": "k6-stress-test",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
if (OPAC_HOST_HEADER) {
  opacHeaders["Host"] = OPAC_HOST_HEADER;
}
if (RESOLVED_TOKEN) {
  opacHeaders[EXTERNAL_SERVICE_HEADER] = RESOLVED_TOKEN;
}

const opacParams = {
  headers: opacHeaders,
  timeout: REQUEST_TIMEOUT,
  noConnectionReuse: NO_CONNECTION_REUSE,
};

function logRequestStatus(res, label, vus) {
  const duration = res.timings.duration;
  if (res.status !== 200) {
    const isTimeout = duration >= REQUEST_TIMEOUT_MS - 100;
    const failType = isTimeout ? "TIMEOUT" : "FAILED";
    console.log(`${failType} [${vus} VUs] ${label}: ${duration.toFixed(0)}ms - status=${res.status} error="${res.error || 'none'}"`);
  } else if (duration > SLOW_LOG_MS) {
    console.log(`SLOW [${vus} VUs] ${label}: ${duration.toFixed(0)}ms`);
  }
}

function generateStages() {
  const stages = [];
  for (let vus = VU_STEP; vus <= MAX_VUS; vus += VU_STEP) {
    stages.push({ duration: RAMP_TIME, target: vus });
    stages.push({ duration: HOLD_TIME, target: vus });
  }
  stages.push({ duration: RAMP_TIME, target: 0 });
  return stages;
}

// A session issues one main search plus, when browseProbability fires, one
// subject-browse search - both hit opac-search.pl and count toward
// OPAC_SEARCHES_PER_HOUR. Convert the target search rate to a session rate.
const SEARCHES_PER_SESSION = 1 + browseProbability;
const SESSIONS_PER_HOUR = OPAC_SEARCHES_PER_HOUR ? OPAC_SEARCHES_PER_HOUR / SEARCHES_PER_SESSION : 0;

// Open model (arrival rate) when a rate is configured, legacy staged
// closed model otherwise
const RATE_PER_HOUR = ARRIVAL_RATE ? ARRIVAL_RATE * 3600 : SESSIONS_PER_HOUR;
const LOAD_MODEL = RATE_PER_HOUR ? "open" : "staged";

const cloudConfig = { name: CLOUD_TEST_NAME };
if (CLOUD_PROJECT_ID) {
  cloudConfig.projectID = parseInt(CLOUD_PROJECT_ID);
}

export const options = {
  cloud: cloudConfig,
  insecureSkipTLSVerify: true,
  ...buildLoadOptions({
    ratePerHour: RATE_PER_HOUR,
    duration: DURATION,
    rampTime: RAMP_TIME,
    preAllocatedVUs: PRE_ALLOCATED_VUS,
    maxVUs: MAX_VUS,
    gracefulStop: "10s",
    generateStages,
  }),
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", `p(${THRESHOLD_PERCENTILE})`],
  thresholds: {
    http_req_duration: [
      {
        threshold: `p(${THRESHOLD_PERCENTILE})<${ABORT_MS}`,
        abortOnFail: true,
        delayAbortEval: HOLD_ON_FAIL,
      },
    ],
    http_req_failed: [
      {
        threshold: `rate<${MAX_FAIL_CON_RATE}`,
        abortOnFail: true,
        delayAbortEval: HOLD_ON_FAIL,
      },
    ],
  },
};

export async function setup() {
  RESOLVED_TOKEN = await resolveToken();
  if (RESOLVED_TOKEN) opacHeaders[EXTERNAL_SERVICE_HEADER] = RESOLVED_TOKEN;
  console.log(`========================================`);
  console.log(`KOHA OPAC BENCHMARK TEST`);
  console.log(`========================================`);
  console.log(`OPAC_URL: ${OPAC_URL}`);
  console.log(`${EXTERNAL_SERVICE_HEADER}: ${RESOLVED_TOKEN ? `set (${EXTERNAL_SERVICE_TOKEN ? "from env" : "from Grafana Cloud secret"})` : "not sent"}`);
  if (OPAC_HOST_HEADER) {
    console.log(`OPAC_HOST_HEADER: ${OPAC_HOST_HEADER}`);
  }
  console.log(`LOAD_MODEL: ${LOAD_MODEL}${RATE_PER_HOUR ? ` (${OPAC_SEARCHES_PER_HOUR} searches/hour = ${RATE_PER_HOUR.toFixed(0)} sessions/hour x ${SEARCHES_PER_SESSION} searches, ${DURATION} steady state)` : ""}`);
  console.log(`SEARCH_TERMS: ${terms.length} terms (${SEARCH_TERMS_FILE || "embedded"})`);
  if (CALIBRATION_FILE) {
    console.log(`CALIBRATION_FILE: ${CALIBRATION_FILE}${calibration ? "" : " (FAILED TO LOAD, using defaults)"}`);
  }
  if (clickThroughRate !== null) {
    console.log(`CLICK_THROUGH_RATE: ${clickThroughRate}, DETAIL_VIEWS_PER_SEARCH: ${detailViewsPerSearch !== null ? detailViewsPerSearch : "(1 per clicking search)"}, BROWSE_PROBABILITY: ${browseProbability}`);
  } else {
    console.log(`RESULTS_TO_CLICK: ${RESULTS_TO_CLICK}`);
  }
  console.log(`MAX_VUS: ${MAX_VUS}, VU_STEP: ${VU_STEP}`);
  console.log(`RAMP_TIME: ${RAMP_TIME}, HOLD_TIME: ${HOLD_TIME}`);
  console.log(`ABORT_MS: ${ABORT_MS} (abort test when p(${THRESHOLD_PERCENTILE}) exceeds this)`);
  console.log(`MAX_FAIL_CON_RATE: ${(MAX_FAIL_CON_RATE * 100).toFixed(0)}% (abort test when failure rate exceeds this)`);
  console.log(`SLOW_LOG_MS: ${SLOW_LOG_MS} (log slow requests to console)`);
  console.log(`REQUEST_TIMEOUT: ${REQUEST_TIMEOUT}`);
  console.log(`HOLD_ON_FAIL: ${HOLD_ON_FAIL}`);
  const thinkTimeStatus = THINK_TIME_DISABLED ? "disabled" : (THINK_TIME_FIXED !== null ? `${THINK_TIME_FIXED}s fixed` : "random");
  console.log(`THINK_TIME: ${thinkTimeStatus}`);
  console.log(`NO_CONNECTION_REUSE: ${NO_CONNECTION_REUSE}`);
  console.log(`========================================`);

  // Verify OPAC connectivity
  const opacTest = http.get(OPAC_URL, opacParams);
  if (opacTest.status !== 200) {
    console.warn(`WARNING: OPAC connectivity test failed (status=${opacTest.status}). Check OPAC_URL.`);
  } else {
    console.log(`OPAC connectivity OK`);
  }
  return { token: RESOLVED_TOKEN };
}

export function teardown() {
  console.log(`\n========================================`);
  console.log(`TEST COMPLETE`);
  console.log(`========================================`);
}

export default function (data) {
  // Per-VU: adopt the token setup resolved ( env or secret ) so the ingress
  // header goes out on this VU's requests
  if (data && data.token && RESOLVED_TOKEN !== data.token) {
    RESOLVED_TOKEN = data.token;
    opacHeaders[EXTERNAL_SERVICE_HEADER] = RESOLVED_TOKEN;
  }
  const currentVUs = exec.instance.vusActive;
  if (currentVUs > __peakVUs) {
    __peakVUs = currentVUs;
  }

  // Unique per-iteration User-Agent so analyze-koha-logs.pl can reconstruct
  // each synthetic session from the target's access log during validation
  // (the client IP is always the load generator's)
  const iterParams = Object.assign({}, opacParams, {
    headers: Object.assign({}, opacHeaders, {
      "User-Agent": `k6-stress-test/${exec.vu.idInTest}-${exec.vu.iterationInScenario}`,
    }),
  });

  const searchTerm = weightedElement(terms);

  // OPAC homepage
  const opacHomeRes = http.get(OPAC_URL, iterParams);
  logRequestStatus(opacHomeRes, "OPAC homepage", currentVUs);
  check(opacHomeRes, {
    "OPAC homepage loaded": (r) => r.status === 200,
  });

  thinkTime(2);

  // OPAC search
  const opacSearchUrl = `${OPAC_URL}/cgi-bin/koha/opac-search.pl?q=${encodeURIComponent(searchTerm)}`;
  const opacSearchRes = http.get(opacSearchUrl, iterParams);
  logRequestStatus(opacSearchRes, `OPAC search "${searchTerm}"`, currentVUs);
  check(opacSearchRes, {
    "OPAC search completed": (r) => r.status === 200,
    "OPAC search < 500ms": (r) => r.timings.duration < 500,
    "OPAC search < 1000ms": (r) => r.timings.duration < 1000,
    "OPAC search < 2000ms": (r) => r.timings.duration < 2000,
  });

  thinkTime(3);

  // Parse and click on search results
  const doc = parseHTML(opacSearchRes.body);
  const resultLinks = [];
  doc.find(".title a, .record-title a, td.title a").each((idx, el) => {
    const href = el.attr("href");
    if (href && href.includes("opac-detail")) {
      resultLinks.push(href);
    }
  });

  if (resultLinks.length > 0) {
    const clickCount = Math.min(sampleClickCount(), resultLinks.length);

    for (let i = 0; i < clickCount; i++) {
      const idx = Math.floor(Math.random() * resultLinks.length);
      let recordUrl = resultLinks[idx];
      if (recordUrl.startsWith("/")) {
        recordUrl = `${OPAC_URL}${recordUrl}`;
      }

      const recordRes = http.get(recordUrl, iterParams);
      logRequestStatus(recordRes, `OPAC record detail ${i + 1}/${clickCount}`, currentVUs);
      check(recordRes, {
        "OPAC record loaded": (r) => r.status === 200,
      });

      thinkTime(5);
    }
  }

  // Browse by subject (common OPAC action). With calibration loaded this is
  // gated by the measured paging rate so searches per session match reality.
  if (Math.random() < browseProbability) {
    const browseUrl = `${OPAC_URL}/cgi-bin/koha/opac-search.pl?idx=su&q=${encodeURIComponent(searchTerm)}`;
    const browseRes = http.get(browseUrl, iterParams);
    logRequestStatus(browseRes, `OPAC subject browse "${searchTerm}"`, currentVUs);
    check(browseRes, {
      "OPAC subject browse completed": (r) => r.status === 200,
    });

    thinkTime(3);
  }

  // Advanced search page
  const advSearchRes = http.get(`${OPAC_URL}/cgi-bin/koha/opac-search.pl`, iterParams);
  logRequestStatus(advSearchRes, "OPAC advanced search page", currentVUs);
  check(advSearchRes, {
    "OPAC advanced search page loaded": (r) => r.status === 200,
  });

  thinkTime(2);
}

// Self-contained summary ( lib/reporting.js is not imported, so the file stays
// single-file for the script editor ). handleSummary does not run on Grafana
// Cloud anyway; this covers local runs. The rich terminal formatter that used
// to live in reporting.js is dropped - k6's built-in textSummary carries the
// percentiles and rates, and the JSON below carries the config and checks.
export function handleSummary(data) {
  const m = data.metrics;
  const dur = m.http_req_duration ? m.http_req_duration.values : {};
  const pKey = `p(${THRESHOLD_PERCENTILE})`;
  const totalRequests = m.http_reqs?.values?.count || 0;
  const rps = m.http_reqs?.values?.rate?.toFixed(2) || null;
  const testDuration = rps && parseFloat(rps) > 0
    ? totalRequests / parseFloat(rps)
    : (data.state?.testRunDurationMs ? data.state.testRunDurationMs / 1000 : 0);

  const checks = {};
  if (data.root_group?.checks) {
    for (const c of data.root_group.checks) {
      const total = c.passes + c.fails;
      checks[c.name] = {
        passes: c.passes,
        fails: c.fails,
        rate: total > 0 ? `${((c.passes / total) * 100).toFixed(1)}%` : "N/A",
      };
    }
  }

  const summary = {
    metadata: {
      testScript: "koha_opac_http.js",
      testNumber: TEST_NUMBER,
      timestamp: new Date().toISOString(),
    },
    config: {
      opacUrl: OPAC_URL,
      opacHostHeader: OPAC_HOST_HEADER || "(not set)",
      loadModel: LOAD_MODEL,
      opacSearchesPerHour: OPAC_SEARCHES_PER_HOUR || null,
      sessionsPerHour: RATE_PER_HOUR ? Number(RATE_PER_HOUR.toFixed(0)) : null,
      searchTerms: terms.length + (SEARCH_TERMS_FILE ? ` (${SEARCH_TERMS_FILE})` : " embedded"),
      calibrationFile: CALIBRATION_FILE || "(not set)",
      clickThroughRate: clickThroughRate !== null ? clickThroughRate : "(legacy RESULTS_TO_CLICK)",
      resultsToClick: RESULTS_TO_CLICK,
      thinkTime: THINK_TIME_DISABLED ? "disabled" : (THINK_TIME_FIXED !== null ? `${THINK_TIME_FIXED}s` : "random"),
      maxVUs: MAX_VUS,
      vuStep: VU_STEP,
      rampTime: RAMP_TIME,
      holdTime: HOLD_TIME,
      abortMs: ABORT_MS,
      thresholdPercentile: THRESHOLD_PERCENTILE,
      maxFailRate: `${(MAX_FAIL_CON_RATE * 100).toFixed(0)}%`,
      slowLogMs: SLOW_LOG_MS,
      requestTimeout: REQUEST_TIMEOUT,
      holdOnFail: HOLD_ON_FAIL,
      noConnectionReuse: NO_CONNECTION_REUSE,
    },
    thresholds: {
      httpReqDuration: `p(${THRESHOLD_PERCENTILE})<${ABORT_MS}ms`,
      httpReqFailed: `rate<${(MAX_FAIL_CON_RATE * 100).toFixed(0)}%`,
    },
    result: {
      peakVUs: __peakVUs || m.vus?.values?.max || 0,
      configuredMaxVUs: MAX_VUS,
      testDuration_s: testDuration.toFixed(2),
      requestsPerSecond: rps,
      totalRequests: totalRequests,
      totalIterations: m.iterations?.values?.count || 0,
      failureRate: `${((m.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%`,
    },
    timing_ms: {
      med: dur.med != null ? dur.med.toFixed(0) : null,
      p90: dur["p(90)"] != null ? dur["p(90)"].toFixed(0) : null,
      [pKey]: dur[pKey] != null ? dur[pKey].toFixed(0) : null,
      max: dur.max != null ? dur.max.toFixed(0) : null,
    },
    checks: checks,
  };

  const now = new Date();
  const outputDir = __ENV.OUTPUT_DIR || "/output";
  const outputPath = OUTPUT_FILE ||
    `${outputDir}/koha-opac-${TEST_NUMBER}-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${now.toISOString().slice(11, 16).replace(/:/g, "")}.json`;

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + `\n  Output: ${outputPath}\n`,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}

