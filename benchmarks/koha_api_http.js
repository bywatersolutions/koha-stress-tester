/**
 * Koha REST API Read-Only Stress Test
 * 
 * Tests Koha REST API under staged load with read-only queries.
 * Uses HTTP requests only (no browser) for high-volume stress testing.
 * 
 * Endpoints tested (GET only):
 * - libraries, patron_categories, item_types
 * - biblios search, patrons list
 * - checkouts, holds
 * 
 * For workflow testing (CRUD + circulation), use koha_workflow_http.js
 */
import http from "k6/http";
import { sleep, check } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import encoding from "k6/encoding";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import * as reporting from "./lib/reporting.js";
import { randomElement } from "./lib/utils.js";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const STAFF_URL = __ENV.STAFF_URL || "https://kohadev-intra.localhost";
const STAFF_HOST_HEADER = __ENV.STAFF_HOST_HEADER || "";
const STAFF_USER = __ENV.STAFF_USER || "koha";
const STAFF_PASS = __ENV.STAFF_PASS || "koha";

// Staged load test parameters
const MAX_VUS = parseInt(__ENV.MAX_VUS) || 150;
const VU_STEP = parseInt(__ENV.VU_STEP) || 10;
const RAMP_TIME = __ENV.RAMP_TIME || "5s";
const HOLD_TIME = __ENV.HOLD_TIME || "5s";
const ABORT_MS = parseInt(__ENV.KOHA_API_ABORT_MS) || 5000;
const THRESHOLD_PERCENTILE = parseInt(__ENV.THRESHOLD_PERCENTILE) || 98;
const MAX_FAIL_CON_RATE = parseFloat(__ENV.KOHA_API_MAX_FAIL_CON_RATE) || 0.05;
const REQUEST_TIMEOUT = __ENV.KOHA_API_REQUEST_TIMEOUT || "10s";
const REQUEST_TIMEOUT_MS = parseInt(REQUEST_TIMEOUT) * 1000;
const HOLD_ON_FAIL = __ENV.HOLD_ON_FAIL || "30s";
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";
const SLOW_LOG_MS = parseInt(__ENV.KOHA_API_SLOW_LOG_MS) || 2000;

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

const apiHeaders = {
  "Authorization": "Basic " + encoding.b64encode(`${STAFF_USER}:${STAFF_PASS}`),
  "Accept": "application/json",
  "User-Agent": "k6-stress-test",
};
if (STAFF_HOST_HEADER) {
  apiHeaders["Host"] = STAFF_HOST_HEADER;
}

const apiParams = {
  headers: apiHeaders,
  timeout: REQUEST_TIMEOUT,
};

