/**
 * koha.js - Koha ILS Browser Test
 * 
 * Requirements:
 * - k6 binary with browser support (not Docker)
 * - Chromium installed on your system
 * 
 * WARNING: Each VU spawns its own browser window. Running with VUS=10 will
 * open 10 browsers simultaneously. Keep VUS low, especially in visible mode.
 */
import http from "k6/http";
import { browser } from "k6/browser";
import { sleep, check } from "k6";
import { expect } from "https://jslib.k6.io/k6-testing/0.5.0/index.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { randomElement, randomString, generateUUID } from "./lib/utils.js";
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

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const STAFF_URL = __ENV.STAFF_URL || "http://kohadev-intra.localhost";
const OPAC_URL = __ENV.OPAC_URL || "http://kohadev.localhost";
const [STAFF_PROTOCOL, STAFF_HOST] = STAFF_URL.split("://");
const STAFF_BASE_URL = `${STAFF_PROTOCOL}://${STAFF_HOST}`;
const STAFF_USER = __ENV.STAFF_USER || "koha";
const STAFF_PASS = __ENV.STAFF_PASS || "koha";
const BASIC_AUTH_CREDENTIALS = `${STAFF_USER}:${STAFF_PASS}`;

const VUS = parseInt(__ENV.VUS) || 1;
const ITERATIONS = parseInt(__ENV.ITERATIONS) || 1;
const OUTPUT_FILE = __ENV.OUTPUT_FILE || "";
const TEST_NUMBER = __ENV.TEST_NUMBER || "001";

const API = `${STAFF_PROTOCOL}://${BASIC_AUTH_CREDENTIALS}@${STAFF_HOST}/api/v1`;

const words = open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim());

