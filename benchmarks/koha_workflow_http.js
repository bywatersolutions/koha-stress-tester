/**
 * Koha Workflow HTTP Stress Test
 * 
 * Tests Koha with a complete librarian workflow under staged load.
 * Uses HTTP/REST API only (no browser) for higher throughput than browser tests.
 * 
 * Workflow per iteration:
 * 1. Create a patron
 * 2. Create a biblio (catalog record)
 * 3. Create an item (attached to biblio)
 * 4. Checkout item to patron
 * 5. Checkin item
 * 6. Delete item, biblio, patron (cleanup)
 * 
 * This mirrors the original koha.js workflow but without browser overhead.
 * For read-only API testing, use koha_api_http.js
 */
import http from "k6/http";
import { sleep, check } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import encoding from "k6/encoding";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import * as reporting from "./lib/reporting.js";
import { randomElement, randomString, generateUUID } from "./lib/utils.js";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const STAFF_URL = __ENV.STAFF_URL || "https://kohadev-intra.localhost";
const STAFF_HOST_HEADER = __ENV.STAFF_HOST_HEADER || "";
const STAFF_USER = __ENV.STAFF_USER || "koha";
const STAFF_PASS = __ENV.STAFF_PASS || "koha";

// Staged load test parameters
const MAX_VUS = parseInt(__ENV.MAX_VUS) || 50;
const VU_STEP = parseInt(__ENV.VU_STEP) || 5;
const RAMP_TIME = __ENV.RAMP_TIME || "10s";
const HOLD_TIME = __ENV.HOLD_TIME || "30s";
const ABORT_MS = parseInt(__ENV.KOHA_WORKFLOW_ABORT_MS) || 10000;
const THRESHOLD_PERCENTILE = parseInt(__ENV.THRESHOLD_PERCENTILE) || 98;
const MAX_FAIL_CON_RATE = parseFloat(__ENV.KOHA_WORKFLOW_MAX_FAIL_CON_RATE) || 0.10;
const REQUEST_TIMEOUT = __ENV.KOHA_WORKFLOW_REQUEST_TIMEOUT || "30s";
const REQUEST_TIMEOUT_MS = parseInt(REQUEST_TIMEOUT) * 1000;
const HOLD_ON_FAIL = __ENV.HOLD_ON_FAIL || "30s";
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";
const SLOW_LOG_MS = parseInt(__ENV.KOHA_WORKFLOW_SLOW_LOG_MS) || 5000;
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

let __peakVUs = 0;

const words = new SharedArray("words", function () {
  return open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim());
});

// API headers with Basic Auth
const apiHeaders = {
  "Authorization": "Basic " + encoding.b64encode(`${STAFF_USER}:${STAFF_PASS}`),
  "Accept": "application/json",
  "Content-Type": "application/json",
  "User-Agent": "k6-stress-test",
};
if (STAFF_HOST_HEADER) {
  apiHeaders["Host"] = STAFF_HOST_HEADER;
}

const apiParams = {
  headers: apiHeaders,
  timeout: REQUEST_TIMEOUT,
  noConnectionReuse: NO_CONNECTION_REUSE,
};

// For MARC-in-JSON requests
const marcHeaders = {
  ...apiHeaders,
  "Content-Type": "application/marc-in-json",
};
if (STAFF_HOST_HEADER) {
  marcHeaders["Host"] = STAFF_HOST_HEADER;
}

const marcParams = {
  headers: marcHeaders,
  timeout: REQUEST_TIMEOUT,
  noConnectionReuse: NO_CONNECTION_REUSE,
};

