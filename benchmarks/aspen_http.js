/**
 * aspen_http.js - Aspen Discovery HTTP Stress Test
 *
 * Tests an Aspen Discovery front-end under a staged VU ramp, HTTP only ( no
 * browser ), for high-volume stress testing. Each iteration loads the homepage,
 * runs a keyword search against /Union/Search, and opens a few result records -
 * the expensive search-and-render path an Aspen capacity test must exercise.
 *
 * Self-contained ( only remote imports ) so it pastes into the Grafana Cloud
 * script editor: clone it ( Save as... ), edit the RUN CONFIG values, click Run.
 */
import http from "k6/http";
import { sleep, check } from "k6";
import { parseHTML } from "k6/html";
import exec from "k6/execution";
import encoding from "k6/encoding";
import secrets from "k6/secrets";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

// Inlined from lib/utils.js so this file is single-file for the script editor.
function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ══════════════════════════════════════════════════════════════════════
//  ▶ HOW TO RUN: clone this test ( Save as… ), set the values in the
//    RUN CONFIG block below, then click Run.
// ══════════════════════════════════════════════════════════════════════
// ─── RUN CONFIG ( edit these ) ────────────────────────────────────────
const ASPEN_BASE_URL = __ENV.ASPEN_BASE_URL || "https://aspen.localhost"; // <<< SET: Aspen Discovery URL to test
const ASPEN_HOST_HEADER = __ENV.ASPEN_HOST_HEADER || ""; // <<< SET: Host header if Aspen is behind a proxy ( blank if not )
const MAX_VUS = parseInt(__ENV.MAX_VUS) || 300; // <<< SET: peak concurrent virtual users to ramp up to
// ──────────────────────────────────────────────────────────────────────

// Extra header sent on every request, e.g. to skip a restricted ingress
// ( Cloudflare bot rules ). Value from the EXTERNAL_SERVICE_TOKEN env var, or
// the Grafana Cloud secret named EXTERNAL_SERVICE_TOKEN_SECRET on cloud runs.
const EXTERNAL_SERVICE_HEADER = __ENV.EXTERNAL_SERVICE_HEADER || "x-grafana-cloud-external-service";
const EXTERNAL_SERVICE_TOKEN = __ENV.EXTERNAL_SERVICE_TOKEN || "";
const EXTERNAL_SERVICE_TOKEN_SECRET = __ENV.EXTERNAL_SERVICE_TOKEN_SECRET || "x-grafana-cloud-external-service-token";
// Resolved in setup() ( secrets.get is async ), threaded to the VU via data,
// and re-applied to baseHeaders per iteration.
let RESOLVED_TOKEN = EXTERNAL_SERVICE_TOKEN;
async function resolveToken() {
  if (EXTERNAL_SERVICE_TOKEN) return EXTERNAL_SERVICE_TOKEN;
  try { return await secrets.get(EXTERNAL_SERVICE_TOKEN_SECRET); }
  catch (e) { return ""; }
}

// Staged load test parameters
const RESULTS_TO_CLICK = parseInt(__ENV.RESULTS_TO_CLICK) || 5;
const VU_STEP = parseInt(__ENV.VU_STEP) || 10;
const RAMP_TIME = __ENV.RAMP_TIME || "5s";
const HOLD_TIME = __ENV.HOLD_TIME || "5s";
const ABORT_MS = parseInt(__ENV.ASPEN_ABORT_MS) || 12000;
const THRESHOLD_PERCENTILE = parseInt(__ENV.THRESHOLD_PERCENTILE) || 98;
const MAX_FAIL_CON_RATE = parseFloat(__ENV.ASPEN_MAX_FAIL_CON_RATE) || 0.05;
const REQUEST_TIMEOUT = __ENV.ASPEN_REQUEST_TIMEOUT || "10s";
const REQUEST_TIMEOUT_MS = parseInt(REQUEST_TIMEOUT) * 1000;
const HOLD_ON_FAIL = __ENV.HOLD_ON_FAIL || "30s";
const SLOW_LOG_MS = parseInt(__ENV.ASPEN_SLOW_LOG_MS) || 6000;
const NO_CONNECTION_REUSE = ["1", "on", "true", "enabled"].includes((__ENV.NO_CONNECTION_REUSE || "").toLowerCase());
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";

// Grafana Cloud test metadata. Without CLOUD_PROJECT_ID a cloud run lands in
// the org's default project ( and its VU limit ), not the project whose limit
// you raised - so set this to target a specific project.
const CLOUD_TEST_NAME = __ENV.CLOUD_TEST_NAME || "aspen-http";
const CLOUD_PROJECT_ID = __ENV.CLOUD_PROJECT_ID || "";

// Think time configuration
const THINK_TIME_RAW = __ENV.THINK_TIME || "";
const THINK_TIME_DISABLED = ["0", "off", "false", "disabled"].includes(THINK_TIME_RAW.toLowerCase());
const THINK_TIME_FIXED = !THINK_TIME_DISABLED && THINK_TIME_RAW ? parseFloat(THINK_TIME_RAW) : null;

