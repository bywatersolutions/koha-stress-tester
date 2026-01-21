import http from "k6/http";
import { sleep, check } from "k6";
import { parseHTML } from "k6/html";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import * as reporting from "./lib/reporting.js";
import * as solr from "./lib/solr.js";
import { randomElement } from "./lib/utils.js";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || "https://localhost";
const HOST_HEADER = __ENV.HOST_HEADER || "aspen-discovery.localhost";
const RESULTS_TO_CLICK = parseInt(__ENV.RESULTS_TO_CLICK) || 5;
const MAX_VUS = parseInt(__ENV.MAX_VUS) || 300;
const VU_STEP = parseInt(__ENV.VU_STEP) || 10;
const RAMP_TIME = __ENV.RAMP_TIME || "5s";
const HOLD_TIME = __ENV.HOLD_TIME || "5s";
const ABORT_MS = parseInt(__ENV.ASPEN_ABORT_MS) || 12000;
const THRESHOLD_PERCENTILE = parseInt(__ENV.THRESHOLD_PERCENTILE) || 98;
const MAX_FAIL_CON_RATE = parseFloat(__ENV.ASPEN_MAX_FAIL_CON_RATE) || 0.05;
const REQUEST_TIMEOUT = __ENV.ASPEN_REQUEST_TIMEOUT || "10s";
const REQUEST_TIMEOUT_MS = parseInt(REQUEST_TIMEOUT) * 1000;
const HOLD_ON_FAIL = __ENV.HOLD_ON_FAIL || "30s";
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";
const SLOW_LOG_MS = parseInt(__ENV.ASPEN_SLOW_LOG_MS) || 6000;
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

// Solr configuration (optional - for capturing backend system info)
const SOLR_URL = __ENV.SOLR_URL || "";
const SOLR_USER = __ENV.SOLR_USER || "";
const SOLR_PASS = __ENV.SOLR_PASS || "";
const solrHeaders = SOLR_URL ? solr.getSolrHeaders(SOLR_USER, SOLR_PASS) : null;

let __finalSolrSystemInfo = null;
let __peakVUs = 0;

const words = new SharedArray("words", function () {
  return open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim());
});

const params = {
  headers: {
    Host: HOST_HEADER,
    "User-Agent": "k6-stress-test",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
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
  gracefulStop: "10s",  // Allow iterations to complete cleanly
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
  console.log(`ASPEN HTTP BENCHMARK TEST`);
  console.log(`========================================`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`HOST_HEADER: ${HOST_HEADER}`);
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
}

export function teardown() {
  console.log(`\n========================================`);
  console.log(`TEST COMPLETE`);
  console.log(`========================================`);
  
  if (SOLR_URL) {
    console.log(`Capturing Solr system info...`);
    __finalSolrSystemInfo = solr.fetchSolrSystemInfo(SOLR_URL, solrHeaders);
    if (__finalSolrSystemInfo && !__finalSolrSystemInfo.error) {
      console.log(`  Load average: ${__finalSolrSystemInfo.system?.systemLoadAverage}`);
      console.log(`  Memory used: ${__finalSolrSystemInfo.jvm?.memory?.used}`);
    }
  }
}

export default function () {
  const currentVUs = exec.instance.vusActive;
  if (currentVUs > __peakVUs) {
    __peakVUs = currentVUs;
  }

  const searchTerm = randomElement(words);

  const homeRes = http.get(BASE_URL, params);
  logRequestStatus(homeRes, "homepage", currentVUs);
  check(homeRes, {
    "homepage loaded": (r) => r.status === 200,
  });

  thinkTime(3);

  const searchUrl = `${BASE_URL}/Union/Search?view=list&lookfor=${encodeURIComponent(searchTerm)}&searchIndex=Keyword&searchSource=local`;
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
    if (href) {
      resultLinks.push(href);
    }
  });

  const clickCount = Math.min(RESULTS_TO_CLICK, resultLinks.length);
  for (let i = 0; i < clickCount; i++) {
    const idx = Math.floor(Math.random() * resultLinks.length);
    let recordUrl = resultLinks[idx];
    
    if (recordUrl.startsWith("/")) {
      recordUrl = `${BASE_URL}${recordUrl}`;
    }

    const recordRes = http.get(recordUrl, params);
    logRequestStatus(recordRes, "record", currentVUs);
    check(recordRes, {
      "record loaded": (r) => r.status === 200,
    });

    thinkTime(10);
    thinkTime(3);
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const abortReason = reporting.getAbortReason(data);
  const { totalRequests, testDuration, rps } = reporting.calculateDerivedMetrics(data);
  
  const solrSystemInfo = SOLR_URL 
    ? (__finalSolrSystemInfo || solr.fetchSolrSystemInfo(SOLR_URL, solrHeaders))
    : null;

  const summary = {
    metadata: {
      testScript: "aspen_http.js",
      testNumber: TEST_NUMBER,
      timestamp: new Date().toISOString(),
    },
    config: {
      baseUrl: BASE_URL,
      hostHeader: HOST_HEADER,
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
      abortReason: abortReason,
    },
    timing: reporting.buildTimingSection(m, THRESHOLD_PERCENTILE),
    timingBreakdown: reporting.buildTimingBreakdown(m),
    dataTransfer: reporting.buildDataTransfer(m),
    checks: reporting.extractChecks(data),
    solrSystem: solrSystemInfo,
  };

  const outputPath = OUTPUT_FILE || reporting.generateOutputPath("aspen", TEST_NUMBER);
  const customSummary = reporting.formatSummary(data, { peakVUs: __peakVUs, thresholdPercentile: THRESHOLD_PERCENTILE }) + `  Output: ${outputPath}\n`;

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + "\n" + customSummary,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}
