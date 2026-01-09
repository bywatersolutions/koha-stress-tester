# Koha Stress Tester

This repository contains k6 scripts for stress testing [Koha](https://koha-community.org/) and [Aspen Discovery](https://aspendiscovery.org/).

## Installation

You need [k6](https://k6.io/) installed to run these tests.

### Mac
Using Homebrew:
```bash
brew install k6
```

### Linux
Debian/Ubuntu:
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491B6C8DA84
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

## Aspen Discovery Stress Test

The `benchmarks/aspen.js` script simulates user traffic on an Aspen Discovery interface. It searches for random words from `words_alpha.txt`, clicks on results, and navigates back.

### Usage

```bash
k6 run benchmarks/aspen.js
```

### Environment Variables

You can configure the test using the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `URL` | The base URL of the Aspen Discovery instance. | `http://aspen-discovery.localhost` |
| `RESULTS_TO_CLICK` | The number of search results to interact with per search. | `5` |
| `VUS` | The number of Virtual Users to simulate. | `1` |
| `ITERATIONS` | The number of iterations to run per VU. | `1` |

**Example:**
```bash
k6 run -e URL=https://my-aspen-catalog.org -e RESULTS_TO_CLICK=3 benchmarks/aspen.js
```

## Koha Stress Test

The `benchmarks/koha.js` script simulates staff activity on the Koha staff interface and OPAC searches. It performs the following actions:
1. Logs in to the staff interface.
2. Creates a stub patron, biblio, and item via the API.
3. Checks the item in, checks it out to the patron, and checks it in again.
4. Performs a search on the OPAC.
5. Deletes the created test data.

### Usage

```bash
k6 run benchmarks/koha.js
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `STAFF_URL` | The URL of the Koha staff interface. | `http://kohadev-intra.localhost` |
| `OPAC_URL` | The URL of the Koha OPAC. | `http://kohadev.localhost` |
| `STAFF_USER` | The username for the staff interface login. | `koha` |
| `STAFF_PASS` | The password for the staff interface login. | `koha` |
| `VUS` | The number of Virtual Users to simulate. | `1` |
| `ITERATIONS` | The number of iterations to run per VU. | `1` |

**Example:**
```bash
k6 run -e STAFF_URL=http://staff.mylibrary.org -e STAFF_USER=admin -e STAFF_PASS=secret benchmarks/koha.js
```
