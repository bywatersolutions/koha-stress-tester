import http from "k6/http";
import { sleep, check } from "k6";
import { parseHTML } from "k6/html";
import { SharedArray } from "k6/data";

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
// Aborts when failure rate exceeds 5%
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
    http_req_failed: [
      {
        threshold: "rate<0.05",
        abortOnFail: true,
        delayAbortEval: "30s",
      },
    ],
    http_req_duration: [
      {
        threshold: "p(95)<10000",
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
  console.log(`Aborts when failure rate exceeds 5%`);
}

export function teardown(data) {}

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

/**
 * Randomly selects an element from an array
 * @param {Array} arr - The array to pick an element from
 * @returns {*} A random element from the input array
 */
function rando(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Simple summary formatter (no external dependencies)
function formatSummary(data) {
  const lines = [
    "",
    "=".repeat(60),
    "TEST SUMMARY",
    "=".repeat(60),
  ];

  const m = data.metrics;
  
  // Result overview
  if (m.vus) lines.push(`  peak_vus................: ${m.vus.values.max}`);
  if (m.http_reqs) lines.push(`  http_reqs...............: ${m.http_reqs.values.count}`);
  if (m.iterations) lines.push(`  iterations..............: ${m.iterations.values.count}`);
  if (m.http_req_failed) lines.push(`  http_req_failed.........: ${(m.http_req_failed.values.rate * 100).toFixed(2)}%`);
  
  lines.push("");
  
  // Timing (using median - resistant to timeout skew)
  if (m.http_req_duration) {
    const d = m.http_req_duration.values;
    lines.push(`  http_req_duration.......: med=${d.med?.toFixed(2)}ms p(90)=${d["p(90)"]?.toFixed(2)}ms p(95)=${d["p(95)"]?.toFixed(2)}ms`);
  }
  if (m.http_req_waiting) {
    lines.push(`  http_req_waiting (TTFB).: med=${m.http_req_waiting.values.med?.toFixed(2)}ms`);
  }
  
  lines.push("");
  
  // Data transfer
  if (m.data_received) {
    const mb = (m.data_received.values.count / 1024 / 1024).toFixed(2);
    lines.push(`  data_received...........: ${mb} MB`);
  }

  lines.push("=".repeat(60));
  lines.push("");
  return lines.join("\n");
}

// Handle summary - export results to JSON file (runs even on threshold abort)
export function handleSummary(data) {
  const m = data.metrics;
  
  // Determine abort reason from thresholds
  let abortReason = null;
  if (data.thresholds) {
    for (const [name, threshold] of Object.entries(data.thresholds)) {
      if (!threshold.ok) {
        abortReason = `${name} threshold crossed`;
        break;
      }
    }
  }

  // Calculate derived metrics
  const totalRequests = m.http_reqs?.values?.count || 0;
  const testDuration = m.iteration_duration?.values?.count > 0 
    ? (data.state?.testRunDurationMs || 0) / 1000 
    : 0;
  const rps = testDuration > 0 ? (totalRequests / testDuration).toFixed(2) : null;

  // Build clean, focused summary
  const summary = {
    metadata: {
      testScript: "aspen_http.js",
      baseUrl: BASE_URL,
      hostHeader: HOST_HEADER,
      maxVUsConfigured: MAX_VUS,
      vuStep: VU_STEP,
      rampTime: RAMP_TIME,
      holdTime: HOLD_TIME,
      timestamp: new Date().toISOString(),
    },
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
    timing: {
      // Median/percentiles are preferred - resistant to timeout skew
      med_ms: m.http_req_duration?.values?.med?.toFixed(2) || null,
      p90_ms: m.http_req_duration?.values?.["p(90)"]?.toFixed(2) || null,
      p95_ms: m.http_req_duration?.values?.["p(95)"]?.toFixed(2) || null,
      min_ms: m.http_req_duration?.values?.min?.toFixed(2) || null,
      max_ms: m.http_req_duration?.values?.max?.toFixed(2) || null,
      // Average included but may be skewed by timeouts
      avg_ms_may_be_skewed: m.http_req_duration?.values?.avg?.toFixed(2) || null,
    },
    timingBreakdown: {
      blocked_med_ms: m.http_req_blocked?.values?.med?.toFixed(2) || null,
      connecting_med_ms: m.http_req_connecting?.values?.med?.toFixed(2) || null,
      tls_handshake_med_ms: m.http_req_tls_handshaking?.values?.med?.toFixed(2) || null,
      sending_med_ms: m.http_req_sending?.values?.med?.toFixed(2) || null,
      waiting_med_ms: m.http_req_waiting?.values?.med?.toFixed(2) || null,
      receiving_med_ms: m.http_req_receiving?.values?.med?.toFixed(2) || null,
    },
    dataTransfer: {
      received_mb: ((m.data_received?.values?.count || 0) / 1024 / 1024).toFixed(2),
      sent_mb: ((m.data_sent?.values?.count || 0) / 1024 / 1024).toFixed(2),
    },
    checks: {},
  };

  // Extract check pass rates
  if (data.root_group?.checks) {
    for (const check of data.root_group.checks) {
      const total = check.passes + check.fails;
      summary.checks[check.name] = {
        passes: check.passes,
        fails: check.fails,
        rate: total > 0 ? `${((check.passes / total) * 100).toFixed(1)}%` : "N/A",
      };
    }
  }

  // Generate timestamped filename if not specified
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = OUTPUT_FILE || `/output/aspen-${timestamp}.json`;

  return {
    stdout: formatSummary(data),
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}