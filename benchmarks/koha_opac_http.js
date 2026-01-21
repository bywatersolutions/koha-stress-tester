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
import { randomElement } from "./lib/utils.js";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const OPAC_URL = __ENV.OPAC_URL || "https://kohadev.localhost";
const OPAC_HOST_HEADER = __ENV.OPAC_HOST_HEADER || "";

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
  } else {
    sleep(Math.random() * maxRandom);
  }
}

let __peakVUs = 0;

const words = new SharedArray("words", function () {
  return open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim());
});

const opacHeaders = {
  "User-Agent": "k6-stress-test",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
if (OPAC_HOST_HEADER) {
  opacHeaders["Host"] = OPAC_HOST_HEADER;
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

export const options = {
  insecureSkipTLSVerify: true,
  gracefulStop: "10s",
  stages: generateStages(),
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
  console.log(`RESULTS_TO_CLICK: ${RESULTS_TO_CLICK}`);
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

  const searchTerm = randomElement(words);

  // OPAC homepage
  const opacHomeRes = http.get(OPAC_URL, opacParams);
  logRequestStatus(opacHomeRes, "OPAC homepage", currentVUs);
  check(opacHomeRes, {
    "OPAC homepage loaded": (r) => r.status === 200,
  });

  thinkTime(2);

  // OPAC search
  const opacSearchUrl = `${OPAC_URL}/cgi-bin/koha/opac-search.pl?q=${encodeURIComponent(searchTerm)}`;
  const opacSearchRes = http.get(opacSearchUrl, opacParams);
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
    const clickCount = Math.min(RESULTS_TO_CLICK, resultLinks.length);
    
    for (let i = 0; i < clickCount; i++) {
      const idx = Math.floor(Math.random() * resultLinks.length);
      let recordUrl = resultLinks[idx];
      if (recordUrl.startsWith("/")) {
        recordUrl = `${OPAC_URL}${recordUrl}`;
      }

      const recordRes = http.get(recordUrl, opacParams);
      logRequestStatus(recordRes, `OPAC record detail ${i + 1}/${clickCount}`, currentVUs);
      check(recordRes, {
        "OPAC record loaded": (r) => r.status === 200,
      });

      thinkTime(5);
    }
  }

  // Browse by subject (common OPAC action)
  const browseUrl = `${OPAC_URL}/cgi-bin/koha/opac-search.pl?idx=su&q=${encodeURIComponent(searchTerm)}`;
  const browseRes = http.get(browseUrl, opacParams);
  logRequestStatus(browseRes, `OPAC subject browse "${searchTerm}"`, currentVUs);
  check(browseRes, {
    "OPAC subject browse completed": (r) => r.status === 200,
  });

  thinkTime(3);

  // Advanced search page
  const advSearchRes = http.get(`${OPAC_URL}/cgi-bin/koha/opac-search.pl`, opacParams);
  logRequestStatus(advSearchRes, "OPAC advanced search page", currentVUs);
  check(advSearchRes, {
    "OPAC advanced search page loaded": (r) => r.status === 200,
  });

  thinkTime(2);
}

export function handleSummary(data) {
  const m = data.metrics;
  const abortReason = reporting.getAbortReason(data);
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

