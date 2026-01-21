import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Trend, Counter } from "k6/metrics";
import exec from "k6/execution";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import * as reporting from "./lib/reporting.js";
import * as solr from "./lib/solr.js";
import { randomElement } from "./lib/utils.js";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const SOLR_URL = __ENV.SOLR_URL || "https://solr.example.com:8983";
const SOLR_CORE = __ENV.SOLR_CORE || "grouped_works";
const SOLR_USER = __ENV.SOLR_USER || "";
const SOLR_PASS = __ENV.SOLR_PASS || "";
// SOLR_HOST_IP: Map the hostname in SOLR_URL to this IP address
// (bypasses DNS - use for Tailscale: SOLR_URL stays as domain, SOLR_HOST_IP=100.x.x.x)
const SOLR_HOST_IP = __ENV.SOLR_HOST_IP || "";

// Extract hostname from SOLR_URL for hosts mapping
function getHostFromUrl(url) {
  const match = url.match(/^https?:\/\/([^:/]+)/);
  return match ? match[1] : null;
}
const SOLR_HOSTNAME = getHostFromUrl(SOLR_URL);
const MAX_VUS = parseInt(__ENV.MAX_VUS) || 300;
const VU_STEP = parseInt(__ENV.VU_STEP) || 10;
const RAMP_TIME = __ENV.RAMP_TIME || "5s";
const HOLD_TIME = __ENV.HOLD_TIME || "5s";
const ABORT_MS = parseInt(__ENV.SOLR_ABORT_MS) || 2000;
const MAX_FAIL_CON_RATE = parseFloat(__ENV.SOLR_MAX_FAIL_CON_RATE) || 0.05;
const SLOW_LOG_MS = parseInt(__ENV.SOLR_SLOW_LOG_MS) || 2000;
const THRESHOLD_PERCENTILE = parseInt(__ENV.THRESHOLD_PERCENTILE) || 98;
const STATS_INTERVAL = parseInt(__ENV.STATS_INTERVAL) || 10;
const HARD_TIMEOUT = __ENV.HARD_TIMEOUT || "30m";
const HOLD_ON_FAIL = __ENV.HOLD_ON_FAIL || "30s";
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";
const NO_CONNECTION_REUSE = ["1", "on", "true", "enabled"].includes((__ENV.NO_CONNECTION_REUSE || "").toLowerCase());

const words = new SharedArray("words", function () {
  return open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim());
});

// Custom metrics for Solr's self-reported times
const solrQTime = new Trend("solr_qtime", true);
const solrNumFound = new Trend("solr_num_found", true);
const solrQTimeOver100 = new Counter("solr_qtime_over_100ms");
const solrQTimeOver500 = new Counter("solr_qtime_over_500ms");
const solrQTimeOver1000 = new Counter("solr_qtime_over_1000ms");

let __finalSolrSystemInfo = null;
let __peakVUs = 0;

const headers = solr.getSolrHeaders(SOLR_USER, SOLR_PASS);

const params = {
  headers: headers,
  timeout: "30s",
  noConnectionReuse: NO_CONNECTION_REUSE,
};

function generateStages() {
  const stages = [];
  for (let vus = VU_STEP; vus <= MAX_VUS; vus += VU_STEP) {
    stages.push({ duration: RAMP_TIME, target: vus });
    stages.push({ duration: HOLD_TIME, target: vus });
  }
  stages.push({ duration: RAMP_TIME, target: 0 });
  return stages;
}

function getTotalDuration() {
  const rampSecs = parseInt(RAMP_TIME) || 5;
  const holdSecs = parseInt(HOLD_TIME) || 5;
  const numSteps = Math.ceil(MAX_VUS / VU_STEP);
  const totalSecs = (numSteps * (rampSecs + holdSecs)) + rampSecs + 10;
  return `${totalSecs}s`;
}

// Build hosts mapping if SOLR_HOST_IP is set (for Tailscale/custom DNS)
const hostsMapping = SOLR_HOST_IP && SOLR_HOSTNAME 
  ? { [SOLR_HOSTNAME]: SOLR_HOST_IP }
  : {};