export const options = {
  scenarios: {
    ui: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: ITERATIONS,
      gracefulStop: "10s",  // Allow browser sessions to complete cleanly
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
// SETUP — LOAD REAL BORROWERS + ITEMS FROM KOHA REST API
// ------------------------------------------------------------
export function setup() {
  console.log("========================================");
  console.log("KOHA BROWSER BENCHMARK TEST");
  console.log("========================================");
  console.log(`STAFF_URL: ${STAFF_URL}`);
  console.log(`OPAC_URL: ${OPAC_URL}`);
  console.log(`STAFF_USER: ${STAFF_USER}`);
  console.log(`VUS: ${VUS}`);
  console.log(`ITERATIONS: ${ITERATIONS}`);
  console.log(`K6_BROWSER_HEADLESS: ${__ENV.K6_BROWSER_HEADLESS || "true (default)"}`);
  console.log("========================================");

  const params = {
    headers: {
      Accept: "application/json",
    },
  };

  const patronCategoriesRes = http.get(
    `${API}/patron_categories?_per_page=500`,
    params,
  );
  check(patronCategoriesRes, {
    "Loaded patron categories": (r) => r.status === 200,
  });
  const patronCategories = patronCategoriesRes.json();
  console.log(`Loaded ${patronCategories.length} patron categories`);

  const librariesRes = http.get(`${API}/libraries?_per_page=500`, params);
  check(librariesRes, {
    "Loaded libraries": (r) => r.status === 200,
  });
  const libraries = librariesRes.json();
  console.log(`Loaded ${libraries.length} libraries`);

  const itemTypesRes = http.get(`${API}/item_types?_per_page=500`, params);
  check(itemTypesRes, {
    "Loaded item types": (r) => r.status === 200,
  });
  const itemTypes = itemTypesRes.json();
  console.log(`Loaded ${itemTypes.length} item_types`);

  return { patronCategories, libraries, itemTypes };
}

export function teardown() {
  console.log("\n========================================");
  console.log("TEST COMPLETE");
  console.log("========================================");
}

export default async function (data) {
  console.log("Logging in to Koha");
  const page = await login(STAFF_USER, STAFF_PASS);
  console.log("Logged in to Koha");

  try {
    await sleep(Math.random() * 10);
    const patron = await createStubKohaPatron(data);
    await sleep(Math.random() * 10);
    const biblio = await createStubKohaBiblio(data);
    await sleep(Math.random() * 10);
    const item = await createStubKohaItem(data, biblio.id);

    await sleep(Math.random() * 3);
    await checkin(page, item);
    await sleep(Math.random() * 3);
    await checkout(page, patron, item);
    await sleep(Math.random() * 3);
    await checkin(page, item);

    const searchTerm = randomElement(words);
    console.log("Using search term:", searchTerm);
    await search_opac(searchTerm, page);

    await deleteKohaItem(item.item_id);
    await deleteKohaBiblio(biblio.id);
    await deleteKohaPatron(patron.patron_id);
  } catch (error) {
    console.error("ERROR! ERROR! ERROR!", error.message);
    if (page) {
      await page.screenshot({ path: "test_error.png" });
    }
    throw error;
  } finally {
    await logout(page);
  }

  console.log("DONE");
}

async function login(username, password, page) {
  try {
    page = page || (await browser.newPage());
    const mainUrl = `${STAFF_URL}/cgi-bin/koha/mainpage.pl`;

    await page.goto(mainUrl, { waitUntil: "networkidle" });

    const localLoginBtn = page.locator("#locallogin_button");
    if ((await localLoginBtn.count()) > 0) {
      console.log("Local login button found, clicking to show login form...");
      await localLoginBtn.click();
    }

    const userInput = page.locator('input[name="login_userid"]');
    const passInput = page.locator('input[name="login_password"]');

    await userInput.type(username);
    await passInput.type(password);

    const submitBtn = page.locator("#submit-button");

    await Promise.all([
      page.waitForNavigation(),
      submitBtn.click({ force: true }),
    ]);

    const userSpan = page.locator("span.loggedinusername:nth-child(1)");
    await expect.soft(userSpan).toHaveText(username);

    console.log("Login successful!");
    return page;
  } catch (error) {
    console.error("Login failed:", error.message);
    if (page) {
      await page.screenshot({ path: "login_error.png" });
    }
    throw error;
  }
}

async function logout(page) {
  await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/mainpage.pl?logout.x=1`);
  await page.waitForSelector("body");
}

async function checkout(page, patron, item) {
  const patron_id = patron.patron_id;
  const cardnumber = patron.cardnumber;
  const barcode = item.external_id;
  console.log(`Check out ${barcode} to ${cardnumber} (${patron_id})`);

  const url_circulation = `${STAFF_BASE_URL}/cgi-bin/koha/circ/circulation.pl?borrowernumber=${patron_id}`;
  console.log(`Go to ${url_circulation}`);
  try {
    await page.goto(url_circulation, { waitUntil: "domcontentloaded" });
  } catch (error) {
    console.error(
      `Failed to go to ${url_circulation}:`,
      error,
      "PATRON: ",
      patron,
    );
    await page.screenshot({ path: `failed_goto_circulation_${patron_id}.png` });
  }

  const overrideLink = page.locator("a", {
    hasText: "Override restriction temporarily",
  });
  if ((await overrideLink.count()) > 0) {
    console.log(
      'Found "Override restriction temporarily" link, clicking it...',
    );
    await Promise.all([overrideLink.click(), page.waitForNavigation()]);
  }

  const yesCheckOutBtn = page.locator("a", { hasText: "Yes, check out" });
  if ((await yesCheckOutBtn.count()) > 0) {
    console.log('Found "Force checkout" button, clicking it...');
    await Promise.all([yesCheckOutBtn.click(), page.waitForNavigation()]);
  }

  try {
    const checkingOutTo = await page
      .locator("label.circ_barcode")
      .first()
      .textContent();
    check(checkingOutTo, {
      "checkout user matches": (checkingOutTo) =>
        checkingOutTo.includes(cardnumber),
    });
  } catch (error) {
    console.error("Failed to find checkout to patron:", error);
    await page.screenshot({
      path: `checkout_failure_to_${barcode}_${cardnumber}.png`,
    });
  }

  await page
    .locator('#circ_circulation_issue input[name="barcode"]')
    .type(barcode);

  const submitButton = page.locator(
    '#circ_circulation_issue button[type="submit"]',
  );
  await Promise.all([submitButton.click(), page.waitForNavigation()]);

  try {
    const checkedOut = await page
      .locator(".lastchecked p")
      .first()
      .textContent();
    check(checkedOut, {
      "checked out item matches": (checkedOut) => checkedOut.includes(barcode),
    });
  } catch (error) {
    console.error("Failed to check out item:", error);
    await page.screenshot({
      path: `checkout_failure_${barcode}_${cardnumber}.png`,
    });
  }
}

async function checkin(page, item) {
  const barcode = item.external_id;
  console.log(`Check in ${barcode}`);

  const url_circulation = `${STAFF_BASE_URL}/cgi-bin/koha/circ/returns.pl`;
  console.log(`Go to ${url_circulation}`);
  try {
    await page.goto(url_circulation, { waitUntil: "domcontentloaded" });
  } catch (error) {
    console.error(`Failed to go to ${url_circulation}:`, error);
    await page.screenshot({ path: `failed_goto_returns_${barcode}.png` });
  }

  await page.waitForSelector("body");

  console.log("Type barcode ${barcode}");
  await page.locator("#barcode").type(barcode);

  console.log("Click submit");
  const submitButton = page.locator(
    '#circ_returns_checkin button[type="submit"]',
  );
  await Promise.all([submitButton.click(), page.waitForNavigation()]);

  await page.waitForSelector("body");
}

async function search_opac(term, page) {
  console.log(`Searching OPAC for ${term}`);
  page = page || (await browser.newPage());

  console.log(`Go to ${OPAC_URL}`);
  await page.goto(OPAC_URL);

  console.log("Type search term");
  await page.locator('input[name="q"]').type(term);

  console.log("Click submit");
  const submitButton = page.locator("#searchsubmit");
  await Promise.all([submitButton.click(), page.waitForNavigation()]);

  await page.waitForSelector("body");
  try {
    const results = await page.locator("#numresults").textContent();
    console.log("Results: ", results);
    check(results, {
      "Has search results": (results) => results !== "",
    });
  } catch (error) {
    console.error(`Failed to get results for search term ${term}:`, error);
    await page.screenshot({ path: `failed_opac_search_${term}.png` });
  }
}

async function createStubKohaItem(data, biblioId) {
  const externalId = randomString(20);
  const itemTypeId = data.itemTypes[0].item_type_id;
  const homeLibraryId = data.libraries[1].library_id;
  const holdingLibraryId = data.libraries[1].library_id;

  const item = {
    external_id: externalId,
    item_type_id: itemTypeId,
    home_library_id: homeLibraryId,
    holding_library_id: holdingLibraryId,
    callnumber: "KohaStressTest",
  };

  console.log("Creating item: ", item);

  let loops = 0;
  let itemId;
  while (!itemId) {
    itemId = await createKohaItem(biblioId, item);
    sleep(loops);
    loops++;
    if (loops > 10) {
      throw new Error("Failed to create item");
    }
  }
  console.log("Created item: ", itemId);

  return itemId;
}

async function createKohaItem(biblioId, itemData) {
  const url = `${API}/biblios/${biblioId}/items`;
  const payload = JSON.stringify(itemData);
  const headers = {
    "Content-Type": "application/json",
  };
  const res = http.post(url, payload, { headers: headers });
  const itemId = res.json();
  check(res, {
    "Item created": (r) => r.status === 201,
    "Response body contains new item data": (r) => itemId.item_id !== undefined,
  });

  return itemId;
}

async function deleteKohaItem(itemId) {
  const url = `${API}/items/${itemId}`;
  const res = http.del(url);
  check(res, {
    "Item deleted": (r) => r.status === 204,
  });
  console.log("Deleted item: ", itemId);
}

async function deleteKohaBiblio(biblioId) {
  const url = `${API}/biblios/${biblioId}`;
  const res = http.del(url);
  check(res, {
    "Biblio deleted": (r) => r.status === 204,
  });
  console.log("Deleted biblio: ", biblioId);
}

async function createStubKohaBiblio() {
  const biblioData = {
    leader: "00000nam a2200000 i 4500",
    fields: [
      { "001": "KohaStressTest" },
      { "005": "20250101000000.0" },
      { "008": "250120s2025    xx            000 0 eng d" },
      {
        100: {
          ind1: "1",
          ind2: " ",
          subfields: [{ a: "Hall, Kyle" }],
        },
      },
      {
        245: {
          ind1: "1",
          ind2: "0",
          subfields: [
            { a: `${randomElement(words)} ${randomElement(words)}` },
            { b: "A Load Testing Example for Koha" },
          ],
        },
      },
      {
        260: {
          ind1: " ",
          ind2: " ",
          subfields: [{ a: "USA" }, { b: "Load Testing Press" }, { c: "2025" }],
        },
      },
    ],
  };

  let biblio;
  let loops = 0;
  while (!biblio) {
    biblio = await createKohaBiblio(biblioData);
    sleep(loops);
    loops++;
    if (loops > 10) {
      throw new Error("Failed to create biblio");
    }
  }
  console.log("Created biblio: ", biblio.id, biblio);
  return biblio;
}

async function createKohaBiblio(record) {
  const url = `${API}/biblios`;
  const payload = JSON.stringify(record);
  const headers = {
    "Content-Type": "application/marc-in-json",
  };
  const res = http.post(url, payload, { headers: headers });
  check(res, {
    "Biblio created": (r) => r.status === 200,
    "Response body contains new biblio data": (r) => r.json("id") !== undefined,
  });
  console.log("Created biblio: ", res.json());

  return res.json();
}

async function createStubKohaPatron(data) {
  const patron_category_id = data.patronCategories[0].patron_category_id;
  const library_id = data.libraries[1].library_id;

  const patronData = {
    firstname: randomElement(words),
    surname: randomElement(words),
    cardnumber: generateUUID(),
    library_id: library_id,
    category_id: patron_category_id,
    date_of_birth: "1990-01-01",
    statistics_1: "KohaStressTest",
  };

  let patron;
  let loops = 0;
  while (!patron) {
    patron = await createKohaPatron(patronData);
    sleep(loops);
    loops++;
    if (loops > 10) {
      throw new Error("Failed to create patron");
    }
  }
  console.log("Created patron: ", patron.patron_id, patron);
  return patron;
}

async function createKohaPatron(patronData) {
  console.log("createKohaPatron", patronData);

  const url = `${API}/patrons`;

  const headers = {
    "Content-Type": "application/json",
  };

  const payload = JSON.stringify(patronData);

  const res = http.post(url, payload, { headers: headers });

  check(res, {
    "Patron created": (r) => r.status === 201,
    "Response body contains new patron data": (r) =>
      r.json("patron_id") !== undefined,
  });
  if (res.status !== 201 || res.json("patron_id") === undefined) {
    console.error(
      "ERROR: Failed to create patron: ",
      res.status,
      res.body,
      payload,
    );
  }

  const patron = res.json();
  console.log("Created stub patron", patron.patron_id);

  return patron;
}

async function deleteKohaPatron(patronId) {
  const url = `${API}/patrons/${patronId}`;

  const res = await http.del(url);

  check(res, {
    "Patron deleted": (r) => r.status === 204,
  });

  console.log("Deleted patron:", patronId);
  return res.status === 204;
}

export function handleSummary(data) {
  const m = data.metrics;

  const summary = {
    metadata: {
      testScript: "koha.js",
      testNumber: TEST_NUMBER,
      timestamp: new Date().toISOString(),
    },
    config: {
      staffUrl: STAFF_URL,
      opacUrl: OPAC_URL,
      staffUser: STAFF_USER,
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

  const outputPath = OUTPUT_FILE || reporting.generateOutputPath("koha", TEST_NUMBER);

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }) + `\n  Output: ${outputPath}\n`,
    [outputPath]: JSON.stringify(summary, null, 2),
  };
}
