import http from "k6/http";
import exec from "k6/execution";
import { browser } from "k6/browser";
import { sleep, fail, check } from "k6";
import { expect } from "https://jslib.k6.io/k6-testing/0.5.0/index.js";

// ------------------------------------------------------------
// TEST CONFIG
// ------------------------------------------------------------
export const options = {
  scenarios: {
    ui: {
      executor: "shared-iterations",
      vus: __ENV.VUS || 1,
      iterations: __ENV.ITERATIONS || 1,
      options: {
        browser: {
          type: "chromium",
          headless: true,
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
const HOST_HEADER = __ENV.HOST_HEADER || "aspen-discovery.localhost";
const RESULTS_TO_CLICK = parseInt(__ENV.RESULTS_TO_CLICK) || 5;

// Read all words from the file
const words = open("./words_alpha.txt").split("\r\n");

export function setup() {}

export function teardown(data) {}

/**
 * Main test function that runs for each VU (Virtual User)
 * @param {Object} data - Test data loaded in the setup function
 * @returns {Promise<void>}
 */
export default async function (data) {
  const searchTerm = rando(words);
  console.log(searchTerm);

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ Host: HOST_HEADER });
  await page.goto(BASE_URL);

  // Simulate user think time before typing
  await sleep(Math.random() * 3);

  // Type into search box
  const lookforInput = page.locator("#lookfor");
  await lookforInput.type(searchTerm);

  // Click Search button
  const searchButton = page.locator(
    "#horizontal-search-button-container button",
  );
  await Promise.all([
    page.waitForNavigation(),
    searchButton.click({ force: true }),
  ]);

  // Simulate user scanning results (longer think time)
  await sleep(Math.random() * 10);

  // Find results
  const locator = await page.locator(".result-title");
  const count = await locator.count();
  console.log("Search term:", searchTerm);
  console.log("Results found:", count);

  if (count > 0) {
    for (let i = 0; i < RESULTS_TO_CLICK; i++) {
      // Pick random index
      const idx = Math.floor(Math.random() * count);
      const link = locator.nth(idx);

      const linkText = await link.textContent();
      console.log("Clicking link:", linkText);

      await Promise.all([
        page.waitForNavigation(),
        link.click({ force: true }),
      ]);

      // Wait for page to load
      await page.waitForSelector("#main-content");

      // Simulate user reading the record
      await sleep(Math.random() * 10);

      await page.locator("#returnToSearch a").click();

      // Brief pause before next click
      await sleep(Math.random() * 3);
    }
  } else {
    console.log("No elements to click.");
  }

  page.close();
}

/**
 * Randomly selects an element from an array
 * @param {Array} arr - The array to pick an element from
 * @returns {*} A random element from the input array
 */
function rando(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

