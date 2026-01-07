import http from "k6/http";
import { sleep, check } from "k6";
import { parseHTML } from "k6/html";

// ------------------------------------------------------------
// TEST CONFIG
// ------------------------------------------------------------
export const options = {
  scenarios: {
    http: {
      executor: "shared-iterations",
      vus: __ENV.VUS || 1,
      iterations: __ENV.ITERATIONS || 1,
    },
  },
  thresholds: {
    checks: ["rate==1.0"],
  },
  insecureSkipTLSVerify: true,
};

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || "https://localhost";
const HOST_HEADER = __ENV.HOST_HEADER || "aspen-discovery.localhost";
const RESULTS_TO_CLICK = __ENV.RESULTS_TO_CLICK || 5;

// Read all words from the file
const words = open("./words_alpha.txt").split("\n").filter(w => w.trim());

// Default headers with Host override
const headers = {
  Host: HOST_HEADER,
  "User-Agent": "k6-stress-test",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

export function setup() {
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`HOST_HEADER: ${HOST_HEADER}`);
}

export function teardown(data) {}

/**
 * Main test function that runs for each VU (Virtual User)
 */
export default function () {
  const searchTerm = rando(words);
  console.log(`Search term: ${searchTerm}`);

  // Load homepage
  const homeRes = http.get(BASE_URL, { headers });
  check(homeRes, {
    "homepage loaded": (r) => r.status === 200,
  });

  sleep(0.5);

  // Perform search
  const searchUrl = `${BASE_URL}/Union/Search?lookfor=${encodeURIComponent(searchTerm)}&searchIndex=Keyword&searchSource=local`;
  const searchRes = http.get(searchUrl, { headers });
  check(searchRes, {
    "search completed": (r) => r.status === 200,
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

  console.log(`Results found: ${resultLinks.length}`);

  // Click through results
  const clickCount = Math.min(RESULTS_TO_CLICK, resultLinks.length);
  for (let i = 0; i < clickCount; i++) {
    const idx = Math.floor(Math.random() * resultLinks.length);
    let recordUrl = resultLinks[idx];
    
    // Make absolute if relative
    if (recordUrl.startsWith("/")) {
      recordUrl = `${BASE_URL}${recordUrl}`;
    }

    console.log(`Clicking result: ${recordUrl}`);
    const recordRes = http.get(recordUrl, { headers });
    check(recordRes, {
      "record loaded": (r) => r.status === 200,
    });

    sleep(0.5);
  }

  if (resultLinks.length === 0) {
    console.log("No results to click.");
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

