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
// Split the BASE URL into protocol and host parts
const STAFF_URL = __ENV.STAFF_URL || "http://kohadev-intra.localhost";
const OPAC_URL = __ENV.OPAC_URL || "http://kohadev.localhost";
const [STAFF_PROTOCOL, STAFF_HOST] = STAFF_URL.split("://");
const STAFF_BASE_URL = `${STAFF_PROTOCOL}://${STAFF_HOST}`; // Reconstruct to ensure proper format

const STAFF_USER = __ENV.STAFF_USER || "koha";
const STAFF_PASS = __ENV.STAFF_PASS || "koha";

const BASIC_AUTH_CREDENTIALS = `${STAFF_USER}:${STAFF_PASS}`;

console.log("Staff URL: ", STAFF_BASE_URL);
console.log("Staff User: ", STAFF_USER);
console.log("Opac URL: ", OPAC_URL);

const API = `${STAFF_PROTOCOL}://${BASIC_AUTH_CREDENTIALS}@${STAFF_HOST}/api/v1`;

// Read all words from the file
const words = open("./words_alpha.txt").split("\n");

// ------------------------------------------------------------
// SETUP — LOAD REAL BORROWERS + ITEMS FROM KOHA REST API
// ------------------------------------------------------------
/**
 * Setup function that runs once before the test execution
 * Loads test data from the Koha REST API
 * @returns {Object} Object containing test data (borrowers, items, etc.)
 */
export function setup() {
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

export function teardown(data) {}

/**
 * Main test function that runs for each VU (Virtual User)
 * @param {Object} data - Test data loaded in the setup function
 * @returns {Promise<void>}
 */
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

    // Check in item, check out item, check it back in
    await sleep(Math.random() * 3);
    await checkin(page, item);
    await sleep(Math.random() * 3);
    await checkout(page, patron, item);
    await sleep(Math.random() * 3);
    await checkin(page, item);

    // Search OPAC
    const searchTerm = rando(words);
    console.log("Using search term:", searchTerm);
    await search_opac(searchTerm, page);

    await deleteKohaItem(item.item_id);
    await deleteKohaBiblio(biblio.id);
    await deleteKohaPatron(patron.patron_id);
  } catch (error) {
    console.error("ERROR! ERROR! ERROR!", error.message);
    if (page) {
      await page.screenshot({ path: "test_error.png" });
      //const html = await page.content();
      //console.error("Page content:", html);
    }
    throw error; // Re-throw to fail the test
  } finally {
    await logout(page);
  }

  console.log("DONE");
}

/**
 * Randomly selects an element from an array
 * @param {Array} arr - The array to pick an element from
 * @returns {*} A random element from the input array
 */
