import http from "k6/http";
import { sleep, check } from "k6";
import { parseHTML } from "k6/html";
import { SharedArray } from "k6/data";
import * as reporting from "./lib/reporting.js";
import * as solr from "./lib/solr.js";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || "https://localhost";
const HOST_HEADER = __ENV.HOST_HEADER || "aspen-discovery.localhost";
const RESULTS_TO_CLICK = __ENV.RESULTS_TO_CLICK || 5;
const MAX_VUS = parseInt(__ENV.MAX_VUS) || 300;
const VU_STEP = parseInt(__ENV.VU_STEP) || 10;
const RAMP_TIME = __ENV.RAMP_TIME || "5s";
const HOLD_TIME = __ENV.HOLD_TIME || "5s";
const OUTPUT_FILE = __ENV.OUTPUT_FILE || ""; // Output file path for JSON results
const TEST_NUMBER = __ENV.TEST_NUMBER || "001"; // Test number for output filename

// Solr configuration (optional - for capturing backend system info)
const SOLR_URL = __ENV.SOLR_URL || "";
const SOLR_USER = __ENV.SOLR_USER || "";
const SOLR_PASS = __ENV.SOLR_PASS || "";
const solrHeaders = SOLR_URL ? solr.getSolrHeaders(SOLR_USER, SOLR_PASS) : null;

// Storage for system info captured in teardown
let __finalSolrSystemInfo = null;

// Load words from file
const words = new SharedArray("words", function () {
  return open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim());
});

// Default request params
const params = {
  headers: {
    Host: HOST_HEADER,
    "User-Agent": "k6-stress-test",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
  timeout: "6s",  // Fail fast instead of hanging
};

// ------------------------------------------------------------
// Generate stages dynamically: ramp by VU_STEP, hold, repeat until MAX_VUS
// Aborts when p(95) response time exceeds 2s
// ------------------------------------------------------------
function generateStages() {
  const stages = [];
  for (let vus = VU_STEP; vus <= MAX_VUS; vus += VU_STEP) {
    stages.push({ duration: RAMP_TIME, target: vus });
    stages.push({ duration: HOLD_TIME, target: vus });
  }
  stages.push({ duration: RAMP_TIME, target: 0 }); // Ramp down
  return stages;
}

export const options = {
  insecureSkipTLSVerify: true,
  stages: generateStages(),
  thresholds: {
    http_req_duration: [
      {
        threshold: "p(95)<2000",  // Abort when 95th percentile exceeds 2s
        abortOnFail: true,
        delayAbortEval: "30s",
      },
    ],
  },
};

export function setup() {
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`HOST_HEADER: ${HOST_HEADER}`);
  console.log(`MAX_VUS: ${MAX_VUS}, VU_STEP: ${VU_STEP}`);
  console.log(`RAMP_TIME: ${RAMP_TIME}, HOLD_TIME: ${HOLD_TIME}`);
  console.log(`Aborts when p(95) response time exceeds 2s`);
}

export function teardown(data) {
  console.log(`\n========================================`);
  console.log(`TEST COMPLETE`);
  console.log(`========================================`);
  
  // Capture Solr system info if configured
  if (SOLR_URL) {
    console.log(`Capturing Solr system info...`);
    __finalSolrSystemInfo = solr.fetchSolrSystemInfo(SOLR_URL, solrHeaders);
    if (__finalSolrSystemInfo && !__finalSolrSystemInfo.error) {
      console.log(`  Load average: ${__finalSolrSystemInfo.system?.systemLoadAverage}`);
      console.log(`  Memory used: ${__finalSolrSystemInfo.jvm?.memory?.used}`);
    }
  }
}

/**
 * Main test function that runs for each VU (Virtual User)
 */
export default function () {
  const searchTerm = words[Math.floor(Math.random() * words.length)];

  // Load homepage
  const homeRes = http.get(BASE_URL, params);
  check(homeRes, {
    "homepage loaded": (r) => r.status === 200,
  });

  sleep(0.5);

  // Perform search
  const searchUrl = `${BASE_URL}/Union/Search?view=list&lookfor=${encodeURIComponent(searchTerm)}&searchIndex=Keyword&searchSource=local`;
  const searchRes = http.get(searchUrl, params);
  check(searchRes, {
    "search completed": (r) => r.status === 200,
    "response < 500ms": (r) => r.timings.duration < 500,
    "response < 1000ms": (r) => r.timings.duration < 1000,
    "response < 2000ms": (r) => r.timings.duration < 2000,
  });

  // Parse results and extract record links
  const doc = parseHTML(searchRes.body);
  const resultLinks = [];
  
  doc.find(".result-title a").each((idx, el) => {
    const href = el.attr("href");
    if (href) {
      resultLinks.push(href);
    }
  });

  // Click through results
  const clickCount = Math.min(RESULTS_TO_CLICK, resultLinks.length);
  for (let i = 0; i < clickCount; i++) {
    const idx = Math.floor(Math.random() * resultLinks.length);
    let recordUrl = resultLinks[idx];
    
    // Make absolute if relative
    if (recordUrl.startsWith("/")) {
      recordUrl = `${BASE_URL}${recordUrl}`;
    }

    const recordRes = http.get(recordUrl, params);
    check(recordRes, {
      "record loaded": (r) => r.status === 200,
    });

    sleep(0.5);
  }
}

// Handle summary - export results to JSON file (runs even on threshold abort)
export function handleSummary(data) {
  const m = data.metrics;
  const abortReason = reporting.getAbortReason(data);
  const { totalRequests, testDuration, rps } = reporting.calculateDerivedMetrics(data);
  
  // Use system info captured in teardown, or fetch now if not available
  const solrSystemInfo = SOLR_URL 
    ? (__finalSolrSystemInfo || solr.fetchSolrSystemInfo(SOLR_URL, solrHeaders))
    : null;

  // Build clean, focused summary
  const summary = {
    // ==================== TEST SETTINGS ====================
    metadata: {
      testScript: "aspen_http.js",
      testNumber: TEST_NUMBER,
      timestamp: new Date().toISOString(),
    },
    config: {
      baseUrl: BASE_URL,
      hostHeader: HOST_HEADER,
      resultsToClick: RESULTS_TO_CLICK,
      maxVUs: MAX_VUS,
      vuStep: VU_STEP,
      rampTime: RAMP_TIME,
      holdTime: HOLD_TIME,
      requestTimeout: "6s",
      solrUrl: SOLR_URL || "(not configured)",
    },
    thresholds: {
      httpReqDuration: "p(95)<2000ms",
    },
    // ==================== TEST RESULTS ====================
    result: {
      peakVUs: m.vus?.values?.max || 0,
      configuredMaxVUs: MAX_VUS,
      testDuration_s: testDuration.toFixed(2),
      requestsPerSecond: rps,
      totalRequests: totalRequests,
      totalIterations: m.iterations?.values?.count || 0,
      failureRate: `${((m.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%`,
      abortReason: abortReason,
    },
    timing: reporting.buildTimingSection(m),
    timingBreakdown: reporting.buildTimingBreakdown(m),
    dataTransfer: reporting.buildDataTransfer(m),
    checks: reporting.extractChecks(data),
    // ==================== SYSTEM INFORMATION ====================
    solrSystem: solrSystemInfo,
  };

  const outputPath = OUTPUT_FILE || reporting.generateOutputPath("aspen", TEST_NUMBER);
  const consoleOutput = reporting.formatSummary(data) + `  Output: ${outputPath}\n`;

  return {
    stdout: consoleOutput,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}