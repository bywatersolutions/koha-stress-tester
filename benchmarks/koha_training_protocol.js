/**
 * Koha Training Session Protocol Test
 *
 * The HTTP-level twin of koha_training_browser.js. It drives the same staff-
 * client curriculum ( login, patron search, checkout, checkin, catalog
 * search, a hold collision on one bib ) but with plain HTTP requests instead
 * of a real browser: GET the CGI page, scrape its csrf_token, POST the form.
 *
 * Why both exist: the origin only ever sees the dynamic CGI/REST requests -
 * a CDN caches every /intranet-tmpl/ asset - so this test puts the same load
 * on Plack, sessions, and the database as the browser test, at a fraction of
 * the cost and with none of the browser-runner limits. What it does NOT
 * measure is client render time / web vitals; use the browser test at 15-30
 * VUs for that. Validate that this test is origin-equivalent by running both
 * against the same target and diffing the Apache-log fingerprints with
 * bin/analyze-koha-logs.pl --compare ( the endpoint mixes should match once
 * cached assets are excluded ).
 *
 * Because there is no browser, this scales to hundreds of simulated trainees
 * on a modest generator and runs anywhere, including Grafana Cloud runners.
 *
 * Requirements:
 * - A superlibrarian login ( STAFF_USER / STAFF_PASS ) with RESTBasicAuth
 *   enabled on the target, for record selection and state verification
 * - Still a staging clone, not production: real patrons get transient
 *   checkouts and holds
 */
import http from "k6/http";
import { sleep, check } from "k6";
import exec from "k6/execution";
import { b64encode } from "k6/encoding";
import { Trend, Rate } from "k6/metrics";
import secrets from "k6/secrets";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES ( shared with koha_training_browser.js )
// ------------------------------------------------------------
const STAFF_URL = __ENV.STAFF_URL || "http://kohadev-intra.localhost";
const STAFF_HOST_HEADER = __ENV.STAFF_HOST_HEADER || "";
const [STAFF_PROTOCOL, STAFF_HOST] = STAFF_URL.split("://");
const STAFF_BASE_URL = `${STAFF_PROTOCOL}://${STAFF_HOST}`;
const STAFF_USER = __ENV.STAFF_USER || "koha";

const STAFF_PASS_ENV = __ENV.STAFF_PASS || "";
const STAFF_PASS_SECRET = __ENV.STAFF_PASS_SECRET || "staff-pass";

const LIBRARIANS = parseInt(__ENV.LIBRARIANS) || 75;
const STEP_INTERVAL_S = parseInt(__ENV.STEP_INTERVAL_S) || 90;
const STEP_JITTER_S = parseFloat(__ENV.STEP_JITTER_S) || 5;
const TYPING_JITTER_S = parseFloat(__ENV.TYPING_JITTER_S) || 15;
const LOGIN_JITTER_S = parseFloat(__ENV.LOGIN_JITTER_S) || 60;
const TYPING_STEPS = ["patron_search", "catalog_search"];
const STARTUP_GRACE_S = parseInt(__ENV.STARTUP_GRACE_S) || 15;

const TRAINING_USER_PREFIX = __ENV.TRAINING_USER_PREFIX || "";
const TRAINING_USER_PASS = __ENV.TRAINING_USER_PASS || "";

const CATALOG_SEARCH_TERM = __ENV.CATALOG_SEARCH_TERM || "harry potter";

const LIBRARY_ID = __ENV.LIBRARY_ID || "";
const PATRON_CATEGORY_ID = __ENV.PATRON_CATEGORY_ID || "";
const HOLD_BIBLIO_ID = __ENV.HOLD_BIBLIO_ID || "";

const STEP_P95_MS = parseInt(__ENV.STEP_P95_MS) || 15000;
const CHECKS_RATE = parseFloat(__ENV.CHECKS_RATE) || 0.98;

const EXTERNAL_SERVICE_HEADER = __ENV.EXTERNAL_SERVICE_HEADER || "x-grafana-cloud-external-service";
const EXTERNAL_SERVICE_TOKEN = __ENV.EXTERNAL_SERVICE_TOKEN || "";
const EXTERNAL_SERVICE_TOKEN_SECRET = __ENV.EXTERNAL_SERVICE_TOKEN_SECRET || "x-grafana-cloud-external-service-token";

