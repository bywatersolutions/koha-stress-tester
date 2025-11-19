import http from "k6/http";
import exec from 'k6/execution';
import { browser } from "k6/browser";
import { sleep, fail, check } from 'k6';
import { expect } from "https://jslib.k6.io/k6-testing/0.5.0/index.js";

// Read all words from the file
const words = open('./words_alpha.txt').split('\n');

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
// Split the BASE URL into protocol and host parts
const STAFF_URL = __ENV.STAFF_URL || 'http://kohadev-intra.localhost';
const OPAC_URL = __ENV.OPAC_URL || 'http://kohadev.localhost';
const [STAFF_PROTOCOL, STAFF_HOST] = STAFF_URL.split('://');
const STAFF_BASE_URL = `${STAFF_PROTOCOL}://${STAFF_HOST}`; // Reconstruct to ensure proper format

const STAFF_USER = __ENV.STAFF_USER || 'koha';
const STAFF_PASS = __ENV.STAFF_PASS || 'koha';

const BASIC_AUTH_CREDENTIALS = `${STAFF_USER}:${STAFF_PASS}`;

console.log("URL: ", STAFF_BASE_URL);
console.log("User: ", STAFF_USER);

const API = `${STAFF_PROTOCOL}://${BASIC_AUTH_CREDENTIALS}@${STAFF_HOST}/api/v1`;

// ------------------------------------------------------------
// TEST CONFIG
// ------------------------------------------------------------
export const options = {
    scenarios: {
        ui: {
            executor: "shared-iterations",
            vus: 10,
            iterations: 10,
            options: {
                browser: {
                    type: "chromium",
                    headless: true,
                },
            },
        },
    },
    thresholds: {
        checks: ['rate==1.0'],
    },
};

// ------------------------------------------------------------
// SETUP — LOAD REAL BORROWERS + ITEMS FROM KOHA REST API
// ------------------------------------------------------------
export function setup() {

    const params = {
        headers: {
            "Accept": "application/json"
        }
    };

    // Fetch borrowers
    const borrowersRes = http.get(`${API}/patrons?_per_page=500`, params);
    check(borrowersRes, {
        'status is 200': (r) => r.status === 200
    });
    const borrowers = borrowersRes.json();

    // Fetch items
    const itemsRes = http.get(`${API}/items?_per_page=500`, params);
    check(itemsRes, {
        'status is 200': (r) => r.status === 200
    });
    const items = itemsRes.json();

    console.log(`Loaded ${borrowers.length} borrowers`);
    console.log(`Loaded ${items.length} items`);

    return { borrowers, items };
}

// Random picker for arrays
function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

async function login(username, password, page) {
    try {
        page = page || await browser.newPage();

        const username = STAFF_USER;
        const password = STAFF_PASS;
        const mainUrl = `${STAFF_URL}/cgi-bin/koha/mainpage.pl`;

        // Go to main page
        await page.goto(mainUrl, { waitUntil: 'networkidle' });

        // Click #locallogin_button if it exists
        const localLoginBtn = page.locator('#locallogin_button');
        if (await localLoginBtn.count() > 0) {
            console.log('Local login button found, clicking to show login form...');
            await localLoginBtn.click();
        }

        // Wait for login inputs to appear
        const userInput = page.locator('input[name="login_userid"]');
        const passInput = page.locator('input[name="login_password"]');

        // Type credentials
        await userInput.type(username);
        await passInput.type(password);

        // Submit the form
        const submitBtn = page.locator('#submit-button');

        await Promise.all([page.waitForNavigation(), submitBtn.click({ force: true })]);

        // Screenshot for verification
        await page.screenshot({ path: 'screenshot.png' });

        // Check for the logged in username to verify login success
        const userSpan = page.locator('span.loggedinusername:nth-child(1)');
        await expect.soft(userSpan).toHaveText(username);

        console.log('Login successful!');
        return page;
    } catch (error) {
        console.error("Login failed:", error.message);
        if (page) {
            await page.screenshot({ path: "login_error.png" });
            const html = await page.content();
            console.error("Page content:", html.substring(0, 1000)); // Log first 1000 chars of HTML
        }
        throw error; // Re-throw to fail the test
    }
}

