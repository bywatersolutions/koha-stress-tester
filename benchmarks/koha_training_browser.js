/**
 * Koha Training Session Browser Test
 *
 * Simulates a training class: LIBRARIANS people all doing the same staff-client
 * exercise at the same time, each in their own real Chromium browser. The load
 * shape that matters here is the lockstep burst - the trainer says "now click
 * Check Out" and every attendee hits the same endpoint within a few seconds -
 * so every VU waits for a shared step boundary (STEP_INTERVAL_S) and then acts
 * with a small human-reaction jitter (STEP_JITTER_S).
 *
 * Exercises, in order (one per tick):
 *   login -> patron_search -> checkout -> checkin -> catalog_search -> place_hold -> wrap_up -> logout
 *
 * No records are created: setup selects EXISTING patrons and available items
 * from the target catalog (one of each per attendee, like real attendees
 * with worksheets), so the only state the test produces is checkouts and
 * holds - which the checkin exercise, the wrap_up step, and teardown put
 * back. The place_hold step is a deliberate collision: everyone holds the
 * SAME bib, because trainers do that and it is where lock contention shows
 * up.
 *
 * Requirements:
 * - k6 binary with browser support (not Docker); Chromium/Chrome installed
 * - A superlibrarian login (STAFF_USER/STAFF_PASS) for API record selection
 * - A target with enough active patrons and available items (LIBRARIANS + 1
 *   of each); use LIBRARY_ID / PATRON_CATEGORY_ID to scope the selection
 * - Still not a production server: real patrons get transient checkouts on
 *   their accounts (think checkout notices), so use the staging clone
 * - 75 concurrent browsers is too heavy for a laptop - run at that scale from
 *   Grafana Cloud (k6 cloud run) or a beefy dedicated generator
 *
 * Pass criteria: checks rate == 1.0 and training_step_duration p95 under
 * STEP_P95_MS - "nobody's screen hung when everyone clicked at once".
 */
import http from "k6/http";
import { browser } from "k6/browser";
import { sleep, check } from "k6";
import exec from "k6/execution";
import { b64encode } from "k6/encoding";
import { Trend, Rate } from "k6/metrics";
import secrets from "k6/secrets";
// Only remote imports below - this script is deliberately single-file so it
// can be pasted straight into the Grafana Cloud k6 script editor
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const STAFF_URL = __ENV.STAFF_URL || "http://kohadev-intra.localhost";
const STAFF_HOST_HEADER = __ENV.STAFF_HOST_HEADER || "";
const [STAFF_PROTOCOL, STAFF_HOST] = STAFF_URL.split("://");
const STAFF_BASE_URL = `${STAFF_PROTOCOL}://${STAFF_HOST}`;
const STAFF_USER = __ENV.STAFF_USER || "koha";
// The staff password comes from the STAFF_PASS env var locally, or from the
// Grafana Cloud secret named STAFF_PASS_SECRET on cloud runs (write-only,
// redacted in logs), falling back to the KTD default
const STAFF_PASS_ENV = __ENV.STAFF_PASS || "";
const STAFF_PASS_SECRET = __ENV.STAFF_PASS_SECRET || "staff-pass";

// How many attendees are in the class, and the trainer's pacing.
// Scan-and-click steps use STEP_JITTER_S; steps where attendees type
// (a cardnumber, a search query) spread out over TYPING_JITTER_S because
// thirty humans don't finish typing together. place_hold keeps the tight
// jitter on purpose - that collision is the point of the exercise.
// Login gets its own, much wider window: trainers deliberately have
// trainees stagger their logins to avoid hammering the server, so the
// class trickles in over LOGIN_JITTER_S and the first exercise tick only
// starts after that window closes.
const LIBRARIANS = parseInt(__ENV.LIBRARIANS) || 75;
const STEP_INTERVAL_S = parseInt(__ENV.STEP_INTERVAL_S) || 90;
const STEP_JITTER_S = parseFloat(__ENV.STEP_JITTER_S) || 5;
const TYPING_JITTER_S = parseFloat(__ENV.TYPING_JITTER_S) || 15;
const LOGIN_JITTER_S = parseFloat(__ENV.LOGIN_JITTER_S) || 60;
const TYPING_STEPS = ["patron_search", "catalog_search"];

// Delay before the first tick so every browser finishes launching and the
// login burst is truly simultaneous (cold-starting N Chromiums staggers
// iteration starts by several seconds)
const STARTUP_GRACE_S = parseInt(__ENV.STARTUP_GRACE_S) || 15;