const CLOUD_TEST_NAME = __ENV.CLOUD_TEST_NAME || "koha-training-session-protocol";
const CLOUD_PROJECT_ID = __ENV.CLOUD_PROJECT_ID || "";
const CLOUD_ZONES = __ENV.CLOUD_ZONES || "";

const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";

const API = `${STAFF_PROTOCOL}://${STAFF_HOST}/api/v1`;
const CGI = `${STAFF_BASE_URL}/cgi-bin/koha`;

const STEPS = ["login", "patron_search", "checkout", "checkin", "catalog_search", "place_hold", "wrap_up", "logout"];

// ------------------------------------------------------------
// METRICS
// ------------------------------------------------------------
const stepDuration = new Trend("training_step_duration", true);
const cleanupDuration = new Trend("training_cleanup_duration", true);
const stepFailed = new Rate("training_step_failed");

// ------------------------------------------------------------
// OPTIONS
// ------------------------------------------------------------
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
      maxDuration: `${STARTUP_GRACE_S + LOGIN_JITTER_S + STEPS.length * STEP_INTERVAL_S + 300}s`,
      gracefulStop: "30s",
    },
  },
  thresholds: thresholds,
};

// ------------------------------------------------------------
// SECRETS ( env var locally, Grafana Cloud secret on cloud runs )
// ------------------------------------------------------------
function jsonQ(obj) {
  return encodeURIComponent(JSON.stringify(obj));
}

let cachedPassword = null;
async function staffPassword() {
  if (cachedPassword !== null) return cachedPassword;
  if (STAFF_PASS_ENV) {
    cachedPassword = STAFF_PASS_ENV;
    return cachedPassword;
  }
  try {
    cachedPassword = await secrets.get(STAFF_PASS_SECRET);
  } catch (e) {
    cachedPassword = "koha";
  }
  return cachedPassword;
}

let cachedToken = null;
async function externalServiceToken() {
  if (cachedToken !== null) return cachedToken;
  if (EXTERNAL_SERVICE_TOKEN) {
    cachedToken = EXTERNAL_SERVICE_TOKEN;
    return cachedToken;
  }
  try {
    cachedToken = await secrets.get(EXTERNAL_SERVICE_TOKEN_SECRET);
  } catch (e) {
    cachedToken = "";
  }
  return cachedToken;
}

// Params for the REST API ( basic auth ), used for record selection,
// verification, and cleanup
async function apiParams(contentType) {
  const headers = {
    Accept: "application/json",
    Authorization: `Basic ${b64encode(`${STAFF_USER}:${await staffPassword()}`)}`,
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (STAFF_HOST_HEADER) headers["Host"] = STAFF_HOST_HEADER;
  const token = await externalServiceToken();
  if (token) headers[EXTERNAL_SERVICE_HEADER] = token;
  return { headers };
}

// Params for the CGI staff pages ( cookie-session auth, maintained per VU );
// the token is captured once in setup and threaded through data
function pageParams(token, contentType) {
  const headers = { Accept: "text/html" };
  if (contentType) headers["Content-Type"] = contentType;
  if (STAFF_HOST_HEADER) headers["Host"] = STAFF_HOST_HEADER;
  if (token) headers[EXTERNAL_SERVICE_HEADER] = token;
  return { headers };
}

// ------------------------------------------------------------
// HTML HELPERS
// ------------------------------------------------------------
// Scrape the csrf_token hidden input ( tolerant of attribute order )
function csrfFrom(body) {
  const tag = body && body.match(/<input[^>]*name="csrf_token"[^>]*>/i);
  if (!tag) return null;
  const v = tag[0].match(/value="([^"]*)"/i);
  return v ? v[1] : null;
}

// Collect every hidden input into an object, so a form POST can echo the
// fields the page rendered ( title, biblionumber, csrf_token, ... )
function hiddenInputs(body) {
  const out = {};
  if (!body) return out;
  const re = /<input[^>]*type="hidden"[^>]*>/gi;
  let m;
  while ((m = re.exec(body))) {
    const n = m[0].match(/name="([^"]*)"/i);
    const v = m[0].match(/value="([^"]*)"/i);
    if (n) out[n[1]] = v ? v[1] : "";
  }
  return out;
}