async function logout(page) {
    await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/staff/logout.pl`);
    await page.waitForSelector("body");
}

async function checkout(page, borrower, item) {
    const borrowernumber = borrower.patron_id;
    const cardnumber = borrower.cardnumber;
    const barcode = item.external_id;
    console.log(`Check out ${barcode} to ${cardnumber} (${borrowernumber})`);

    const url_circulation = `${STAFF_BASE_URL}/cgi-bin/koha/circ/circulation.pl?borrowernumber=${borrowernumber}`;
    console.log(`Go to ${url_circulation}`);
    await page.goto(url_circulation);
    await page.waitForNavigation();

    // If the account is restricted, override it
    const overrideLink = page.locator('a', { hasText: 'Override restriction temporarily' });
    if (await overrideLink.count() > 0) {
        console.log('Found "Override restriction temporarily" link, clicking it...');
        await Promise.all([overrideLink.click(), page.waitForNavigation()]);
    }

    const yesCheckOutBtn = page.locator('a', { hasText: 'Yes, check out' });
    if (await yesCheckOutBtn.count() > 0) {
        console.log('Found "Force checkout" button, clicking it...');
        await Promise.all([yesCheckOutBtn.click(), page.waitForNavigation()]);
    }
    await page.waitForSelector("label.circ_barcode");
    const checkingOutTo = await page.locator("label.circ_barcode").first().textContent();
    check(checkingOutTo, {
        'checkout user matches': (checkingOutTo) => checkingOutTo.includes(cardnumber)
    });

    await page.locator('#circ_circulation_issue input[name="barcode"]').type(barcode);

    const submitButton = page.locator('#circ_circulation_issue button[type="submit"]');
    await Promise.all([submitButton.click(), page.waitForNavigation()]);

    try {
        const checkedOut = await page.locator(".lastchecked p").first().textContent();
        check(checkedOut, {
            'checked out item matches': (checkedOut) => checkedOut.includes(barcode)
        });
    } catch (error) {
        console.error("Failed to check out item:", error);
        await page.screenshot({ path: `checkout_failure_${barcode}_${cardnumber}.png` });
    }
}

async function checkin(page, item) {
    const barcode = item.external_id;
    console.log(`Check in ${barcode}`)

    const url_circulation = `${STAFF_BASE_URL}/cgi-bin/koha/circ/returns.pl`;
    console.log(`Go to ${url_circulation}`);
    await page.goto(url_circulation);

    await page.waitForSelector("body");

    console.log("Type barcode");
    await page.locator('#barcode').type(barcode);

    console.log("Click submit");
    const submitButton = page.locator('#circ_returns_checkin button[type="submit"]');
    await Promise.all([submitButton.click(), page.waitForNavigation()]);

    await page.waitForSelector("body");

    //TODO: Check that the item is checked in, deal with messages
    //console.log("Get checked in table");
    //const checkedIn = await page.locator("#checkedintable").first().textContent();
    //check(checkedIn, {
    //    'checked out item matches': (checkedIn) => checkedIn.includes(barcode) 
    //});
}

async function search_opac(term, page) {
    console.log(`Searching OPAC for ${term}`);
    page = page || await browser.newPage();

    console.log(`Go to ${OPAC_URL}`);
    await page.goto(OPAC_URL);

    console.log("Type barcode");
    await page.locator('input[name="q"]').type(term);

    console.log("Click submit");
    const submitButton = page.locator('#searchsubmit');
    await Promise.all([submitButton.click(), page.waitForNavigation()]);

    await page.waitForSelector("body");
    const results = await page.locator("#numresults").textContent();
    console.log("Results: ", results);
    check(results, {
        'results are not empty': (results) => results !== ""
    });
}

export default async function (data) {

    const borrowers = data.borrowers;
    const items = data.items;

    console.log("LOGGING IN");
    const page = await login(STAFF_USER, STAFF_PASS);
    console.log("LOGGED IN");

    try {
        let borrower = pick(borrowers);
        while (borrower.cardnumber === null) {
            borrower = pick(borrowers);
        }
        console.log("BORROWER CARDNUMBER: ", borrower.cardnumber);
        let item = pick(items);
        while (item.external_id === null) {
            item = pick(items);
        }
        console.log("ITEM EXTERNAL ID: ", item.external_id);

        // Check in item, check out item, check it back in
        await checkin(page, item);
        await checkout(page, borrower, item);
        await checkin(page, item);

        // Search OPAC
        const searchTerm = pick(words);
        console.log("Using search term:", searchTerm);
        await search_opac(searchTerm, page);
    } finally {
        await logout(page);
    }
}