function thinkTime(maxRandom) {
  if (THINK_TIME_DISABLED) return;
  if (THINK_TIME_FIXED !== null) sleep(THINK_TIME_FIXED);
  else sleep(Math.random() * maxRandom);
}

// Solr configuration ( optional - for capturing backend system info at the end
// of the run ). Inlined from lib/solr.js. Leave SOLR_URL blank to skip.
const SOLR_URL = __ENV.SOLR_URL || "";
const SOLR_USER = __ENV.SOLR_USER || "";
const SOLR_PASS = __ENV.SOLR_PASS || "";
function getSolrHeaders(user, pass) {
  const headers = { "Accept": "application/json" };
  if (user && pass) headers["Authorization"] = `Basic ${encoding.b64encode(`${user}:${pass}`)}`;
  return headers;
}
function fetchSolrSystemInfo(solrUrl, headers) {
  try {
    const res = http.get(`${solrUrl}/solr/admin/info/system?wt=json`, { headers, timeout: "10s" });
    if (res.status === 200) return JSON.parse(res.body);
  } catch (e) {
    return { error: `Could not fetch: ${e.message}` };
  }
  return null;
}
const solrHeaders = SOLR_URL ? getSolrHeaders(SOLR_USER, SOLR_PASS) : null;
let __finalSolrSystemInfo = null;

// Embedded search terms: common public-library queries that return large result
// sets - the expensive search-and-render path a discovery-layer capacity test
// must exercise ( random dictionary words return zero results and are cheap ).
// Kept in the script so the test is self-contained ( no data file to bundle ).
const SEARCH_TERMS = [
  "history", "mystery", "love", "children", "war", "biography", "science",
  "spanish", "cooking", "music", "james patterson", "harry potter", "art",
  "travel", "gardening", "poetry", "business", "health", "religion", "dogs",
  "space", "dinosaurs", "baseball", "photography", "shakespeare", "recipes",
];

let __peakVUs = 0;

