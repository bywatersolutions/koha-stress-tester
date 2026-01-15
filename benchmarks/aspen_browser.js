/**
 * Aspen Discovery Browser Test
 * 
 * Requirements:
 * - k6 binary with browser support (not Docker)
 * - Chromium installed on your system
 * 
 * WARNING: Each VU spawns its own browser window. Running with VUS=10 will
 * open 10 browsers simultaneously. Keep VUS low, especially in visible mode.
 * 
 * For high-volume stress testing, use aspen_http.js instead (works in Docker).
 */
import { browser } from "k6/browser";
import { sleep, check } from "k6";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { randomElement } from "./lib/utils.js";
import * as reporting from "./lib/reporting.js";

// ------------------------------------------------------------
// TEST CONFIG
// ------------------------------------------------------------
// Browser args for container/sandbox compatibility
const browserArgs = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-software-rasterizer",
  "--single-process",
  "--window-size=1920,1080",
];

// Add Wayland args for visible mode on Hyprland/Sway/Wayland compositors
// K6_BROWSER_HEADLESS env var controls headless mode (set to "false" for visible)
if (__ENV.K6_BROWSER_HEADLESS === "false" || __ENV.HEADLESS === "false") {
  browserArgs.push("--ozone-platform=wayland");
  browserArgs.push("--enable-features=UseOzonePlatform");
}

export const options = {
  scenarios: {
    ui: {
      executor: "shared-iterations",
      vus: __ENV.VUS || 1,
      iterations: __ENV.ITERATIONS || 1,
      options: {
        browser: {
          type: "chromium",
          args: browserArgs,
        },
      },
    },
  },
  thresholds: {
    checks: ["rate==1.0"],
  },
};

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || "https://localhost";
const HOST_HEADER = __ENV.HOST_HEADER || "";
const RESULTS_TO_CLICK = parseInt(__ENV.RESULTS_TO_CLICK) || 5;
const VUS = parseInt(__ENV.VUS) || 1;
const ITERATIONS = parseInt(__ENV.ITERATIONS) || 1;
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";

const words = open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim());

export function setup() {
  console.log("BASE_URL:", BASE_URL);
  console.log("K6_BROWSER_HEADLESS:", __ENV.K6_BROWSER_HEADLESS || "true (default)");
  if (HOST_HEADER) {
    console.log("HOST_HEADER:", HOST_HEADER);
  }
}

export function teardown() {}