export const options = {
  insecureSkipTLSVerify: true,
  batch: 10,
  batchPerHost: 10,
  dns: { ttl: "1m" },
  hosts: hostsMapping,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", `p(${THRESHOLD_PERCENTILE})`],
  scenarios: {
    load_test: {
      executor: "ramping-vus",
      stages: generateStages(),
      gracefulRampDown: "10s",
      gracefulStop: "10s",  // Allow iterations to complete cleanly
    },
    stats_collector: {
      executor: "constant-vus",
      vus: 1,
      duration: getTotalDuration(),
      exec: "collectStats",
      gracefulStop: "0s",
    },
  },
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
    solr_qtime: [`p(${THRESHOLD_PERCENTILE})<${ABORT_MS}`],
  },
};

export function setup() {
  console.log(`========================================`);
  console.log(`SOLR BENCHMARK TEST`);
  console.log(`========================================`);
  console.log(`SOLR_URL: ${SOLR_URL}`);
  if (SOLR_HOST_IP) {
    console.log(`SOLR_HOST_IP: ${SOLR_HOSTNAME} -> ${SOLR_HOST_IP}`);
  }
  console.log(`SOLR_CORE: ${SOLR_CORE}`);
  console.log(`SOLR_USER: ${SOLR_USER ? "(set)" : "(not set)"}`);
  console.log(`MAX_VUS: ${MAX_VUS}, VU_STEP: ${VU_STEP}`);
  console.log(`RAMP_TIME: ${RAMP_TIME}, HOLD_TIME: ${HOLD_TIME}`);
  console.log(`ABORT_MS: ${ABORT_MS} (abort test when p(${THRESHOLD_PERCENTILE}) exceeds this)`);
  console.log(`MAX_FAIL_CON_RATE: ${(MAX_FAIL_CON_RATE * 100).toFixed(0)}% (abort test when failure rate exceeds this)`);
  console.log(`SLOW_LOG_MS: ${SLOW_LOG_MS} (log slow requests to console)`);
  console.log(`STATS_INTERVAL: ${STATS_INTERVAL}s`);
  console.log(`HARD_TIMEOUT: ${HARD_TIMEOUT} (absolute max duration)`);
  console.log(`HOLD_ON_FAIL: ${HOLD_ON_FAIL} (stats capture before abort)`);
  console.log(`NO_CONNECTION_REUSE: ${NO_CONNECTION_REUSE}`);
  console.log(`========================================`);
  
  try {
    const sysInfoUrl = `${SOLR_URL}/solr/admin/info/system?wt=json`;
    const res = http.get(sysInfoUrl, { headers, timeout: "10s" });
    if (res.status === 200) {
      const info = JSON.parse(res.body);
      console.log(`Solr version: ${info.lucene?.["solr-spec-version"]}`);
      console.log(`JVM memory max: ${info.jvm?.memory?.max}`);
      console.log(`Processors: ${info.jvm?.processors}`);
      console.log(`Mode: ${info.mode}`);
    }
  } catch (e) {
    console.log(`Warning: Could not fetch Solr system info: ${e.message}`);
  }
  
  solr.collectSolrMetrics(SOLR_URL, SOLR_CORE, headers, "BASELINE");
}

export default function () {
  const vus = exec.instance.vusActive;
  if (vus > __peakVUs) {
    __peakVUs = vus;
  }

  const word = randomElement(words);
  const queryUrl = `${SOLR_URL}/solr/${SOLR_CORE}/select?q=${encodeURIComponent(word)}&wt=json&rows=10`;
  
  const res = http.get(queryUrl, params);
  const duration = res.timings.duration;
  
  if (res.status !== 200) {
    const failType = duration < 100 ? "CONN_FAIL" : "TIMEOUT";
    console.log(`${failType} [${vus} VUs] ${duration.toFixed(0)}ms - status=${res.status} error="${res.error || 'none'}" word="${word}"`);
  } else if (duration > SLOW_LOG_MS) {
    console.log(`SLOW [${vus} VUs] ${duration.toFixed(0)}ms - word="${word}"`);
  }
  
  let qtime = 0;
  let numFound = 0;
  
  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      qtime = body.responseHeader?.QTime || 0;
      numFound = body.response?.numFound || 0;
      
      solrQTime.add(qtime);
      solrNumFound.add(numFound);
      
      if (qtime > 100) solrQTimeOver100.add(1);
      if (qtime > 500) solrQTimeOver500.add(1);
      if (qtime > 1000) solrQTimeOver1000.add(1);
    } catch (e) {
      // Parse error - ignore
    }
  }
  
  check(res, {
    "solr 200": (r) => r.status === 200,
    "has response": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.response !== undefined;
      } catch {
        return false;
      }
    },
    "response < 500ms": (r) => r.timings.duration < 500,
    "response < 1000ms": (r) => r.timings.duration < 1000,
    "response < 2000ms": (r) => r.timings.duration < 2000,
  });

  sleep(1);
}