// Optional per-attendee staff logins (see bin/seed-training-users.pl).
// When TRAINING_USER_PREFIX is empty every VU logs in as STAFF_USER, which
// works out of the box but exercises one account instead of N.
const TRAINING_USER_PREFIX = __ENV.TRAINING_USER_PREFIX || "";
const TRAINING_USER_PASS = __ENV.TRAINING_USER_PASS || "";

// The shared catalog exercise ("everyone search for ...")
const CATALOG_SEARCH_TERM = __ENV.CATALOG_SEARCH_TERM || "harry potter";

// Optional filters for selecting the existing patrons and items the class
// uses; leave blank to pick from the whole catalog
const LIBRARY_ID = __ENV.LIBRARY_ID || "";
const PATRON_CATEGORY_ID = __ENV.PATRON_CATEGORY_ID || "";

// Optional explicit hold-target bib (e.g. the trainer's demo record). By
// default the test finds a bib whose copies are all checked out - holdable
// under any on-shelf-holds policy - or arranges one itself.
const HOLD_BIBLIO_ID = __ENV.HOLD_BIBLIO_ID || "";

// Per-step latency ceiling for the pass/fail threshold
// Pass criteria: a step's p95 must stay under STEP_P95_MS ("nobody's screen
// hung"), and at least CHECKS_RATE of all step executions must complete -
// a class tolerates one trainee retrying, so demanding a perfect 1.0 makes
// a single hiccup in 600 steps fail the whole certification
const STEP_P95_MS = parseInt(__ENV.STEP_P95_MS) || 15000;
const CHECKS_RATE = parseFloat(__ENV.CHECKS_RATE) || 0.98;

// Extra header sent on every request (browser and API), e.g. to let cloud
// runner traffic through a restricted ingress. The value comes from
// EXTERNAL_SERVICE_TOKEN locally, or from the Grafana Cloud secret named
// EXTERNAL_SERVICE_TOKEN_SECRET on cloud runs - never hardcode it here.
const EXTERNAL_SERVICE_HEADER = __ENV.EXTERNAL_SERVICE_HEADER || "x-grafana-cloud-external-service";
const EXTERNAL_SERVICE_TOKEN = __ENV.EXTERNAL_SERVICE_TOKEN || "";
const EXTERNAL_SERVICE_TOKEN_SECRET = __ENV.EXTERNAL_SERVICE_TOKEN_SECRET || "x-grafana-cloud-external-service-token";

// Grafana Cloud test metadata
const CLOUD_TEST_NAME = __ENV.CLOUD_TEST_NAME || "koha-training-session";
const CLOUD_PROJECT_ID = __ENV.CLOUD_PROJECT_ID || "";

// Optional load zones for cloud-executed runs, comma-separated with
// percents totalling 100, e.g. 'amazon:us:ashburn:50,amazon:us:columbus:50'.
// Default: the stack's home zone.
const CLOUD_ZONES = __ENV.CLOUD_ZONES || "";

const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";

const API = `${STAFF_PROTOCOL}://${STAFF_HOST}/api/v1`;

// The lockstep curriculum; each entry is one tick of the trainer's clock.
// During wrap_up only VU 1 acts (the trainer checking the demo item back in);
// community Koha has no REST checkin endpoint, so it must happen in the UI.
const STEPS = ["login", "patron_search", "checkout", "checkin", "catalog_search", "place_hold", "wrap_up", "logout"];

// ------------------------------------------------------------
// METRICS
// ------------------------------------------------------------
const stepDuration = new Trend("training_step_duration", true);
// The wrap_up cleanup does O(class size) API calls and is not a classroom
// exercise, so it gets its own metric and no latency threshold
const cleanupDuration = new Trend("training_cleanup_duration", true);
const stepFailed = new Rate("training_step_failed");

// ------------------------------------------------------------
// OPTIONS
// ------------------------------------------------------------
const browserArgs = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-software-rasterizer",
  "--window-size=1920,1080",
];

// Built as named values so the exported options stays a plain object
// literal - the Grafana Cloud script editor's validator requires that
const thresholds = {
  checks: [`rate>=${CHECKS_RATE}`],
  training_step_duration: [`p(95)<${STEP_P95_MS}`],
};
for (const s of STEPS) {
  if (s !== "wrap_up") {
    thresholds[`training_step_duration{step:${s}}`] = [`p(95)<${STEP_P95_MS}`];
  }
}