// ------------------------------------------------------------
// SETUP - SELECT EXISTING RECORDS ( same strategy as the browser test )
// ------------------------------------------------------------
export async function setup() {
  const token = await externalServiceToken();
  console.log("========================================");
  console.log("KOHA TRAINING SESSION PROTOCOL TEST");
  console.log("========================================");
  console.log(`STAFF_URL: ${STAFF_URL}`);
  console.log(`LIBRARIANS: ${LIBRARIANS}`);
  console.log(`STEP_INTERVAL_S: ${STEP_INTERVAL_S} (jitter ${STEP_JITTER_S}s, typing jitter ${TYPING_JITTER_S}s, login window ${LOGIN_JITTER_S}s, startup grace ${STARTUP_GRACE_S}s)`);
  console.log(`Curriculum: ${STEPS.join(" -> ")}`);
  console.log(`Logins: ${TRAINING_USER_PREFIX ? `${TRAINING_USER_PREFIX}1..${TRAINING_USER_PREFIX}${LIBRARIANS}` : `shared (${STAFF_USER})`}`);
  console.log(`${EXTERNAL_SERVICE_HEADER}: ${token ? `set (${EXTERNAL_SERVICE_TOKEN ? "from env" : "from Grafana Cloud secret"})` : "not sent"}`);
  await staffPassword();
  console.log(`STAFF_PASS: ${STAFF_PASS_ENV ? "from env" : cachedPassword === "koha" ? "default (koha)" : `from Grafana Cloud secret '${STAFF_PASS_SECRET}'`}`);
  console.log("========================================");

  const params = await apiParams();
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
    return res.status !== 200 || res.json().length > 0;
  };
  const biblioHasHolds = (biblioId) => {
    const res = http.get(`${API}/holds?q=${jsonQ({ biblio_id: biblioId })}&_per_page=1`, params);
    return res.status !== 200 || res.json().length > 0;
  };

  // The session/checkout branch and hold pickup location = the staff user's
  // library ( the CGI forms default to it )
  const staffRes = http.get(`${API}/patrons?q=${jsonQ({ userid: STAFF_USER })}`, params);
  const staffPatron = mustJson(staffRes, "Loading staff user")[0];
  const staffBranch = staffPatron ? staffPatron.library_id : (LIBRARY_ID || "");
  if (!staffBranch) {
    throw new Error("Could not determine the staff user's branch; set LIBRARY_ID");
  }

  const wanted = LIBRARIANS + 1;

  const patronFilter = {};
  if (PATRON_CATEGORY_ID) patronFilter.category_id = PATRON_CATEGORY_ID;
  if (LIBRARY_ID) patronFilter.library_id = LIBRARY_ID;
  const patronQuery = Object.keys(patronFilter).length ? `q=${jsonQ(patronFilter)}&` : "";
  const patronsRes = http.get(`${API}/patrons?${patronQuery}_per_page=${wanted * 3 + 10}`, params);
  const patrons = mustJson(patronsRes, "Loading patrons")
    .filter((p) => p.cardnumber && !p.expired && !p.restricted)
    .slice(0, wanted);
  if (patrons.length < wanted) {
    throw new Error(`Need ${wanted} usable existing patrons but found ${patrons.length}; adjust PATRON_CATEGORY_ID/LIBRARY_ID`);
  }

  const itemFilter = { lost_status: 0, not_for_loan_status: 0, withdrawn: 0, damaged_status: 0 };
  if (LIBRARY_ID) itemFilter.home_library_id = LIBRARY_ID;
  const itemsRes = http.get(`${API}/items?q=${jsonQ(itemFilter)}&_per_page=${wanted * 3 + 20}`, params);
  const items = [];
  for (const candidate of mustJson(itemsRes, "Loading items")) {
    if (items.length >= wanted) break;
    if (!candidate.external_id) continue;
    if (biblioHasHolds(candidate.biblio_id) || isCheckedOut(candidate.item_id)) continue;
    items.push(candidate);
  }
  if (items.length < wanted) {
    throw new Error(`Need ${wanted} available existing items but found ${items.length}; adjust LIBRARY_ID`);
  }
  console.log(`Selected ${LIBRARIANS} existing patrons and ${LIBRARIANS} available items (plus a spare pair); staff branch ${staffBranch}`);

  const sparePatron = patrons.pop();
  const spareItem = items.pop();
  let holdBiblioId = HOLD_BIBLIO_ID ? parseInt(HOLD_BIBLIO_ID) : null;
  let trainerCheckout = null;
  const jsonParams = await apiParams("application/json");
  if (!holdBiblioId) {
    const checkoutsRes = http.get(`${API}/checkouts?_per_page=20`, params);
    if (checkoutsRes.status === 200) {
      for (const checkout of checkoutsRes.json()) {
        const itemRes = http.get(`${API}/items/${checkout.item_id}`, params);
        if (itemRes.status !== 200) continue;
        const biblioId = itemRes.json().biblio_id;
        const siblingsRes = http.get(`${API}/items?q=${jsonQ({ biblio_id: biblioId })}&_per_page=100`, params);
        if (siblingsRes.status !== 200) continue;
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
      console.log(`Hold target: bib ${spareItem.biblio_id} (checked ${spareItem.external_id} out to make it holdable)`);
    } else {
      console.warn(`Could not check out the hold-target item (${spareCheckoutRes.status}); place_hold may be blocked by policy`);
    }
    holdBiblioId = spareItem.biblio_id;
  }

  const preexistingHoldIds = [];
  for (const p of patrons) {
    const heldRes = http.get(`${API}/holds?q=${jsonQ({ patron_id: p.patron_id, biblio_id: holdBiblioId })}&_per_page=100`, params);
    if (heldRes.status === 200) {
      for (const hold of heldRes.json()) preexistingHoldIds.push(hold.hold_id);
    }
  }
  if (preexistingHoldIds.length) {
    console.warn(`${preexistingHoldIds.length} selected patrons already hold the target bib; their real holds will be preserved`);
  }

  return {
    token,
    // Resolved here because module-level caches do not carry from setup into
    // the per-VU context; the VU reads the password from data instead
    staffPass: cachedPassword,
    staffBranch,
    patrons,
    items,
    holdBiblioId,
    trainerCheckout,
    patronIds: patrons.map((p) => p.patron_id),
    preexistingHoldIds,
  };
}