export function collectStats() {
  // Check if main test is still running (has active VUs)
  const mainTestVUs = exec.instance.vusActive;
  if (mainTestVUs <= 1) {
    // Only stats_collector VU remains, main test has ended
    return;
  }
  
  sleep(STATS_INTERVAL);
  
  solr.collectSolrMetrics(SOLR_URL, SOLR_CORE, headers, `VUs: ~${mainTestVUs}`);
}

export function teardown() {
  console.log(`\n========================================`);
  console.log(`TEST COMPLETE`);
  console.log(`========================================`);
  solr.collectSolrMetrics(SOLR_URL, SOLR_CORE, headers, "FINAL");
  
  console.log(`Capturing Solr system info...`);
  __finalSolrSystemInfo = solr.fetchSolrSystemInfo(SOLR_URL, headers);
  if (__finalSolrSystemInfo) {
    console.log(`  Load average: ${__finalSolrSystemInfo.system?.systemLoadAverage}`);
    console.log(`  Memory used: ${__finalSolrSystemInfo.jvm?.memory?.used}`);
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const abortReason = reporting.getAbortReason(data);
  const { totalRequests, testDuration, rps } = reporting.calculateDerivedMetrics(data);
  
  const solrSystemInfo = __finalSolrSystemInfo || solr.fetchSolrSystemInfo(SOLR_URL, headers);

  const summary = {
    metadata: {
      testScript: "solr_http.js",
      testNumber: TEST_NUMBER,
      timestamp: new Date().toISOString(),
    },
    config: {
      solrUrl: SOLR_URL,
      solrCore: SOLR_CORE,
      solrUser: SOLR_USER ? "(set)" : "(not set)",
      maxVUs: MAX_VUS,
      vuStep: VU_STEP,
      rampTime: RAMP_TIME,
      holdTime: HOLD_TIME,
      abortMs: ABORT_MS,
      thresholdPercentile: THRESHOLD_PERCENTILE,
      maxFailRate: `${(MAX_FAIL_CON_RATE * 100).toFixed(0)}%`,
      slowLogMs: SLOW_LOG_MS,
      statsInterval: STATS_INTERVAL,
      hardTimeout: HARD_TIMEOUT,
      holdOnFail: HOLD_ON_FAIL,
      requestTimeout: "30s",
      noConnectionReuse: NO_CONNECTION_REUSE,
    },
    thresholds: {
      httpReqDuration: `p(${THRESHOLD_PERCENTILE})<${ABORT_MS}ms`,
      httpReqFailed: `rate<${(MAX_FAIL_CON_RATE * 100).toFixed(0)}%`,
      solrQtime: `p(${THRESHOLD_PERCENTILE})<${ABORT_MS}ms`,
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
    solrMetrics: {
      qtime_med_ms: m.solr_qtime?.values?.med?.toFixed(2) || null,
      qtime_p95_ms: m.solr_qtime?.values?.["p(95)"]?.toFixed(2) || null,
      qtime_max_ms: m.solr_qtime?.values?.max?.toFixed(2) || null,
      slow_queries_over_100ms: m.solr_qtime_over_100ms?.values?.count || 0,
      slow_queries_over_500ms: m.solr_qtime_over_500ms?.values?.count || 0,
      slow_queries_over_1000ms: m.solr_qtime_over_1000ms?.values?.count || 0,
      avg_results_found: m.solr_num_found?.values?.avg?.toFixed(0) || null,
    },
    checks: reporting.extractChecks(data),
    solrSystem: solrSystemInfo,
  };

  const outputPath = OUTPUT_FILE || reporting.generateOutputPath("solr", TEST_NUMBER);
  const customSummary = reporting.formatSummary(data, { includeSolrQtime: true, peakVUs: __peakVUs, thresholdPercentile: THRESHOLD_PERCENTILE }) + `  Output: ${outputPath}\n`;

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + "\n" + customSummary,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}