const baseHeaders = {
  "User-Agent": "k6-stress-test",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
if (ASPEN_HOST_HEADER) baseHeaders["Host"] = ASPEN_HOST_HEADER;
if (RESOLVED_TOKEN) baseHeaders[EXTERNAL_SERVICE_HEADER] = RESOLVED_TOKEN;

const params = {
  headers: baseHeaders,
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

const cloudConfig = { name: CLOUD_TEST_NAME };
if (CLOUD_PROJECT_ID) cloudConfig.projectID = parseInt(CLOUD_PROJECT_ID);

export const options = {
  cloud: cloudConfig,
  insecureSkipTLSVerify: true,
  gracefulStop: "10s", // Allow iterations to complete cleanly
  stages: generateStages(),
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", `p(${THRESHOLD_PERCENTILE})`],
  thresholds: {
    http_req_duration: [
      { threshold: `p(${THRESHOLD_PERCENTILE})<${ABORT_MS}`, abortOnFail: true, delayAbortEval: HOLD_ON_FAIL },
    ],
    http_req_failed: [
      { threshold: `rate<${MAX_FAIL_CON_RATE}`, abortOnFail: true, delayAbortEval: HOLD_ON_FAIL },
    ],
  },
};

export async function setup() {
  RESOLVED_TOKEN = await resolveToken();
  if (RESOLVED_TOKEN) baseHeaders[EXTERNAL_SERVICE_HEADER] = RESOLVED_TOKEN;
  console.log(`========================================`);
  console.log(`ASPEN HTTP BENCHMARK TEST`);
  console.log(`========================================`);
  console.log(`ASPEN_BASE_URL: ${ASPEN_BASE_URL}`);
  if (ASPEN_HOST_HEADER) console.log(`ASPEN_HOST_HEADER: ${ASPEN_HOST_HEADER}`);
  console.log(`${EXTERNAL_SERVICE_HEADER}: ${RESOLVED_TOKEN ? `set (${EXTERNAL_SERVICE_TOKEN ? "from env" : "from Grafana Cloud secret"})` : "not sent"}`);
  console.log(`MAX_VUS: ${MAX_VUS}, VU_STEP: ${VU_STEP}`);
  console.log(`RAMP_TIME: ${RAMP_TIME}, HOLD_TIME: ${HOLD_TIME}`);
  console.log(`ABORT_MS: ${ABORT_MS} (abort test when p(${THRESHOLD_PERCENTILE}) exceeds this)`);
  console.log(`MAX_FAIL_CON_RATE: ${(MAX_FAIL_CON_RATE * 100).toFixed(0)}% (abort test when failure rate exceeds this)`);
  console.log(`SLOW_LOG_MS: ${SLOW_LOG_MS} (log slow requests to console)`);
  console.log(`REQUEST_TIMEOUT: ${REQUEST_TIMEOUT}`);
  const thinkTimeStatus = THINK_TIME_DISABLED ? "disabled" : (THINK_TIME_FIXED !== null ? `${THINK_TIME_FIXED}s fixed` : "random");
  console.log(`THINK_TIME: ${thinkTimeStatus}`);
  console.log(`SOLR_URL: ${SOLR_URL || "(not configured)"}`);
  console.log(`========================================`);

  const homeTest = http.get(ASPEN_BASE_URL, params);
  if (homeTest.status !== 200) {
    console.warn(`WARNING: connectivity test failed (status=${homeTest.status}). Check ASPEN_BASE_URL.`);
  } else {
    console.log(`connectivity OK`);
  }
  return { token: RESOLVED_TOKEN };
}

export function teardown() {
  console.log(`\n========================================`);
  console.log(`TEST COMPLETE`);
  console.log(`========================================`);
  if (SOLR_URL) {
    console.log(`Capturing Solr system info...`);
    __finalSolrSystemInfo = fetchSolrSystemInfo(SOLR_URL, solrHeaders);
    if (__finalSolrSystemInfo && !__finalSolrSystemInfo.error) {
      console.log(`  Load average: ${__finalSolrSystemInfo.system?.systemLoadAverage}`);
      console.log(`  Memory used: ${__finalSolrSystemInfo.jvm?.memory?.used}`);
    }
  }
}

export default function (data) {
  // Per-VU: adopt the token setup resolved ( env or secret ) so the ingress
  // header goes out on this VU's requests
  if (data && data.token && RESOLVED_TOKEN !== data.token) {
    RESOLVED_TOKEN = data.token;
    baseHeaders[EXTERNAL_SERVICE_HEADER] = RESOLVED_TOKEN;
  }
  const currentVUs = exec.instance.vusActive;
  if (currentVUs > __peakVUs) __peakVUs = currentVUs;

  const searchTerm = randomElement(SEARCH_TERMS);

  const homeRes = http.get(ASPEN_BASE_URL, params);
  logRequestStatus(homeRes, "homepage", currentVUs);
  check(homeRes, { "homepage loaded": (r) => r.status === 200 });

  thinkTime(3);

  const searchUrl = `${ASPEN_BASE_URL}/Union/Search?view=list&lookfor=${encodeURIComponent(searchTerm)}&searchIndex=Keyword&searchSource=local`;
  const searchRes = http.get(searchUrl, params);
  logRequestStatus(searchRes, `search "${searchTerm}"`, currentVUs);
  check(searchRes, {
    "search completed": (r) => r.status === 200,
    "response < 500ms": (r) => r.timings.duration < 500,
    "response < 1000ms": (r) => r.timings.duration < 1000,
    "response < 2000ms": (r) => r.timings.duration < 2000,
  });

  thinkTime(10);

  const doc = parseHTML(searchRes.body);
  const resultLinks = [];
  doc.find(".result-title a").each((idx, el) => {
    const href = el.attr("href");
    if (href) resultLinks.push(href);
  });

  const clickCount = Math.min(RESULTS_TO_CLICK, resultLinks.length);
  for (let i = 0; i < clickCount; i++) {
    const idx = Math.floor(Math.random() * resultLinks.length);
    let recordUrl = resultLinks[idx];
    if (recordUrl.startsWith("/")) recordUrl = `${ASPEN_BASE_URL}${recordUrl}`;

    const recordRes = http.get(recordUrl, params);
    logRequestStatus(recordRes, "record", currentVUs);
    check(recordRes, { "record loaded": (r) => r.status === 200 });

    thinkTime(10);
    thinkTime(3);
  }
}

// Self-contained summary ( lib/reporting.js is not imported, so the file stays
// single-file for the script editor ). handleSummary does not run on Grafana
// Cloud anyway; this covers local runs. k6's built-in textSummary carries the
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
      testScript: "aspen_http.js",
      testNumber: TEST_NUMBER,
      timestamp: new Date().toISOString(),
    },
    config: {
      baseUrl: ASPEN_BASE_URL,
      hostHeader: ASPEN_HOST_HEADER || "(not set)",
      maxVUs: MAX_VUS,
      vuStep: VU_STEP,
      rampTime: RAMP_TIME,
      holdTime: HOLD_TIME,
      abortMs: ABORT_MS,
      thresholdPercentile: THRESHOLD_PERCENTILE,
      maxFailRate: `${(MAX_FAIL_CON_RATE * 100).toFixed(0)}%`,
      slowLogMs: SLOW_LOG_MS,
      requestTimeout: REQUEST_TIMEOUT,
      thinkTime: THINK_TIME_DISABLED ? "disabled" : (THINK_TIME_FIXED !== null ? `${THINK_TIME_FIXED}s` : "random"),
      noConnectionReuse: NO_CONNECTION_REUSE,
      solrUrl: SOLR_URL || "(not configured)",
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
    solrSystem: SOLR_URL ? (__finalSolrSystemInfo || fetchSolrSystemInfo(SOLR_URL, solrHeaders)) : null,
  };

  const now = new Date();
  const outputDir = __ENV.OUTPUT_DIR || "/output";
  const outputPath = OUTPUT_FILE ||
    `${outputDir}/aspen-${TEST_NUMBER}-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${now.toISOString().slice(11, 16).replace(/:/g, "")}.json`;

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + `\n  Output: ${outputPath}\n`,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}
