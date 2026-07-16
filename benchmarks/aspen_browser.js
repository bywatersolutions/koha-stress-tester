/**
 * aspen_browser.js - Aspen Discovery Browser Test
 *
 * Real Chromium doing what a patron does at an Aspen Discovery front-end: open
 * the homepage, run a keyword search, open a result's record page. It measures
 * the actual rendered experience ( full page + assets + JS ), which the HTTP
 * test ( aspen_http.js ) can't see - that one measures server response time,
 * this one measures "did the page come up usably".
 *
 * Keep ASPEN_BROWSERS small: real browser VUs bill 10x and are capped at
 * 100/test, and past a handful the extra ones just add server load the cheaper
 * HTTP test already covers. This is an experience probe, not a load generator.
 *
 * Self-contained ( only remote imports ) so it pastes into the Grafana Cloud
 * script editor.
 */
import { browser } from "k6/browser";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";
import secrets from "k6/secrets";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

// ══════════════════════════════════════════════════════════════════════
//  ▶ HOW TO RUN: clone this test ( Save as… ), set the values in the
//    RUN CONFIG block below, then click Run.
// ══════════════════════════════════════════════════════════════════════
// ─── RUN CONFIG ( edit these ) ────────────────────────────────────────
const ASPEN_BASE_URL = __ENV.ASPEN_BASE_URL || "https://aspen.localhost"; // <<< SET: Aspen Discovery URL to test
const ASPEN_HOST_HEADER = __ENV.ASPEN_HOST_HEADER || ""; // <<< SET: Host header if Aspen is behind a proxy ( blank if not )
const ASPEN_BROWSERS = parseInt(__ENV.ASPEN_BROWSERS) || 5; // <<< SET: concurrent real browsers ( keep small )
const SEARCH_TERM = __ENV.CATALOG_SEARCH_TERM || "harry potter"; // <<< SET: a term with hits in the target catalog
// ──────────────────────────────────────────────────────────────────────
// Derived / internal
const DURATION = __ENV.DURATION || "3m";
// Per-step render ceiling for the pass/fail threshold ( "the page came up" )
const STEP_P95_MS = parseInt(__ENV.STEP_P95_MS) || 12000;
const CHECKS_RATE = parseFloat(__ENV.CHECKS_RATE) || 0.98;

// Ingress header ( Cloudflare bypass ), from the env var or the Grafana Cloud
// secret named EXTERNAL_SERVICE_TOKEN_SECRET on cloud runs.
const EXTERNAL_SERVICE_HEADER = __ENV.EXTERNAL_SERVICE_HEADER || "x-grafana-cloud-external-service";
const EXTERNAL_SERVICE_TOKEN = __ENV.EXTERNAL_SERVICE_TOKEN || "";
const EXTERNAL_SERVICE_TOKEN_SECRET = __ENV.EXTERNAL_SERVICE_TOKEN_SECRET || "x-grafana-cloud-external-service-token";

const CLOUD_TEST_NAME = __ENV.CLOUD_TEST_NAME || "aspen-browser";
const CLOUD_PROJECT_ID = __ENV.CLOUD_PROJECT_ID || "";
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";

const browserArgs = ["--no-sandbox", "--disable-dev-shm-usage"];

const cloudConfig = { name: CLOUD_TEST_NAME };
if (CLOUD_PROJECT_ID) cloudConfig.projectID = parseInt(CLOUD_PROJECT_ID);

export const options = {
  cloud: cloudConfig,
  scenarios: {
    aspen: {
      executor: "constant-vus",
      vus: Math.min(100, Math.max(1, ASPEN_BROWSERS)),
      duration: DURATION,
      gracefulStop: "15s",
      options: { browser: { type: "chromium", args: browserArgs } },
    },
  },
  thresholds: {
    "aspen_step_duration{step:home}": [`p(95)<${STEP_P95_MS}`],
    "aspen_step_duration{step:search}": [`p(95)<${STEP_P95_MS}`],
    "aspen_step_duration{step:detail}": [`p(95)<${STEP_P95_MS}`],
    checks: [`rate>=${CHECKS_RATE}`],
  },
};

const stepDuration = new Trend("aspen_step_duration", true);
const stepFailed = new Rate("aspen_step_failed");

// Ingress token resolved once in setup(), threaded to VUs and set as an extra
// header on every navigation.
let RESOLVED_TOKEN = EXTERNAL_SERVICE_TOKEN;
async function resolveToken() {
  if (EXTERNAL_SERVICE_TOKEN) return EXTERNAL_SERVICE_TOKEN;
  try {
    return await secrets.get(EXTERNAL_SERVICE_TOKEN_SECRET);
  } catch (e) {
    return "";
  }
}