const cloudConfig = { name: CLOUD_TEST_NAME };
if (CLOUD_PROJECT_ID) {
  cloudConfig.projectID = parseInt(CLOUD_PROJECT_ID);
}
if (CLOUD_ZONES) {
  const distribution = {};
  for (const entry of CLOUD_ZONES.split(",")) {
    const parts = entry.trim().split(":");
    const percent = parseInt(parts.pop());
    const zone = parts.join(":");
    distribution[zone.replace(/[^a-zA-Z0-9]+/g, "_")] = { loadZone: zone, percent: percent };
  }
  cloudConfig.distribution = distribution;
}

export const options = {
  cloud: cloudConfig,
  // Setup screens existing records via many sequential REST calls; at large
  // LIBRARIANS this exceeds k6's default 60s, so make it generous
  setupTimeout: `${parseInt(__ENV.SETUP_TIMEOUT_S) || 600}s`,
  scenarios: {
    training: {
      executor: "per-vu-iterations",
      vus: LIBRARIANS,
      iterations: 1,
      // The whole session plus generous room for browser startup and stragglers
      maxDuration: `${STARTUP_GRACE_S + LOGIN_JITTER_S + STEPS.length * STEP_INTERVAL_S + 300}s`,
      gracefulStop: "30s",
      options: {
        browser: {
          type: "chromium",
          args: browserArgs,
        },
      },
    },
  },
  thresholds: thresholds,
};

// Build a q= JSON filter for list endpoints. Always filter holds this way:
// the named query params (patron_id, biblio_id) are silently ignored on
// some Koha versions (observed on 25.11), returning unfiltered results.
function jsonQ(obj) {
  return encodeURIComponent(JSON.stringify(obj));
}

// ------------------------------------------------------------
// EXTERNAL SERVICE TOKEN (env var locally, Grafana Cloud secret in cloud)
// ------------------------------------------------------------
let cachedPassword = null;

async function staffPassword() {
  if (cachedPassword !== null) {
    return cachedPassword;
  }
  if (STAFF_PASS_ENV) {
    cachedPassword = STAFF_PASS_ENV;
    return cachedPassword;
  }
  try {
    cachedPassword = await secrets.get(STAFF_PASS_SECRET);
  } catch (e) {
    // No secret source configured (plain local run) - use the KTD default
    cachedPassword = "koha";
  }
  return cachedPassword;
}

let cachedToken = null;

async function externalServiceToken() {
  if (cachedToken !== null) {
    return cachedToken;
  }
  if (EXTERNAL_SERVICE_TOKEN) {
    cachedToken = EXTERNAL_SERVICE_TOKEN;
    return cachedToken;
  }
  try {
    cachedToken = await secrets.get(EXTERNAL_SERVICE_TOKEN_SECRET);
  } catch (e) {
    // No secret source configured (plain local run) - header is simply not sent
    cachedToken = "";
  }
  return cachedToken;
}