function rando(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Logs into the Koha staff interface
 * @param {string} username - The username for authentication
 * @param {string} password - The password for authentication
 * @param {Object} [page] - Optional existing page object to use
 * @returns {Promise<Object>} The authenticated page object
 * @throws {Error} If login fails
 */
async function login(username, password, page) {
  try {
    page = page || (await browser.newPage());

    const mainUrl = `${STAFF_URL}/cgi-bin/koha/mainpage.pl`;

    // Go to main page
    await page.goto(mainUrl, { waitUntil: "networkidle" });

    // Click #locallogin_button if it exists
    const localLoginBtn = page.locator("#locallogin_button");
    if ((await localLoginBtn.count()) > 0) {
      console.log("Local login button found, clicking to show login form...");
      await localLoginBtn.click();
    }

    // Wait for login inputs to appear
    const userInput = page.locator('input[name="login_userid"]');
    const passInput = page.locator('input[name="login_password"]');

    // Type credentials
    await userInput.type(username);
    await passInput.type(password);

    // Submit the form
    const submitBtn = page.locator("#submit-button");

    await Promise.all([
      page.waitForNavigation(),
      submitBtn.click({ force: true }),
    ]);

    // Check for the logged in username to verify login success
    const userSpan = page.locator("span.loggedinusername:nth-child(1)");
    await expect.soft(userSpan).toHaveText(username);

    console.log("Login successful!");
    return page;
  } catch (error) {
    console.error("Login failed:", error.message);
    if (page) {
      await page.screenshot({ path: "login_error.png" });
      //const html = await page.content();
      //console.error("Page content:", html.substring(0, 1000)); // Log first 1000 chars of HTML
    }
    throw error; // Re-throw to fail the test
  }
}

/**
 * Logs out of the Koha staff interface
 * @param {Object} page - The page object to log out from
 * @returns {Promise<void>}
 */
async function logout(page) {
  await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/staff/logout.pl`);
  await page.waitForSelector("body");
}

/**
 * Performs a checkout operation in Koha
 * @param {Object} page - The page object to perform the checkout on
 * @param {Object} patron - The borrower object containing patron information
 * @param {string} patron.patron_id - The patron ID
 * @param {string} patron.cardnumber - The patron's card number
 * @param {Object} item - The item to check out
 * @param {string} item.external_id - The item's barcode
 * @returns {Promise<void>}
 */
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

  // If the account is restricted, override it
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

/**
 * Performs a checkin operation in Koha
 * @param {Object} page - The page object to perform the checkin on
 * @param {Object} item - The item to check in
 * @param {string} item.external_id - The item's barcode
 * @returns {Promise<void>}
 */
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

  //TODO: Check that the item is checked in, deal with messages
  //console.log("Get checked in table");
  //const checkedIn = await page.locator("#checkedintable").first().textContent();
  //check(checkedIn, {
  //    'checked out item matches': (checkedIn) => checkedIn.includes(barcode)
  //});
}

/**
 * Searches the OPAC for a given term
 * @param {string} term - The search term to look up
 * @param {Object} [page] - Optional existing page object to use
 * @returns {Promise<void>}
 */
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

/**
 * Creates a stub Koha item with random data
 * @param {Object} data - Data object from setup
 * @param {number} biblioId - The biblio ID to associate the item with
 * @returns {Object} The created item data
 */
async function createStubKohaItem(data, biblioId) {
  const externalId = randomBarcode();
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

/**
 * Creates a new Koha item via the API
 * @param {number} biblioId - The biblio ID to associate the item with
 * @param {Object} itemData - The item data to create
 * @returns {Object} The created item data
 */
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

/**
 * Deletes a Koha item via the API
 * @param {number} itemId - The ID of the item to delete
 * @returns {void}
 */
async function deleteKohaItem(itemId) {
  const url = `${API}/items/${itemId}`;
  const res = http.del(url);
  check(res, {
    "Item deleted": (r) => r.status === 204,
  });
  console.log("Deleted item: ", itemId);
}

/**
 * Deletes a Koha biblio record via the API
 * @param {number} biblioId - The ID of the biblio record to delete
 * @returns {void}
 */
async function deleteKohaBiblio(biblioId) {
  const url = `${API}/biblios/${biblioId}`;
  const res = http.del(url);
  check(res, {
    "Bilio deleted": (r) => r.status === 204,
  });
  console.log("Deleted biblio: ", biblioId);
}

/**
 * Creates a stub Koha biblio record with random data
 * @param {Object} data - Data object from setup
 * @returns {Object} The created biblio record
 */
async function createStubKohaBiblio(data) {
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
            { a: `${rando(words)} ${rando(words)}` },
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
/**
 * Creates a new Koha biblio record via the API
 * @param {Object} record - The MARC record data in MARC-in-JSON format
 * @returns {Object} The created biblio record
 */
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

  let biblio = res.json();

  return biblio;
}

/**
 * Creates a stub Koha patron with random data
 * @param {Object} data - Data object containing patron categories and libraries
 * @param {Array<Object>} data.patronCategories - List of patron categories
 * @param {Array<Object>} data.libraries - List of libraries
 * @returns {Object} The created patron data
 */
async function createStubKohaPatron(data) {
  const patron_category_id = data.patronCategories[0].patron_category_id;
  const library_id = data.libraries[1].library_id;

  const patronData = {
    firstname: rando(words),
    surname: rando(words),
    cardnumber: randomCardnumber(),
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

/**
 * Creates a new Koha patron via the API
 * @param {Object} patronData - The patron data to create
 * @param {string} patronData.cardnumber - The patron's card number
 * @param {number} patronData.category_id - The patron category ID
 * @param {string} patronData.branchcode - The patron's home library code
 * @param {string} patronData.surname - The patron's surname
 * @param {string} patronData.firstname - The patron's first name
 * @param {string} patronData.dateofbirth - The patron's date of birth (YYYY-MM-DD)
 * @returns {Object} The created patron data
 */
async function createKohaPatron(patronData) {
  console.log("createKohaPatron", patronData);

  const url = `${API}/patrons`;

  const headers = {
    "Content-Type": "application/json",
  };

  const payload = JSON.stringify(patronData);

  // Send the POST request
  const res = http.post(url, payload, { headers: headers });

  // Basic checks within the function (or leave them in the default function)
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

/**
 * Deletes a Koha patron via the API
 * @param {number} patronId - The ID of the patron to delete
 * @returns {void}
 */
async function deleteKohaPatron(patronId) {
  const url = `${API}/patrons/${patronId}`;

  const res = await http.del(url); // 'null' for the body as DELETE requests usually don't send one

  check(res, {
    "Patron deleted": (r) => r.status === 204,
  });

  console.log("Deleted patron:", patronId);
  return res.status === 204;
}

/**
 * Generates a random barcode
 * @returns {string} A random barcode string
 */
function randomBarcode() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 20; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Generates a patron card number
 * @returns {string} A random card number
 */
function randomCardnumber() {
  // 48-bit timestamp (milliseconds since epoch)
  const timestamp = BigInt(Date.now());
  let ts = timestamp.toString(16).padStart(12, "0"); // 12 hex chars = 48 bits

  // Generate 16 random bytes (32 hex chars)
  let randomHex = "";
  for (let i = 0; i < 16; i++) {
    randomHex += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }

  // Insert version 7 (replace high nibble of byte 7)
  const versionNibble = "7";
  randomHex =
    randomHex.substring(0, 12) + // up to byte 6
    versionNibble + // version 7 nibble
    randomHex.substring(13); // rest

  // Combine timestamp + 16 random bytes → 32 hex chars
  const full = ts + randomHex.substring(0, 20); // 12 + 20 = 32 chars

  return full;
}