export default async function () {
  const searchTerm = randomElement(words);
  console.log("Search term:", searchTerm);

  const page = await browser.newPage();
  
  try {
    // Only set Host header if explicitly provided (for localhost testing)
    if (HOST_HEADER) {
      await page.setExtraHTTPHeaders({ Host: HOST_HEADER });
    }
    
    const response = await page.goto(BASE_URL, { waitUntil: "networkidle" });
    
    // Check if page loaded successfully
    if (response && response.status() >= 400) {
      console.error(`Page returned status ${response.status()} - site may be blocking automated access`);
      return;
    }

    // Wait for page to be interactive
    await page.waitForSelector("body", { timeout: 10000 });
    await sleep(1);

    // Find search input - try multiple selectors
    let lookforInput;
    const inputSelectors = ["#lookfor", "input[name='lookfor']", ".searchInput", "#searchForm input[type='text']"];
    
    for (const selector of inputSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        lookforInput = page.locator(selector);
        console.log(`Found search input with selector: ${selector}`);
        break;
      } catch {
        // Try next selector
      }
    }

    if (!lookforInput) {
      console.error("Could not find search input element");
      return;
    }

    await lookforInput.type(searchTerm);

    // Find search button - try multiple selectors
    let searchButton;
    const buttonSelectors = ["#horizontal-search-button-container button", "button[type='submit']", ".searchButton", "#searchForm button"];
    
    for (const selector of buttonSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 2000 });
        searchButton = page.locator(selector);
        console.log(`Found search button with selector: ${selector}`);
        break;
      } catch {
        // Try next selector
      }
    }
    
    if (!searchButton) {
      console.error("Could not find search button element");
      return;
    }

    await Promise.all([
      page.waitForNavigation(),
      searchButton.click({ force: true }),
    ]);

    // Save the search results URL so we can return to it
    const searchResultsUrl = page.url();
    console.log("Search results URL:", searchResultsUrl);

    await sleep(Math.random() * 3);

    // Wait for results to load (some searches may have no results)
    try {
      await page.waitForSelector(".result-title", { timeout: 15000 });
    } catch {
      const noResults = await page.$(".noResults, .nohit, #noResults");
      if (noResults) {
        console.log(`No results for search term: "${searchTerm}"`);
      } else {
        console.log("Timeout waiting for results");
      }
      return;
    }
    
    // Get initial result count
    const results = await page.$$(".result-title");
    const resultCount = results.length;
    console.log("Results found:", resultCount);

    check(resultCount, {
      "Has search results": (c) => c > 0,
    });

    if (resultCount > 0) {
      const clickCount = Math.min(RESULTS_TO_CLICK, resultCount);
      for (let i = 0; i < clickCount; i++) {
        try {
          // Get fresh results from current page
          const currentResults = await page.$$(".result-title");
          if (currentResults.length === 0) {
            console.log("No results on page, returning to search");
            await page.goto(searchResultsUrl, { waitUntil: "networkidle" });
            await page.waitForSelector(".result-title", { timeout: 10000 });
            continue;
          }
          
          const idx = Math.floor(Math.random() * currentResults.length);
          const link = currentResults[idx];

          const linkText = await link.textContent();
          console.log(`Clicking result ${i + 1}/${clickCount}: ${linkText}`);

          await Promise.all([
            page.waitForNavigation({ timeout: 15000 }),
            link.click({ force: true }),
          ]);

          await page.waitForSelector("body", { timeout: 10000 });
          await sleep(Math.random() * 3);

          // Navigate back to search results using saved URL
          await page.goto(searchResultsUrl, { waitUntil: "networkidle" });
          await page.waitForSelector(".result-title", { timeout: 10000 });
          await sleep(1);
          
        } catch (clickError) {
          console.log("Click error, returning to search:", clickError?.message || "unknown");
          // Try to recover by going back to search results
          try {
            await page.goto(searchResultsUrl, { waitUntil: "networkidle" });
            await page.waitForSelector(".result-title", { timeout: 10000 });
          } catch {
            console.log("Could not recover, ending click loop");
            break;
          }
        }
      }
    } else {
      console.log("No search results found.");
    }
  } catch (error) {
    console.error("Test error:", error?.message || error || "Unknown error");
  } finally {
    await page.close();
  }
}

export function handleSummary(data) {
  const m = data.metrics;

  const summary = {
    metadata: {
      testScript: "aspen_browser.js",
      testNumber: TEST_NUMBER,
      timestamp: new Date().toISOString(),
    },
    config: {
      baseUrl: BASE_URL,
      hostHeader: HOST_HEADER || "(not set)",
      resultsToClick: RESULTS_TO_CLICK,
      vus: VUS,
      iterations: ITERATIONS,
      headless: __ENV.K6_BROWSER_HEADLESS !== "false",
    },
    result: {
      totalIterations: m.iterations?.values?.count || 0,
      iterationDuration_avg_ms: m.iteration_duration?.values?.avg?.toFixed(2) || null,
      iterationDuration_p95_ms: m.iteration_duration?.values?.["p(95)"]?.toFixed(2) || null,
    },
    browserMetrics: {
      dataReceived_mb: ((m.browser_data_received?.values?.count || 0) / 1024 / 1024).toFixed(2),
      dataSent_mb: ((m.browser_data_sent?.values?.count || 0) / 1024 / 1024).toFixed(2),
      httpReqDuration_avg_ms: m.browser_http_req_duration?.values?.avg?.toFixed(2) || null,
      httpReqDuration_p95_ms: m.browser_http_req_duration?.values?.["p(95)"]?.toFixed(2) || null,
      httpReqFailed_rate: m.browser_http_req_failed?.values?.rate?.toFixed(4) || null,
    },
    webVitals: {
      fcp_avg_ms: m.browser_web_vital_fcp?.values?.avg?.toFixed(2) || null,
      lcp_avg_ms: m.browser_web_vital_lcp?.values?.avg?.toFixed(2) || null,
      cls_avg: m.browser_web_vital_cls?.values?.avg?.toFixed(4) || null,
      ttfb_avg_ms: m.browser_web_vital_ttfb?.values?.avg?.toFixed(2) || null,
      fid_avg_ms: m.browser_web_vital_fid?.values?.avg?.toFixed(2) || null,
      inp_avg_ms: m.browser_web_vital_inp?.values?.avg?.toFixed(2) || null,
    },
    checks: reporting.extractChecks(data),
  };

  const outputPath = OUTPUT_FILE || reporting.generateOutputPath("aspen-browser", TEST_NUMBER);

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + `\n  Output: ${outputPath}\n`,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}