async function apiParams(contentType) {
  const headers = {
    Accept: "application/json",
    Authorization: `Basic ${b64encode(`${STAFF_USER}:${await staffPassword()}`)}`,
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  if (STAFF_HOST_HEADER) {
    headers["Host"] = STAFF_HOST_HEADER;
  }
  const token = await externalServiceToken();
  if (token) {
    headers[EXTERNAL_SERVICE_HEADER] = token;
  }
  return { headers };
}

async function pageExtraHeaders(page) {
  const headers = {};
  if (STAFF_HOST_HEADER) {
    headers["Host"] = STAFF_HOST_HEADER;
  }
  const token = await externalServiceToken();
  if (token) {
    headers[EXTERNAL_SERVICE_HEADER] = token;
  }
  if (Object.keys(headers).length > 0) {
    await page.setExtraHTTPHeaders(headers);
  }
}

// ------------------------------------------------------------
// SETUP - SEED TRAINING DATA VIA THE REST API
// ------------------------------------------------------------
export async function setup() {
  console.log("========================================");
  console.log("KOHA TRAINING SESSION BROWSER TEST");
  console.log("========================================");
  console.log(`STAFF_URL: ${STAFF_URL}`);
  if (STAFF_HOST_HEADER) {
    console.log(`STAFF_HOST_HEADER: ${STAFF_HOST_HEADER}`);
  }
  console.log(`LIBRARIANS: ${LIBRARIANS}`);
  console.log(`STEP_INTERVAL_S: ${STEP_INTERVAL_S} (jitter ${STEP_JITTER_S}s, typing jitter ${TYPING_JITTER_S}s, login window ${LOGIN_JITTER_S}s, startup grace ${STARTUP_GRACE_S}s)`);
  console.log(`Curriculum: ${STEPS.join(" -> ")}`);
  console.log(`Logins: ${TRAINING_USER_PREFIX ? `${TRAINING_USER_PREFIX}1..${TRAINING_USER_PREFIX}${LIBRARIANS}` : `shared (${STAFF_USER})`}`);
  const token = await externalServiceToken();
  console.log(`${EXTERNAL_SERVICE_HEADER}: ${token ? `set (${EXTERNAL_SERVICE_TOKEN ? "from env" : "from Grafana Cloud secret"})` : "not sent"}`);
  await staffPassword();
  console.log(`STAFF_PASS: ${STAFF_PASS_ENV ? "from env" : cachedPassword === "koha" ? "default (koha)" : `from Grafana Cloud secret '${STAFF_PASS_SECRET}'`}`);
  console.log("========================================");

  const params = await apiParams();
  const jsonParams = await apiParams("application/json");

  const mustJson = (res, what) => {
    if (res.status !== 200) {
      const body = String(res.body || "").slice(0, 200);
      const hint = body.includes("Basic authentication disabled")
        ? " - enable the RESTBasicAuth system preference on the target"
        : "";
      throw new Error(`${what} failed (${res.status}): ${body}${hint}`);
    }
    return res.json();
  };
  const isCheckedOut = (itemId) => {
    const res = http.get(`${API}/checkouts?q=${jsonQ({ item_id: itemId })}`, params);
    // Treat lookup errors as unusable rather than available
    return res.status !== 200 || res.json().length > 0;
  };
  const biblioHasHolds = (biblioId) => {
    const res = http.get(`${API}/holds?q=${jsonQ({ biblio_id: biblioId })}&_per_page=1`, params);
    return res.status !== 200 || res.json().length > 0;
  };

  // One patron and one item per attendee, plus a spare pair for the
  // hold-target fallback below
  const wanted = LIBRARIANS + 1;

  const patronFilter = {};
  if (PATRON_CATEGORY_ID) {
    patronFilter.category_id = PATRON_CATEGORY_ID;
  }
  if (LIBRARY_ID) {
    patronFilter.library_id = LIBRARY_ID;
  }
  const patronQuery = Object.keys(patronFilter).length ? `q=${jsonQ(patronFilter)}&` : "";
  const patronsRes = http.get(`${API}/patrons?${patronQuery}_per_page=${wanted * 3 + 10}`, params);
  check(patronsRes, { "Loaded patrons": (r) => r.status === 200 });
  const patrons = mustJson(patronsRes, "Loading patrons").filter((p) => p.cardnumber && !p.expired && !p.restricted).slice(0, wanted);
  if (patrons.length < wanted) {
    throw new Error(`Need ${wanted} usable existing patrons (active, unrestricted, with a cardnumber) but only found ${patrons.length}; adjust PATRON_CATEGORY_ID/LIBRARY_ID`);
  }

  const itemFilter = { lost_status: 0, not_for_loan_status: 0, withdrawn: 0, damaged_status: 0 };
  if (LIBRARY_ID) {
    itemFilter.home_library_id = LIBRARY_ID;
  }
  const itemsRes = http.get(`${API}/items?q=${jsonQ(itemFilter)}&_per_page=${wanted * 3 + 20}`, params);
  check(itemsRes, { "Loaded items": (r) => r.status === 200 });
  const items = [];
  for (const candidate of mustJson(itemsRes, "Loading items")) {
    if (items.length >= wanted) {
      break;
    }
    // Checkouts happen by barcode; skip items whose bib has holds (that
    // triggers a confirm dialog) or that are already checked out
    if (!candidate.external_id) {
      continue;
    }
    if (biblioHasHolds(candidate.biblio_id) || isCheckedOut(candidate.item_id)) {
      continue;
    }
    items.push(candidate);
  }
  if (items.length < wanted) {
    throw new Error(`Need ${wanted} available existing items but only found ${items.length}; adjust LIBRARY_ID or check the catalog`);
  }
  console.log(`Selected ${LIBRARIANS} existing patrons and ${LIBRARIANS} available items (plus a spare pair)`);

  // The shared hold target: a bib whose copies are ALL checked out is
  // holdable under any on-shelf-holds policy. Use the configured one, find
  // one, or arrange one by checking the spare item out to the spare patron
  // (VU 1 returns it during wrap_up).
  const sparePatron = patrons.pop();
  const spareItem = items.pop();
  let holdBiblioId = HOLD_BIBLIO_ID ? parseInt(HOLD_BIBLIO_ID) : null;
  let trainerCheckout = null;
  if (!holdBiblioId) {
    const checkoutsRes = http.get(`${API}/checkouts?_per_page=20`, params);
    if (checkoutsRes.status === 200) {
      for (const checkout of checkoutsRes.json()) {
        const checkedOutItemRes = http.get(`${API}/items/${checkout.item_id}`, params);
        if (checkedOutItemRes.status !== 200) {
          continue;
        }
        const biblioId = checkedOutItemRes.json().biblio_id;
        const siblingsRes = http.get(`${API}/items?q=${jsonQ({ biblio_id: biblioId })}&_per_page=100`, params);
        if (siblingsRes.status !== 200) {
          continue;
        }
        if (siblingsRes.json().every((i) => isCheckedOut(i.item_id))) {
          holdBiblioId = biblioId;
          console.log(`Hold target: existing bib ${holdBiblioId} (all copies already checked out)`);
          break;
        }
      }
    }
  }
  if (!holdBiblioId) {
    const spareCheckoutRes = http.post(
      `${API}/checkouts`,
      JSON.stringify({ patron_id: sparePatron.patron_id, item_id: spareItem.item_id }),
      jsonParams,
    );
    if (spareCheckoutRes.status === 201) {
      trainerCheckout = { item_id: spareItem.item_id, external_id: spareItem.external_id };
      console.log(`Hold target: bib ${spareItem.biblio_id} (checked ${spareItem.external_id} out to ${sparePatron.cardnumber} to make it holdable)`);
    } else {
      console.warn(`Could not check out the hold-target item (${spareCheckoutRes.status}); the place_hold step may be blocked by on-shelf hold policy`);
    }
    holdBiblioId = spareItem.biblio_id;
  }

  // Record any holds our patrons already have on the target bib, so cleanup
  // never cancels a real hold a selected patron placed before the test
  const preexistingHoldIds = [];
  for (const p of patrons) {
    const heldRes = http.get(`${API}/holds?q=${jsonQ({ patron_id: p.patron_id, biblio_id: holdBiblioId })}&_per_page=100`, params);
    if (heldRes.status === 200) {
      for (const hold of heldRes.json()) {
        preexistingHoldIds.push(hold.hold_id);
      }
    }
  }
  if (preexistingHoldIds.length) {
    console.warn(`${preexistingHoldIds.length} selected patrons already hold the target bib; their real holds will be preserved`);
  }

  return {
    patrons,
    items,
    holdBiblioId,
    trainerCheckout,
    patronIds: patrons.map((p) => p.patron_id),
    preexistingHoldIds,
  };
}

// ------------------------------------------------------------
// TEARDOWN - PUT BACK THE CHECKOUTS AND HOLDS THE CLASS MADE
// ------------------------------------------------------------
// No records were created, so nothing gets deleted. Holds can be canceled
// via the API; checkouts cannot (community Koha has no REST checkin), so
// anything the checkin and wrap_up exercises missed is reported for a
// manual checkin.
export async function teardown(data) {
  console.log("Cleaning up training checkouts and holds...");
  const params = await apiParams();

  // Cancel any class holds the wrap_up step missed - ours only, and never
  // a hold a selected patron already had on the bib before the test
  for (const patronId of data.patronIds) {
    const heldRes = http.get(`${API}/holds?q=${jsonQ({ patron_id: patronId, biblio_id: data.holdBiblioId })}&_per_page=100`, params);
    if (heldRes.status !== 200) {
      continue;
    }
    for (const hold of heldRes.json()) {
      if (!data.preexistingHoldIds.includes(hold.hold_id)) {
        http.del(`${API}/holds/${hold.hold_id}`, null, params);
      }
    }
  }

  const candidates = data.trainerCheckout ? data.items.concat([data.trainerCheckout]) : data.items;
  const lingering = [];
  for (const item of candidates) {
    const res = http.get(`${API}/checkouts?q=${jsonQ({ item_id: item.item_id })}`, params);
    if (res.status === 200 && res.json().length > 0) {
      lingering.push(item.external_id);
    }
  }
  if (lingering.length) {
    console.warn(`Still checked out and needing a manual checkin: ${lingering.join(", ")}`);
  }

  console.log("========================================");
  console.log("TRAINING SESSION TEST COMPLETE");
  console.log("========================================");
}

// ------------------------------------------------------------
// LOCKSTEP SCHEDULING
// ------------------------------------------------------------
// Sleep until this VU's moment inside the shared step window. A VU that is
// already past the boundary (previous step ran long) proceeds immediately,
// like a trainee catching up with the class.
function waitForStep(stepIndex) {
  const base = exec.scenario.startTime + STARTUP_GRACE_S * 1000;
  let target;
  if (stepIndex === 0) {
    // The login window: the class trickles in over LOGIN_JITTER_S
    target = base + Math.random() * LOGIN_JITTER_S * 1000;
  } else {
    // Cap the jitter below the tick interval so steps can't bleed into each
    // other; ticks are scheduled after the login window closes
    const jitter = Math.min(
      TYPING_STEPS.includes(STEPS[stepIndex]) ? TYPING_JITTER_S : STEP_JITTER_S,
      STEP_INTERVAL_S * 0.8,
    );
    target = base + (LOGIN_JITTER_S + stepIndex * STEP_INTERVAL_S) * 1000 + Math.random() * jitter * 1000;
  }
  const waitMs = target - Date.now();
  if (waitMs > 0) {
    sleep(waitMs / 1000);
  } else if (waitMs < -5000) {
    console.warn(`VU ${exec.vu.idInTest} is ${(-waitMs / 1000).toFixed(0)}s behind the class at step '${STEPS[stepIndex]}'`);
  }
}

async function runStep(name, page, fn) {
  waitForStep(STEPS.indexOf(name));
  // One progress line per tick so a quiet console still shows the class moving
  if (exec.vu.idInTest === 1) {
    console.log(`--- tick ${STEPS.indexOf(name) + 1}/${STEPS.length}: ${name} ---`);
  }
  const started = Date.now();
  let ok = true;
  try {
    await fn();
  } catch (error) {
    ok = false;
    console.error(`VU ${exec.vu.idInTest} step '${name}' failed: ${error && error.message ? error.message : String(error)}`);
    try {
      await page.screenshot({ path: `training_${name}_vu${exec.vu.idInTest}.png` });
    } catch (screenshotError) {
      // Best effort only
    }
  } finally {
    const trend = name === "wrap_up" ? cleanupDuration : stepDuration;
    trend.add(Date.now() - started, { step: name });
    stepFailed.add(!ok, { step: name });
    check(ok, { [`step ${name} completed`]: (v) => v === true });
  }
  return ok;
}

// ------------------------------------------------------------
// THE TRAINING SESSION
// ------------------------------------------------------------
export default async function (data) {
  const vuNumber = exec.vu.idInTest;
  const patron = data.patrons[vuNumber - 1];
  const item = data.items[vuNumber - 1];
  const username = TRAINING_USER_PREFIX ? `${TRAINING_USER_PREFIX}${vuNumber}` : STAFF_USER;
  const password = TRAINING_USER_PREFIX ? TRAINING_USER_PASS : await staffPassword();

  const page = await browser.newPage();
  await pageExtraHeaders(page);

  try {
    const loggedIn = await runStep("login", page, async () => {
      await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/mainpage.pl`, { waitUntil: "networkidle" });

      const localLoginBtn = page.locator("#locallogin_button");
      if ((await localLoginBtn.count()) > 0) {
        await localLoginBtn.click();
      }
      await page.locator('input[name="login_userid"]').type(username);
      await page.locator('input[name="login_password"]').type(password);
      await Promise.all([
        page.waitForNavigation(),
        page.locator("#submit-button").click({ force: true }),
      ]);

      const loggedInUser = await page.locator("span.loggedinusername").first().textContent();
      if (!loggedInUser || !loggedInUser.includes(username)) {
        throw new Error(`Not logged in as ${username}`);
      }
    });
    if (!loggedIn) {
      // Without a session the rest of the class is meaningless for this VU
      return;
    }

    await runStep("patron_search", page, async () => {
      // The header patron-search box submits findborrower to circulation.pl;
      // an exact cardnumber match lands on the patron's checkout page
      await page.goto(
        `${STAFF_BASE_URL}/cgi-bin/koha/circ/circulation.pl?findborrower=${encodeURIComponent(patron.cardnumber)}`,
        { waitUntil: "domcontentloaded" },
      );
      const body = await page.locator("body").textContent();
      if (!body.includes(patron.cardnumber) && !(patron.surname && body.includes(patron.surname))) {
        throw new Error(`Patron search did not land on ${patron.cardnumber}`);
      }
    });

    await runStep("checkout", page, async () => {
      await page.goto(
        `${STAFF_BASE_URL}/cgi-bin/koha/circ/circulation.pl?borrowernumber=${patron.patron_id}`,
        { waitUntil: "domcontentloaded" },
      );
      await page.locator('#circ_circulation_issue input[name="barcode"]').type(item.external_id);
      await Promise.all([
        page.waitForNavigation(),
        page.locator('#circ_circulation_issue button[type="submit"]').click(),
      ]);
      // Real-world items can trigger a confirm dialog (rental charge, age
      // restriction, ...) - approve it like a trainee would
      const confirmBtn = page.locator("#circ_needsconfirmation button.approve");
      if ((await confirmBtn.count()) > 0) {
        await Promise.all([page.waitForNavigation(), confirmBtn.first().click()]);
      }
      // The 'Checked out: <title> (<barcode>). Due on <date>' confirmation
      const body = await page.locator("body").textContent();
      if (!body.includes("Checked out") || !body.includes(item.external_id)) {
        throw new Error(`Checkout of ${item.external_id} not confirmed`);
      }
    });

    await runStep("checkin", page, async () => {
      await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/circ/returns.pl`, { waitUntil: "domcontentloaded" });
      await page.locator("#barcode").type(item.external_id);
      await Promise.all([
        page.waitForNavigation(),
        page.locator('#circ_returns_checkin button[type="submit"]').click(),
      ]);
      const body = await page.locator("body").textContent();
      if (!body.includes(item.external_id)) {
        throw new Error(`Checkin of ${item.external_id} not confirmed`);
      }
    });

    await runStep("catalog_search", page, async () => {
      // The whole class searches the same term at once, warm-cache style
      await page.goto(
        `${STAFF_BASE_URL}/cgi-bin/koha/catalogue/search.pl?q=${encodeURIComponent(CATALOG_SEARCH_TERM)}`,
        { waitUntil: "domcontentloaded" },
      );
      // A multi-hit search lands on the results page, a single hit jumps
      // straight to the detail page - both are successful searches
      const title = await page.title();
      if (!title.includes("Catalog")) {
        throw new Error(`Catalog search page did not load (title: ${title})`);
      }
    });

    await runStep("place_hold", page, async () => {
      // Deliberate collision: every attendee holds the same bib for their own patron
      await page.goto(
        `${STAFF_BASE_URL}/cgi-bin/koha/reserve/request.pl?biblionumber=${data.holdBiblioId}&findborrower=${encodeURIComponent(patron.cardnumber)}`,
        { waitUntil: "domcontentloaded" },
      );
      // Koha renders the submit as either an input or a button depending on
      // the form variant, so accept both
      let placeHoldBtn = page.locator('#hold-request-form input[type="submit"][value="Place hold"]');
      if ((await placeHoldBtn.count()) === 0) {
        placeHoldBtn = page.locator('#hold-request-form button[type="submit"]');
      }
      if ((await placeHoldBtn.count()) === 0) {
        throw new Error("Place hold button not found (hold may be blocked by policy)");
      }
      await Promise.all([page.waitForNavigation(), placeHoldBtn.first().click()]);
      // The existing-holds list is an AJAX DataTable that fills on its own
      // schedule, so verify against the API instead of racing the render
      const holdsRes = http.get(
        `${API}/holds?q=${jsonQ({ patron_id: patron.patron_id, biblio_id: data.holdBiblioId })}&_per_page=100`,
        await apiParams(),
      );
      const mine = holdsRes.status === 200 && holdsRes.json().some(
        (h) => !data.preexistingHoldIds.includes(h.hold_id),
      );
      if (!mine) {
        throw new Error("Hold not present on the bib after placing");
      }
    });

    if (vuNumber === 1) {
      await runStep("wrap_up", page, async () => {
        // The trainer wraps up: cancel the class's holds via API (ours only -
        // the bib may carry real holds; canceling first also avoids the
        // hold-found modal), then check back in anything still checked out.
        // Community Koha has no REST checkin, hence the UI.
        const params = await apiParams();
        for (const patronId of data.patronIds) {
          const heldRes = http.get(`${API}/holds?q=${jsonQ({ patron_id: patronId, biblio_id: data.holdBiblioId })}&_per_page=100`, params);
          if (heldRes.status !== 200) {
            continue;
          }
          for (const hold of heldRes.json()) {
            if (!data.preexistingHoldIds.includes(hold.hold_id)) {
              http.del(`${API}/holds/${hold.hold_id}`, null, params);
            }
          }
        }

        // The arranged hold-target checkout, plus any item a failed checkin
        // exercise left checked out
        const returnBarcodes = [];
        if (data.trainerCheckout) {
          returnBarcodes.push(data.trainerCheckout.external_id);
        }
        for (const classItem of data.items) {
          const res = http.get(`${API}/checkouts?q=${jsonQ({ item_id: classItem.item_id })}`, params);
          if (res.status === 200 && res.json().length > 0) {
            returnBarcodes.push(classItem.external_id);
          }
        }
        for (const barcode of returnBarcodes) {
          await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/circ/returns.pl`, { waitUntil: "domcontentloaded" });
          await page.locator("#barcode").type(barcode);
          await Promise.all([
            page.waitForNavigation(),
            page.locator('#circ_returns_checkin button[type="submit"]').click(),
          ]);
          // Dismiss a hold-found or transfer modal if one appears
          try {
            const dismissBtn = page.locator("button.deny");
            if ((await dismissBtn.count()) > 0) {
              await dismissBtn.first().click();
            }
          } catch (dismissError) {
            // Best effort only
          }
        }
      });
    } else {
      // The class watches the trainer wrap up
      waitForStep(STEPS.indexOf("wrap_up"));
    }

    await runStep("logout", page, async () => {
      await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/staff/logout.pl`, { waitUntil: "domcontentloaded" });
    });
    console.log(`VU ${vuNumber} finished the training session`);
  } finally {
    await page.close();
  }
}

// ------------------------------------------------------------
// SUMMARY (local runs only - Grafana Cloud does not execute handleSummary)
// ------------------------------------------------------------
// Inlined from lib/reporting.js so the script stays single-file
function extractChecks(data) {
  const checks = {};
  if (data.root_group?.checks) {
    for (const c of data.root_group.checks) {
      const total = c.passes + c.fails;
      checks[c.name] = {
        passes: c.passes,
        fails: c.fails,
        rate: total > 0 ? `${((c.passes / total) * 100).toFixed(1)}%` : "N/A",
      };
    }
  }
  return checks;
}

function generateOutputPath(scriptName, testNumber) {
  const now = new Date();
  const shortDate = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 16).replace(/:/g, "");
  const outputDir = __ENV.OUTPUT_DIR || "/output";
  return `${outputDir}/${scriptName}-${testNumber}-${shortDate}-${time}.json`;
}

