/**
 * Koha OPAC HTTP Stress Test
 * 
 * Tests Koha OPAC (patron-facing catalog) under staged load.
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
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import * as reporting from "./lib/reporting.js";
import { weightedElement, sampleQuantiles, buildLoadOptions } from "./lib/utils.js";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const OPAC_URL = __ENV.OPAC_URL || "https://kohadev.localhost";
const OPAC_HOST_HEADER = __ENV.OPAC_HOST_HEADER || "";

// Extra header sent on every request, e.g. to skip a restricted ingress
// (Cloudflare bot rules). Required even from residential IPs on some
// deployments. Value from EXTERNAL_SERVICE_TOKEN.
const EXTERNAL_SERVICE_HEADER = __ENV.EXTERNAL_SERVICE_HEADER || "x-grafana-cloud-external-service";
const EXTERNAL_SERVICE_TOKEN = __ENV.EXTERNAL_SERVICE_TOKEN || "";

// Staged load test parameters
const MAX_VUS = parseInt(__ENV.MAX_VUS) || 150;
const VU_STEP = parseInt(__ENV.VU_STEP) || 10;
const RAMP_TIME = __ENV.RAMP_TIME || "5s";
const HOLD_TIME = __ENV.HOLD_TIME || "5s";
const ABORT_MS = parseInt(__ENV.KOHA_OPAC_ABORT_MS) || 8000;
const THRESHOLD_PERCENTILE = parseInt(__ENV.THRESHOLD_PERCENTILE) || 98;
const MAX_FAIL_CON_RATE = parseFloat(__ENV.KOHA_OPAC_MAX_FAIL_CON_RATE) || 0.05;
const REQUEST_TIMEOUT = __ENV.KOHA_OPAC_REQUEST_TIMEOUT || "15s";
const REQUEST_TIMEOUT_MS = parseInt(REQUEST_TIMEOUT) * 1000;
const HOLD_ON_FAIL = __ENV.HOLD_ON_FAIL || "30s";
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";
const SLOW_LOG_MS = parseInt(__ENV.KOHA_OPAC_SLOW_LOG_MS) || 3000;
const RESULTS_TO_CLICK = parseInt(__ENV.RESULTS_TO_CLICK) || 3;
const NO_CONNECTION_REUSE = ["1", "on", "true", "enabled"].includes((__ENV.NO_CONNECTION_REUSE || "").toLowerCase());

// Calibrated workload configuration (see docs/CALIBRATION.md). All optional -
// with none of these set, behavior is identical to the legacy staged test.
const SEARCH_TERMS_FILE = __ENV.SEARCH_TERMS_FILE || "";
const CALIBRATION_FILE = __ENV.CALIBRATION_FILE || "";
const SESSIONS_PER_HOUR = parseFloat(__ENV.SESSIONS_PER_HOUR) || 0;
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

// Search terms: weighted real patron queries when SEARCH_TERMS_FILE is set,
// falling back to uniform random dictionary words. Both are stored as
// { t: term, c: cumulative weight } for weightedElement().
const terms = new SharedArray("search terms", function () {
  if (SEARCH_TERMS_FILE) {
    try {
      const parsed = JSON.parse(open(`./${SEARCH_TERMS_FILE}`));
      let cum = 0;
      return parsed.terms.map((e) => {
        cum += e.w;
        return { t: e.t, c: cum };
      });
    } catch (e) {
      console.warn(`SEARCH_TERMS_FILE "${SEARCH_TERMS_FILE}" could not be loaded (${e}), FALLING BACK to words_alpha.txt`);
    }
  }
  return open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim()).map((t, i) => ({ t, c: i + 1 }));
});

const opacHeaders = {
  "User-Agent": "k6-stress-test",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
if (OPAC_HOST_HEADER) {
  opacHeaders["Host"] = OPAC_HOST_HEADER;
}
if (EXTERNAL_SERVICE_TOKEN) {
  opacHeaders[EXTERNAL_SERVICE_HEADER] = EXTERNAL_SERVICE_TOKEN;
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

// Open model (arrival rate) when a rate is configured, legacy staged
// closed model otherwise
const RATE_PER_HOUR = ARRIVAL_RATE ? ARRIVAL_RATE * 3600 : SESSIONS_PER_HOUR;
const LOAD_MODEL = RATE_PER_HOUR ? "open" : "staged";

export const options = {
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

export function setup() {
  console.log(`========================================`);
  console.log(`KOHA OPAC BENCHMARK TEST`);
  console.log(`========================================`);
  console.log(`OPAC_URL: ${OPAC_URL}`);
  if (OPAC_HOST_HEADER) {
    console.log(`OPAC_HOST_HEADER: ${OPAC_HOST_HEADER}`);
  }
  console.log(`LOAD_MODEL: ${LOAD_MODEL}${RATE_PER_HOUR ? ` (${RATE_PER_HOUR} sessions/hour, ${DURATION} steady state)` : ""}`);
  console.log(`SEARCH_TERMS: ${terms.length} entries (${SEARCH_TERMS_FILE || "words_alpha.txt"})`);
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
}

export function teardown() {
  console.log(`\n========================================`);
  console.log(`TEST COMPLETE`);
  console.log(`========================================`);
}

export default function () {
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

export function handleSummary(data) {
  const m = data.metrics;
  const abortReason = reporting.getAbortReason(data, {
    thresholdPercentile: THRESHOLD_PERCENTILE,
    abortMs: ABORT_MS,
    maxFailRate: MAX_FAIL_CON_RATE,
    peakVUs: __peakVUs,
    maxVUs: MAX_VUS,
  });
  const { totalRequests, testDuration, rps } = reporting.calculateDerivedMetrics(data);

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
      sessionsPerHour: RATE_PER_HOUR || null,
      searchTermsFile: SEARCH_TERMS_FILE || "(words_alpha.txt)",
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
      abortReason: abortReason,
    },
    timing: reporting.buildTimingSection(m, THRESHOLD_PERCENTILE),
    timingBreakdown: reporting.buildTimingBreakdown(m),
    dataTransfer: reporting.buildDataTransfer(m),
    checks: reporting.extractChecks(data),
  };

  const outputPath = OUTPUT_FILE || reporting.generateOutputPath("koha-opac", TEST_NUMBER);
  const customSummary = reporting.formatSummary(data, { peakVUs: __peakVUs, thresholdPercentile: THRESHOLD_PERCENTILE }) + `  Output: ${outputPath}\n`;

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + "\n" + customSummary,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}

