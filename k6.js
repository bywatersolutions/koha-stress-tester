import { browser } from "k6/browser";
import { sleep, check } from 'k6';
import http from 'k6/http';

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
        browser: {
            executor: 'shared-iterations',
            options: {
                browser: {
                    type: 'chromium',
                },
            },
        },
    },
    vus: 5
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

// Random picker
function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

async function login(username, password, page) {
    try {
        page = page || await browser.newPage();
        
        // Set default timeout to 15 seconds
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(15000);

        console.log("Navigating to login page...");
        const url_mainpage = `${STAFF_BASE_URL}/cgi-bin/koha/mainpage.pl`;
        console.log(`Go to ${url_mainpage}`);
        await page.goto(url_mainpage);
        console.log("Filling login form...");
        await page.locator('input[name="login_userid"]').type(username);
        await page.locator('input[name="login_password"]').type(password);
        console.log("Submitting login form...");
        const submitButton = page.locator('input[type="submit"]');
        await Promise.all([submitButton.click(), page.waitForNavigation()]); 

        console.log("Verifying login...");
        const loggedInUsername = await page.locator("span.loggedinusername").first().textContent();
        console.log("Logged in as: ", loggedInUsername);
        check(loggedInUsername, {
            'logged in user matches': (verified) => verified === username
        });

        console.log("Login successful");
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

    const checkingOutTo = await page.locator("label.circ_barcode").first().textContent();
    check(checkingOutTo, {
        'checkout user matches': (checkingOutTo) => checkingOutTo.includes(cardnumber) 
    });

    await page.locator('#circ_circulation_issue input[name="barcode"]').type(barcode);

    const submitButton = page.locator('#circ_circulation_issue button[type="submit"]');
    await Promise.all([submitButton.click(), page.waitForNavigation()]); 

    const checkedOut = await page.locator(".lastchecked p").first().textContent();
    check(checkedOut, {
        'checked out item matches': (checkedOut) => checkedOut.includes(barcode) 
    });
}

async function checkin(page, item) {
    const barcode = item.external_id;
    console.log(`Check in ${barcode}`)

    const url_circulation = `${STAFF_BASE_URL}/cgi-bin/koha/circ/returns.pl`;
    console.log(`Go to ${url_circulation}`);
    await page.goto(url_circulation);

    console.log("Type barcode");
    await page.locator('#barcode').type(barcode);

    console.log("Click submit");
    const submitButton = page.locator('#circ_returns_checkin button[type="submit"]');
    await Promise.all([submitButton.click(), page.waitForNavigation()]); 

    console.log("Get checked in table");
    const checkedIn = await page.locator("#checkedintable").first().textContent();
    check(checkedIn, {
        'checked out item matches': (checkedIn) => checkedIn.includes(barcode) 
    });
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

    let borrower = pick(borrowers);
    while( borrower.cardnumber === null ) {
        borrower = pick(borrowers);
    }
    console.log("BORROWER CARDNUMBER: ", borrower.cardnumber);
    let item = pick(items);
    while( item.external_id === null ) {
        item = pick(items);
    }
    console.log("ITEM EXTERNAL ID: ", item.external_id);

    //await checkin(page, item);
    //await checkout(page, borrower, item);
    //await checkin(page, item);
    await search_opac("cat");

    // -----------------------------
    // MAIN STAFF WORKFLOW LOOP
    // -----------------------------
    //while (true) {
    while (false) {
        const action = Math.random();

        // --- SEARCH ---
        if (action < 0.33) {
            const term = pick(["history", "fiction", "science", "children", "art"]);
            await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/staff/catalogue/search.pl?q=${term}`);
            await page.waitForSelector("body");
        }

        // --- CHECKOUT ---
        else if (action < 0.66) {
            const borrower = pick(borrowers);
            const item = pick(items);

            await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/staff/circ/circulation.pl`);
            await page.fill('input[name="borrowernumber"]', borrower);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(600);

            await page.fill('input[name="barcode"]', item);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(800);
        }

        // --- CHECKIN ---
        else {
            const item = pick(items);

            await page.goto(`${STAFF_BASE_URL}/cgi-bin/koha/staff/circ/returns.pl`);
            await page.fill('input[name="barcode"]', item);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(800);
        }

        // simulate staff "thinking time"
        sleep(1 + Math.random() * 3);
    }
}