function logRequestStatus(res, label, vus) {
  const duration = res.timings.duration;
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
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
  console.log(`KOHA API READ-ONLY BENCHMARK TEST`);
  console.log(`========================================`);
  console.log(`STAFF_URL: ${STAFF_URL}`);
  if (STAFF_HOST_HEADER) {
    console.log(`STAFF_HOST_HEADER: ${STAFF_HOST_HEADER}`);
  }
  console.log(`STAFF_USER: ${STAFF_USER}`);
  console.log(`MAX_VUS: ${MAX_VUS}, VU_STEP: ${VU_STEP}`);
  console.log(`RAMP_TIME: ${RAMP_TIME}, HOLD_TIME: ${HOLD_TIME}`);
  console.log(`ABORT_MS: ${ABORT_MS} (abort test when p(${THRESHOLD_PERCENTILE}) exceeds this)`);
  console.log(`MAX_FAIL_CON_RATE: ${(MAX_FAIL_CON_RATE * 100).toFixed(0)}% (abort test when failure rate exceeds this)`);
  console.log(`SLOW_LOG_MS: ${SLOW_LOG_MS} (log slow requests to console)`);
  console.log(`REQUEST_TIMEOUT: ${REQUEST_TIMEOUT}`);
  console.log(`HOLD_ON_FAIL: ${HOLD_ON_FAIL}`);
  const thinkTimeStatus = THINK_TIME_DISABLED ? "disabled" : (THINK_TIME_FIXED !== null ? `${THINK_TIME_FIXED}s fixed` : "random");
  console.log(`THINK_TIME: ${thinkTimeStatus}`);
  console.log(`========================================`);

  // Verify API connectivity
  const apiTest = http.get(`${STAFF_URL}/api/v1/libraries?_per_page=1`, apiParams);
  if (apiTest.status !== 200) {
    console.warn(`WARNING: API connectivity test failed (status=${apiTest.status}). Check STAFF_URL and credentials.`);
  } else {
    console.log(`API connectivity OK`);
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

  // GET libraries
  const librariesRes = http.get(`${STAFF_URL}/api/v1/libraries?_per_page=50`, apiParams);
  logRequestStatus(librariesRes, "API: libraries", currentVUs);
  check(librariesRes, {
    "API libraries loaded": (r) => r.status === 200,
    "API libraries < 500ms": (r) => r.timings.duration < 500,
    "API libraries < 1000ms": (r) => r.timings.duration < 1000,
  });

  thinkTime(1);

  // GET patron categories
  const categoriesRes = http.get(`${STAFF_URL}/api/v1/patron_categories?_per_page=50`, apiParams);
  logRequestStatus(categoriesRes, "API: patron_categories", currentVUs);
  check(categoriesRes, {
    "API patron_categories loaded": (r) => r.status === 200,
  });

  thinkTime(1);

  // GET item types
  const itemTypesRes = http.get(`${STAFF_URL}/api/v1/item_types?_per_page=50`, apiParams);
  logRequestStatus(itemTypesRes, "API: item_types", currentVUs);
  check(itemTypesRes, {
    "API item_types loaded": (r) => r.status === 200,
  });

  thinkTime(1);

  // Search biblios via API
  const bibliosRes = http.get(`${STAFF_URL}/api/v1/biblios?_per_page=20&q={"title":{"-like":"%${searchTerm}%"}}`, apiParams);
  logRequestStatus(bibliosRes, `API: biblios search "${searchTerm}"`, currentVUs);
  check(bibliosRes, {
    "API biblios search completed": (r) => r.status === 200 || r.status === 404,
  });

  thinkTime(2);

  // List patrons via API
  const patronsRes = http.get(`${STAFF_URL}/api/v1/patrons?_per_page=20`, apiParams);
  logRequestStatus(patronsRes, "API: patrons list", currentVUs);
  check(patronsRes, {
    "API patrons list completed": (r) => r.status === 200,
  });

  thinkTime(2);

  // GET checkouts (circulation data)
  const checkoutsRes = http.get(`${STAFF_URL}/api/v1/checkouts?_per_page=20`, apiParams);
  logRequestStatus(checkoutsRes, "API: checkouts list", currentVUs);
  check(checkoutsRes, {
    "API checkouts list completed": (r) => r.status === 200,
  });

  thinkTime(2);

  // GET holds
  const holdsRes = http.get(`${STAFF_URL}/api/v1/holds?_per_page=20`, apiParams);
  logRequestStatus(holdsRes, "API: holds list", currentVUs);
  check(holdsRes, {
    "API holds list completed": (r) => r.status === 200,
  });

  thinkTime(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const abortReason = reporting.getAbortReason(data);
  const { totalRequests, testDuration, rps } = reporting.calculateDerivedMetrics(data);

  const summary = {
    metadata: {
      testScript: "koha_api_http.js",
      testNumber: TEST_NUMBER,
      timestamp: new Date().toISOString(),
    },
    config: {
      staffUrl: STAFF_URL,
      staffHostHeader: STAFF_HOST_HEADER || "(not set)",
      staffUser: STAFF_USER,
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

  const outputPath = OUTPUT_FILE || reporting.generateOutputPath("koha-api", TEST_NUMBER);
  const customSummary = reporting.formatSummary(data, { peakVUs: __peakVUs, thresholdPercentile: THRESHOLD_PERCENTILE }) + `  Output: ${outputPath}\n`;

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + "\n" + customSummary,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}