// ------------------------------------------------------------
// LOCKSTEP SCHEDULING ( identical to the browser test )
// ------------------------------------------------------------
function waitForStep(stepIndex) {
  const base = exec.scenario.startTime + STARTUP_GRACE_S * 1000;
  let target;
  if (stepIndex === 0) {
    target = base + Math.random() * LOGIN_JITTER_S * 1000;
  } else {
    const jitter = Math.min(
      TYPING_STEPS.includes(STEPS[stepIndex]) ? TYPING_JITTER_S : STEP_JITTER_S,
      STEP_INTERVAL_S * 0.8,
    );
    target = base + (LOGIN_JITTER_S + stepIndex * STEP_INTERVAL_S) * 1000 + Math.random() * jitter * 1000;
  }
  const waitMs = target - Date.now();
  if (waitMs > 0) sleep(waitMs / 1000);
}

function runStep(name, fn) {
  waitForStep(STEPS.indexOf(name));
  if (exec.vu.idInTest === 1) {
    console.log(`--- tick ${STEPS.indexOf(name) + 1}/${STEPS.length}: ${name} ---`);
  }
  const started = Date.now();
  let ok = true;
  try {
    fn();
  } catch (error) {
    ok = false;
    console.error(`VU ${exec.vu.idInTest} step '${name}' failed: ${error && error.message ? error.message : String(error)}`);
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
export default function (data) {
  const vuNumber = exec.vu.idInTest;
  const patron = data.patrons[vuNumber - 1];
  const item = data.items[vuNumber - 1];
  const username = TRAINING_USER_PREFIX ? `${TRAINING_USER_PREFIX}${vuNumber}` : STAFF_USER;
  const password = TRAINING_USER_PREFIX ? TRAINING_USER_PASS : data.staffPass;
  const token = data.token;
  const pget = (url) => http.get(url, pageParams(token));
  const ppost = (url, body) => http.post(url, body, pageParams(token, "application/x-www-form-urlencoded"));
  // REST params for the verification calls, using the credentials resolved
  // in setup and carried through data
  const restParams = { headers: { Accept: "application/json", Authorization: `Basic ${b64encode(`${STAFF_USER}:${data.staffPass}`)}` } };
  if (STAFF_HOST_HEADER) restParams.headers["Host"] = STAFF_HOST_HEADER;
  if (token) restParams.headers[EXTERNAL_SERVICE_HEADER] = token;

  const loggedIn = runStep("login", () => {
    const form = pget(`${CGI}/mainpage.pl`);
    const csrf = csrfFrom(form.body);
    if (!csrf) throw new Error("No csrf_token on the login page");
    const res = ppost(`${CGI}/mainpage.pl`, {
      csrf_token: csrf,
      login_op: "cud-login",
      koha_login_context: "intranet",
      login_userid: username,
      login_password: password,
      branch: "",
    });
    if (res.status !== 200 || !res.body.includes("loggedinusername")) {
      throw new Error(`Login as ${username} not confirmed (${res.status})`);
    }
  });
  if (!loggedIn) return;

  runStep("patron_search", () => {
    const res = pget(`${CGI}/circ/circulation.pl?findborrower=${encodeURIComponent(patron.cardnumber)}`);
    if (res.status !== 200 || (!res.body.includes(patron.cardnumber) && !(patron.surname && res.body.includes(patron.surname)))) {
      throw new Error(`Patron search did not land on ${patron.cardnumber}`);
    }
  });

  runStep("checkout", () => {
    const page = pget(`${CGI}/circ/circulation.pl?borrowernumber=${patron.patron_id}`);
    const csrf = csrfFrom(page.body);
    if (!csrf) throw new Error("No csrf_token on the checkout page");
    const res = ppost(`${CGI}/circ/circulation.pl`, {
      csrf_token: csrf,
      op: "cud-checkout",
      restoreduedatespec: "",
      barcode: item.external_id,
      duedatespec: "",
      borrowernumber: String(patron.patron_id),
      branch: data.staffBranch,
      debt_confirmed: "0",
    });
    // Some items trigger a confirmation ( rental charge, patron debt, ... ) -
    // echo the confirm form's hidden fields and re-submit, like a librarian
    // clicking "Yes, check out"
    if (res.body.includes("needsconfirmation") || res.body.includes("Please confirm checkout")) {
      const fields = hiddenInputs(res.body);
      ppost(`${CGI}/circ/circulation.pl`, Object.assign(fields, {
        op: "cud-checkout",
        borrowernumber: String(patron.patron_id),
        barcode: item.external_id,
        branch: data.staffBranch,
        debt_confirmed: "1",
      }));
    }
    const chk = http.get(`${API}/checkouts?q=${jsonQ({ item_id: item.item_id })}`, restParams);
    if (chk.status !== 200 || chk.json().length === 0) {
      throw new Error(`Checkout of ${item.external_id} not confirmed`);
    }
  });

  runStep("checkin", () => {
    const page = pget(`${CGI}/circ/returns.pl`);
    const csrf = csrfFrom(page.body);
    if (!csrf) throw new Error("No csrf_token on the returns page");
    ppost(`${CGI}/circ/returns.pl`, {
      csrf_token: csrf,
      barcode: item.external_id,
      op: "cud-checkin",
    });
    const chk = http.get(`${API}/checkouts?q=${jsonQ({ item_id: item.item_id })}`, restParams);
    if (chk.status !== 200 || chk.json().length > 0) {
      throw new Error(`Checkin of ${item.external_id} not confirmed`);
    }
  });

  runStep("catalog_search", () => {
    const res = pget(`${CGI}/catalogue/search.pl?q=${encodeURIComponent(CATALOG_SEARCH_TERM)}`);
    // A multi-hit search renders the results list; a single hit redirects to
    // the detail page - both are successful searches. Zero hits is still a
    // valid search response.
    if (res.status !== 200 || !(res.body.includes("searchresults") || res.body.includes("No results") || res.body.includes("id=\"catalogue_detail_biblio\""))) {
      throw new Error(`Catalog search page did not load`);
    }
  });

  runStep("place_hold", () => {
    const page = pget(`${CGI}/reserve/request.pl?biblionumber=${data.holdBiblioId}&findborrower=${encodeURIComponent(patron.cardnumber)}`);
    const fields = hiddenInputs(page.body);
    if (!fields.csrf_token) throw new Error("No csrf_token on the hold page");
    const body = Object.assign({}, fields, {
      op: "cud-placerequest",
      borrowernumber: String(patron.patron_id),
      biblionumber: String(data.holdBiblioId),
      holdable_bibs: String(data.holdBiblioId),
      "rank-request": "1",
      notes: "",
      expiration_date: "",
      request: "Any",
      pickup: data.staffBranch,
      holds_to_place_count: "1",
    });
    ppost(`${CGI}/reserve/placerequest.pl`, body);
    const chk = http.get(`${API}/holds?q=${jsonQ({ patron_id: patron.patron_id, biblio_id: data.holdBiblioId })}&_per_page=100`, restParams);
    const mine = chk.status === 200 && chk.json().some((h) => !data.preexistingHoldIds.includes(h.hold_id));
    if (!mine) throw new Error("Hold not present on the bib after placing");
  });

  if (vuNumber === 1) {
    runStep("wrap_up", () => {
      // Cancel the class's holds ( ours only ) via REST, then check the
      // arranged hold-target item and any straggler back in via returns.pl
      for (const patronId of data.patronIds) {
        const heldRes = http.get(`${API}/holds?q=${jsonQ({ patron_id: patronId, biblio_id: data.holdBiblioId })}&_per_page=100`, restParams);
        if (heldRes.status !== 200) continue;
        for (const hold of heldRes.json()) {
          if (!data.preexistingHoldIds.includes(hold.hold_id)) {
            http.del(`${API}/holds/${hold.hold_id}`, null, restParams);
          }
        }
      }
      const returnBarcodes = [];
      if (data.trainerCheckout) returnBarcodes.push(data.trainerCheckout.external_id);
      for (const classItem of data.items) {
        const chk = http.get(`${API}/checkouts?q=${jsonQ({ item_id: classItem.item_id })}`, restParams);
        if (chk.status === 200 && chk.json().length > 0) returnBarcodes.push(classItem.external_id);
      }
      for (const barcode of returnBarcodes) {
        const page = pget(`${CGI}/circ/returns.pl`);
        const csrf = csrfFrom(page.body);
        ppost(`${CGI}/circ/returns.pl`, { csrf_token: csrf, barcode: barcode, op: "cud-checkin" });
      }
    });
  } else {
    waitForStep(STEPS.indexOf("wrap_up"));
  }

  runStep("logout", () => {
    pget(`${CGI}/staff/logout.pl`);
  });
  console.log(`VU ${vuNumber} finished the training session`);
}

// ------------------------------------------------------------
// TEARDOWN - put back checkouts and holds ( same as the browser test )
// ------------------------------------------------------------
export async function teardown(data) {
  console.log("Cleaning up training checkouts and holds...");
  const params = await apiParams();

  for (const patronId of data.patronIds) {
    const heldRes = http.get(`${API}/holds?q=${jsonQ({ patron_id: patronId, biblio_id: data.holdBiblioId })}&_per_page=100`, params);
    if (heldRes.status !== 200) continue;
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
    if (res.status === 200 && res.json().length > 0) lingering.push(item.external_id);
  }
  if (lingering.length) {
    console.warn(`Still checked out and needing a manual checkin: ${lingering.join(", ")}`);
  }

  console.log("========================================");
  console.log("TRAINING SESSION PROTOCOL TEST COMPLETE");
  console.log("========================================");
}

// ------------------------------------------------------------
// SUMMARY ( local runs only )
// ------------------------------------------------------------
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
    metadata: { testScript: "koha_training_protocol.js", testNumber: TEST_NUMBER, timestamp: new Date().toISOString() },
    config: {
      staffUrl: STAFF_URL,
      librarians: LIBRARIANS,
      stepIntervalS: STEP_INTERVAL_S,
      loginJitterS: LOGIN_JITTER_S,
      stepP95Ms: STEP_P95_MS,
      checksRate: CHECKS_RATE,
      catalogSearchTerm: CATALOG_SEARCH_TERM,
    },
    result: {
      totalIterations: m.iterations?.values?.count || 0,
      checksRate: m.checks?.values?.rate?.toFixed(4) || null,
      httpReqDuration_p95_ms: m.http_req_duration?.values?.["p(95)"]?.toFixed(2) || null,
      httpReqFailed_rate: m.http_req_failed?.values?.rate?.toFixed(4) || null,
      steps,
    },
  };
  const now = new Date();
  const outputDir = __ENV.OUTPUT_DIR || "/output";
  const path = OUTPUT_FILE || `${outputDir}/koha-training-protocol-${TEST_NUMBER}-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${now.toISOString().slice(11, 16).replace(/:/g, "")}.json`;
  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + `\n  Output: ${path}\n`,
    [path]: JSON.stringify(summary, null, 2),
  };
}
