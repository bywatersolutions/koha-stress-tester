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

// Load words from file
const words = new SharedArray("words", function () {
  return open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim());
});

// Default headers with Host override
const headers = {
  Host: HOST_HEADER,
  "User-Agent": "k6-stress-test",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ------------------------------------------------------------
// TEST CONFIG - Staged ramp-up by 50 VUs, 1 min holds
// Aborts when failure rate exceeds 5%
// ------------------------------------------------------------
export const options = {
  insecureSkipTLSVerify: true,
  stages: [
    { duration: "30s", target: 50 },    // Ramp to 50
    { duration: "1m", target: 50 },     // Hold at 50
    { duration: "30s", target: 100 },   // Ramp to 100
    { duration: "1m", target: 100 },    // Hold at 100
    { duration: "30s", target: 150 },   // Ramp to 150
    { duration: "1m", target: 150 },    // Hold at 150
    { duration: "30s", target: 200 },   // Ramp to 200
    { duration: "1m", target: 200 },    // Hold at 200
    { duration: "30s", target: 250 },   // Ramp to 250
    { duration: "1m", target: 250 },    // Hold at 250
    { duration: "30s", target: 300 },   // Ramp to 300
    { duration: "1m", target: 300 },    // Hold at 300
    { duration: "30s", target: 0 },     // Ramp down
  ],
  thresholds: {
    http_req_failed: [
      {
        threshold: "rate<0.05",
        abortOnFail: true,
        delayAbortEval: "30s",
      },
    ],
    http_req_duration: ["p(95)<2000"],
  },
};

export function setup() {
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`HOST_HEADER: ${HOST_HEADER}`);
  console.log(`Staged stress test - ramps by 50 VUs, holds 1 min each`);
  console.log(`Aborts when failure rate exceeds 5%`);
}

export function teardown(data) {}

/**
 * Main test function that runs for each VU (Virtual User)
 */
export default function () {
  const searchTerm = words[Math.floor(Math.random() * words.length)];

  // Load homepage
  const homeRes = http.get(BASE_URL, { headers });
  check(homeRes, {
    "homepage loaded": (r) => r.status === 200,
  });

  sleep(0.5);

  // Perform search
  const searchUrl = `${BASE_URL}/Union/Search?view=list&lookfor=${encodeURIComponent(searchTerm)}&searchIndex=Keyword&searchSource=local`;
  const searchRes = http.get(searchUrl, { headers });
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

    const recordRes = http.get(recordUrl, { headers });
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