async function pageExtraHeaders(page) {
  const h = {};
  if (RESOLVED_TOKEN) h[EXTERNAL_SERVICE_HEADER] = RESOLVED_TOKEN;
  if (ASPEN_HOST_HEADER) h["Host"] = ASPEN_HOST_HEADER;
  if (Object.keys(h).length) await page.setExtraHTTPHeaders(h);
}

export async function setup() {
  RESOLVED_TOKEN = await resolveToken();
  console.log("========================================");
  console.log("ASPEN BROWSER TEST");
  console.log("========================================");
  console.log(`ASPEN_BASE_URL: ${ASPEN_BASE_URL}`);
  if (ASPEN_HOST_HEADER) console.log(`ASPEN_HOST_HEADER: ${ASPEN_HOST_HEADER}`);
  console.log(`ASPEN_BROWSERS: ${Math.min(100, Math.max(1, ASPEN_BROWSERS))} | duration ${DURATION}`);
  console.log(`Search term: "${SEARCH_TERM}"`);
  console.log(
    `${EXTERNAL_SERVICE_HEADER}: ${RESOLVED_TOKEN ? `set (${EXTERNAL_SERVICE_TOKEN ? "from env" : "from Grafana Cloud secret"})` : "not sent"}`,
  );
  console.log("========================================");
  return { token: RESOLVED_TOKEN };
}

// Time a step, record its duration + a pass/fail check, and never let a hang
// run away ( bounded by the page's default timeout ).
async function runStep(name, fn) {
  const started = Date.now();
  let ok = true;
  try {
    await fn();
  } catch (error) {
    ok = false;
    console.error(`step '${name}' failed: ${error && error.message ? error.message : String(error)}`);
  } finally {
    stepDuration.add(Date.now() - started, { step: name });
    stepFailed.add(!ok, { step: name });
    check(ok, { [`step ${name} completed`]: (v) => v === true });
  }
  return ok;
}

export default async function (data) {
  RESOLVED_TOKEN = data.token; // per-VU: adopt the token setup resolved

  const page = await browser.newPage();
  await pageExtraHeaders(page);
  // Bound every operation so a mismatched selector or a slow asset fails in
  // seconds instead of hanging for the default navigation timeout.
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);

  try {
    // 1) Aspen home
    const home = await runStep("home", async () => {
      await page.goto(ASPEN_BASE_URL, { waitUntil: "domcontentloaded" });
      await page.locator('#lookfor, input[name="lookfor"]').first().waitFor({ state: "visible" });
    });
    if (!home) return;

    // 2) Keyword search
    const searched = await runStep("search", async () => {
      const box = page.locator('#lookfor, input[name="lookfor"]').first();
      await box.type(SEARCH_TERM);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        box.press("Enter"),
      ]);
      // Results list ( or a "no results" page ) - either is a rendered response
      await page.locator(".result-title, .noResults, .nohit, #noResults").first().waitFor();
    });
    if (!searched) return;

    // 3) Open the first result's record page ( if there are results )
    await runStep("detail", async () => {
      const firstResult = page.locator(".result-title a").first();
      if ((await firstResult.count()) === 0) {
        return; // no results for this term - nothing to open, still a valid render
      }
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        firstResult.click(),
      ]);
      await page.locator("#main-content, h1").first().waitFor();
    });
  } finally {
    await page.close();
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const p = (name) => {
    const v = m[name] && m[name].values;
    return v ? { med_ms: v.med?.toFixed(0), p95_ms: v["p(95)"]?.toFixed(0), max_ms: v.max?.toFixed(0) } : null;
  };
  const summary = {
    metadata: { testScript: "aspen_browser.js", testNumber: TEST_NUMBER },
    config: { baseUrl: ASPEN_BASE_URL, browsers: Math.min(100, Math.max(1, ASPEN_BROWSERS)), searchTerm: SEARCH_TERM, stepP95Ms: STEP_P95_MS },
    result: {
      checksRate: m.checks ? (m.checks.values.rate * 100).toFixed(1) + "%" : null,
      iterations: m.iterations?.values?.count,
      stepDuration: p("aspen_step_duration"),
    },
  };
  const out = { stdout: textSummary(data, { indent: " ", enableColors: true }) };
  if (OUTPUT_FILE) out[OUTPUT_FILE] = JSON.stringify(summary, null, 2);
  return out;
}