function logRequestStatus(res, label, vus) {
  const duration = res.timings.duration;
  if (res.status < 200 || res.status >= 300) {
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
  gracefulStop: "30s",
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

// Shared data loaded in setup
let __setupData = null;

export function setup() {
  console.log(`========================================`);
  console.log(`KOHA WORKFLOW BENCHMARK TEST`);
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
  console.log(`NO_CONNECTION_REUSE: ${NO_CONNECTION_REUSE}`);
  console.log(`========================================`);

  // Load reference data needed for creating records
  const patronCategoriesRes = http.get(`${STAFF_URL}/api/v1/patron_categories?_per_page=100`, apiParams);
  check(patronCategoriesRes, { "Loaded patron categories": (r) => r.status === 200 });
  const patronCategories = patronCategoriesRes.json() || [];
  console.log(`Loaded ${patronCategories.length} patron categories`);

  const librariesRes = http.get(`${STAFF_URL}/api/v1/libraries?_per_page=100`, apiParams);
  check(librariesRes, { "Loaded libraries": (r) => r.status === 200 });
  const libraries = librariesRes.json() || [];
  console.log(`Loaded ${libraries.length} libraries`);

  const itemTypesRes = http.get(`${STAFF_URL}/api/v1/item_types?_per_page=100`, apiParams);
  check(itemTypesRes, { "Loaded item types": (r) => r.status === 200 });
  const itemTypes = itemTypesRes.json() || [];
  console.log(`Loaded ${itemTypes.length} item types`);

  if (patronCategories.length === 0 || libraries.length === 0 || itemTypes.length === 0) {
    console.error("ERROR: Missing required reference data. Check API connectivity and credentials.");
  }

  return { patronCategories, libraries, itemTypes };
}

export function teardown() {
  console.log(`\n========================================`);
  console.log(`TEST COMPLETE`);
  console.log(`========================================`);
}

export default function (data) {
  const currentVUs = exec.instance.vusActive;
  if (currentVUs > __peakVUs) {
    __peakVUs = currentVUs;
  }

  // Select reference data
  const patronCategory = data.patronCategories[0];
  const library = data.libraries[0];
  const itemType = data.itemTypes[0];

  if (!patronCategory || !library || !itemType) {
    console.error("Missing reference data, skipping iteration");
    return;
  }

  let patron = null;
  let biblio = null;
  let item = null;
  let checkout = null;

  try {
    // 1. Create Patron
    const patronData = {
      surname: randomElement(words),
      firstname: randomElement(words),
      cardnumber: generateUUID(),
      category_id: patronCategory.patron_category_id,
      library_id: library.library_id,
      date_of_birth: "1990-01-01",
    };

    const patronRes = http.post(
      `${STAFF_URL}/api/v1/patrons`,
      JSON.stringify(patronData),
      apiParams
    );
    logRequestStatus(patronRes, "Create patron", currentVUs);
    
    if (check(patronRes, { "Patron created": (r) => r.status === 201 })) {
      patron = patronRes.json();
      console.log(`Created patron: ${patron.patron_id}`);
    } else {
      console.error(`Failed to create patron: ${patronRes.status} ${patronRes.body}`);
      return;
    }

    thinkTime(2);

    // 2. Create Biblio
    const biblioData = {
      leader: "00000nam a2200000 i 4500",
      fields: [
        { "001": `K6-${generateUUID().substring(0, 8)}` },
        { "005": new Date().toISOString().replace(/[-:T]/g, "").substring(0, 14) + ".0" },
        { "008": "250120s2025    xx            000 0 eng d" },
        { "100": { ind1: "1", ind2: " ", subfields: [{ a: `${randomElement(words)}, ${randomElement(words)}` }] } },
        { "245": { ind1: "1", ind2: "0", subfields: [{ a: `${randomElement(words)} ${randomElement(words)}` }, { b: "k6 stress test record" }] } },
        { "260": { ind1: " ", ind2: " ", subfields: [{ a: "Test City" }, { b: "K6 Press" }, { c: "2025" }] } },
      ],
    };

    const biblioRes = http.post(
      `${STAFF_URL}/api/v1/biblios`,
      JSON.stringify(biblioData),
      marcParams
    );
    logRequestStatus(biblioRes, "Create biblio", currentVUs);

    if (check(biblioRes, { "Biblio created": (r) => r.status === 200 || r.status === 201 })) {
      biblio = biblioRes.json();
      console.log(`Created biblio: ${biblio.biblio_id || biblio.id}`);
    } else {
      console.error(`Failed to create biblio: ${biblioRes.status} ${biblioRes.body}`);
      // Cleanup patron and return
      if (patron) deletePatron(patron.patron_id, currentVUs);
      return;
    }

    thinkTime(2);

    // 3. Create Item
    const biblioId = biblio.biblio_id || biblio.id;
    const itemData = {
      external_id: randomString(20),
      item_type_id: itemType.item_type_id,
      home_library_id: library.library_id,
      holding_library_id: library.library_id,
      callnumber: "K6-STRESS-TEST",
    };

    const itemRes = http.post(
      `${STAFF_URL}/api/v1/biblios/${biblioId}/items`,
      JSON.stringify(itemData),
      apiParams
    );
    logRequestStatus(itemRes, "Create item", currentVUs);

    if (check(itemRes, { "Item created": (r) => r.status === 201 })) {
      item = itemRes.json();
      console.log(`Created item: ${item.item_id}`);
    } else {
      console.error(`Failed to create item: ${itemRes.status} ${itemRes.body}`);
      // Cleanup and return
      if (biblio) deleteBiblio(biblioId, currentVUs);
      if (patron) deletePatron(patron.patron_id, currentVUs);
      return;
    }

    thinkTime(2);

    // 4. Checkout
    const checkoutData = {
      patron_id: patron.patron_id,
      item_id: item.item_id,
    };

    const checkoutRes = http.post(
      `${STAFF_URL}/api/v1/checkouts`,
      JSON.stringify(checkoutData),
      apiParams
    );
    logRequestStatus(checkoutRes, "Checkout", currentVUs);

    if (check(checkoutRes, { "Checkout successful": (r) => r.status === 201 })) {
      checkout = checkoutRes.json();
      console.log(`Checkout created: ${checkout.checkout_id}`);
    } else {
      // Checkout might fail if item not available - log but continue to cleanup
      console.warn(`Checkout failed: ${checkoutRes.status} ${checkoutRes.body}`);
    }

    thinkTime(3);

    // 5. Checkin (return the item)
    if (checkout) {
      const checkinRes = http.post(
        `${STAFF_URL}/api/v1/checkins`,
        JSON.stringify({ item_id: item.item_id }),
        apiParams
      );
      logRequestStatus(checkinRes, "Checkin", currentVUs);

      check(checkinRes, { "Checkin successful": (r) => r.status === 200 || r.status === 201 });
      console.log(`Checkin completed`);
    }

    thinkTime(2);

  } catch (error) {
    console.error(`Workflow error: ${error.message}`);
  } finally {
    // 6. Cleanup - delete created records in reverse order
    if (item) {
      deleteItem(item.item_id, currentVUs);
    }
    if (biblio) {
      const biblioId = biblio.biblio_id || biblio.id;
      deleteBiblio(biblioId, currentVUs);
    }
    if (patron) {
      deletePatron(patron.patron_id, currentVUs);
    }
  }
}

function deleteItem(itemId, vus) {
  const res = http.del(`${STAFF_URL}/api/v1/items/${itemId}`, null, apiParams);
  logRequestStatus(res, "Delete item", vus);
  check(res, { "Item deleted": (r) => r.status === 204 || r.status === 200 });
}

function deleteBiblio(biblioId, vus) {
  const res = http.del(`${STAFF_URL}/api/v1/biblios/${biblioId}`, null, apiParams);
  logRequestStatus(res, "Delete biblio", vus);
  check(res, { "Biblio deleted": (r) => r.status === 204 || r.status === 200 });
}

function deletePatron(patronId, vus) {
  const res = http.del(`${STAFF_URL}/api/v1/patrons/${patronId}`, null, apiParams);
  logRequestStatus(res, "Delete patron", vus);
  check(res, { "Patron deleted": (r) => r.status === 204 || r.status === 200 });
}

export function handleSummary(data) {
  const m = data.metrics;
  const abortReason = reporting.getAbortReason(data, {
    thresholdPercentile: THRESHOLD_PERCENTILE,
    abortMs: ABORT_MS,
    maxFailRate: MAX_FAIL_CON_RATE,
    peakVUs: __peakVUs,
    maxVUs: MAX_VUS,
  });
  const { totalRequests, testDuration, rps } = reporting.calculateDerivedMetrics(data);

  const summary = {
    metadata: {
      testScript: "koha_workflow_http.js",
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
      noConnectionReuse: NO_CONNECTION_REUSE,
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

  const outputPath = OUTPUT_FILE || reporting.generateOutputPath("koha-workflow", TEST_NUMBER);
  const customSummary = reporting.formatSummary(data, { peakVUs: __peakVUs, thresholdPercentile: THRESHOLD_PERCENTILE }) + `  Output: ${outputPath}\n`;

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + "\n" + customSummary,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}