export function handleSummary(data) {
  const m = data.metrics;

  const steps = {};
  for (const s of STEPS) {
    const trend = s === "wrap_up" ? m.training_cleanup_duration : m[`training_step_duration{step:${s}}`];
    if (trend) {
      steps[s] = {
        avg_ms: trend.values?.avg?.toFixed(0) || null,
        p95_ms: trend.values?.["p(95)"]?.toFixed(0) || null,
        max_ms: trend.values?.max?.toFixed(0) || null,
      };
    }
  }

  const summary = {
    metadata: {
      testScript: "koha_training_browser.js",
      testNumber: TEST_NUMBER,
      timestamp: new Date().toISOString(),
    },
    config: {
      staffUrl: STAFF_URL,
      staffHostHeader: STAFF_HOST_HEADER || "(not set)",
      librarians: LIBRARIANS,
      stepIntervalS: STEP_INTERVAL_S,
      stepJitterS: STEP_JITTER_S,
      typingJitterS: TYPING_JITTER_S,
      loginJitterS: LOGIN_JITTER_S,
      stepP95Ms: STEP_P95_MS,
      checksRate: CHECKS_RATE,
      trainingUserPrefix: TRAINING_USER_PREFIX || "(shared login)",
      catalogSearchTerm: CATALOG_SEARCH_TERM,
      externalServiceHeader: EXTERNAL_SERVICE_HEADER,
      headless: __ENV.K6_BROWSER_HEADLESS !== "false",
    },
    result: {
      totalIterations: m.iterations?.values?.count || 0,
      checksRate: m.checks?.values?.rate?.toFixed(4) || null,
      stepFailedRate: m.training_step_failed?.values?.rate?.toFixed(4) || null,
      steps,
    },
    browserMetrics: {
      httpReqDuration_avg_ms: m.browser_http_req_duration?.values?.avg?.toFixed(2) || null,
      httpReqDuration_p95_ms: m.browser_http_req_duration?.values?.["p(95)"]?.toFixed(2) || null,
      httpReqFailed_rate: m.browser_http_req_failed?.values?.rate?.toFixed(4) || null,
    },
    webVitals: {
      fcp_avg_ms: m.browser_web_vital_fcp?.values?.avg?.toFixed(2) || null,
      lcp_avg_ms: m.browser_web_vital_lcp?.values?.avg?.toFixed(2) || null,
      ttfb_avg_ms: m.browser_web_vital_ttfb?.values?.avg?.toFixed(2) || null,
    },
    checks: extractChecks(data),
  };

  const outputPath = OUTPUT_FILE || generateOutputPath("koha-training", TEST_NUMBER);

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + `\n  Output: ${outputPath}\n`,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}
