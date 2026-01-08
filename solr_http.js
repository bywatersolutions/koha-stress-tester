import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Trend, Counter } from "k6/metrics";
import encoding from "k6/encoding";
import exec from "k6/execution";

// ------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------------
const SOLR_URL = __ENV.SOLR_URL || "https://solr.example.com:8983";
const SOLR_CORE = __ENV.SOLR_CORE || "grouped_works";
const SOLR_USER = __ENV.SOLR_USER || "";
const SOLR_PASS = __ENV.SOLR_PASS || "";
const MAX_VUS = parseInt(__ENV.MAX_VUS) || 300;
const VU_STEP = parseInt(__ENV.VU_STEP) || 10;
const RAMP_TIME = __ENV.RAMP_TIME || "5s";
const HOLD_TIME = __ENV.HOLD_TIME || "5s";
const STATS_INTERVAL = parseInt(__ENV.STATS_INTERVAL) || 10; // seconds between stats collection
const HARD_TIMEOUT = __ENV.HARD_TIMEOUT || "30m"; // Hard timeout - ends test regardless of state
const HOLD_ON_FAIL = __ENV.HOLD_ON_FAIL || "30s"; // Time to collect stats after threshold crossed

// Load words from file
const words = new SharedArray("words", function () {
  return open("./words_alpha.txt").split(/\r?\n/).filter(w => w.trim());
});

// Custom metrics for Solr's self-reported times
const solrQTime = new Trend("solr_qtime", true);           // Solr's reported query time (ms)
const solrNumFound = new Trend("solr_num_found", true);    // Results count
const solrQTimeOver100 = new Counter("solr_qtime_over_100ms");
const solrQTimeOver500 = new Counter("solr_qtime_over_500ms");
const solrQTimeOver1000 = new Counter("solr_qtime_over_1000ms");

// Build auth header if credentials provided
function getHeaders() {
  const headers = {
    "Accept": "application/json",
  };
  if (SOLR_USER && SOLR_PASS) {
    const credentials = encoding.b64encode(`${SOLR_USER}:${SOLR_PASS}`);
    headers["Authorization"] = `Basic ${credentials}`;
  }
  return headers;
}

const headers = getHeaders();

// Default request params
const params = {
  headers: headers,
  timeout: "6s",
};

// ------------------------------------------------------------
// Generate stages dynamically
// ------------------------------------------------------------
function generateStages() {
  const stages = [];
  for (let vus = VU_STEP; vus <= MAX_VUS; vus += VU_STEP) {
    stages.push({ duration: RAMP_TIME, target: vus });
    stages.push({ duration: HOLD_TIME, target: vus });
  }
  stages.push({ duration: RAMP_TIME, target: 0 });
  return stages;
}

// Calculate total test duration for stats collector
function getTotalDuration() {
  const rampSecs = parseInt(RAMP_TIME) || 5;
  const holdSecs = parseInt(HOLD_TIME) || 5;
  const numSteps = Math.ceil(MAX_VUS / VU_STEP);
  const totalSecs = (numSteps * (rampSecs + holdSecs)) + rampSecs + 30; // +30 buffer
  return `${totalSecs}s`;
}

export const options = {
  insecureSkipTLSVerify: true,
  
  // Hard timeout - test ends regardless of state
  maxDuration: HARD_TIMEOUT,
  
  scenarios: {
    // Main load test scenario
    load_test: {
      executor: "ramping-vus",
      stages: generateStages(),
      gracefulRampDown: "10s",
    },
    // Stats collector - single VU polling Solr metrics
    stats_collector: {
      executor: "constant-vus",
      vus: 1,
      duration: getTotalDuration(),
      exec: "collectStats",
    },
  },
  thresholds: {
    http_req_failed: [
      {
        threshold: "rate<0.02",
        abortOnFail: true,
        delayAbortEval: HOLD_ON_FAIL, // Hold and collect stats before abort
      },
    ],
    http_req_duration: [
      {
        threshold: "p(95)<5000",
        abortOnFail: true,
        delayAbortEval: HOLD_ON_FAIL,
      },
    ],
    solr_qtime: ["p(95)<2000"], // Solr's self-reported time
  },
};

export function setup() {
  console.log(`========================================`);
  console.log(`SOLR BENCHMARK TEST`);
  console.log(`========================================`);
  console.log(`SOLR_URL: ${SOLR_URL}`);
  console.log(`SOLR_CORE: ${SOLR_CORE}`);
  console.log(`SOLR_USER: ${SOLR_USER ? "(set)" : "(not set)"}`);
  console.log(`MAX_VUS: ${MAX_VUS}, VU_STEP: ${VU_STEP}`);
  console.log(`RAMP_TIME: ${RAMP_TIME}, HOLD_TIME: ${HOLD_TIME}`);
  console.log(`STATS_INTERVAL: ${STATS_INTERVAL}s`);
  console.log(`HARD_TIMEOUT: ${HARD_TIMEOUT} (absolute max duration)`);
  console.log(`HOLD_ON_FAIL: ${HOLD_ON_FAIL} (stats capture before abort)`);
  console.log(`Aborts on >2% failures or p(95)>5s`);
  console.log(`========================================`);
  
  // Initial stats snapshot
  collectSolrMetrics("BASELINE");
}

// Main load test function
export default function () {
  const word = words[Math.floor(Math.random() * words.length)];
  
  // Solr select query with debug timing
  const queryUrl = `${SOLR_URL}/solr/${SOLR_CORE}/select?q=${encodeURIComponent(word)}&wt=json&rows=10`;
  
  const res = http.get(queryUrl, params);
  
  // Parse response and extract Solr's QTime
  let qtime = 0;
  let numFound = 0;
  
  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      qtime = body.responseHeader?.QTime || 0;
      numFound = body.response?.numFound || 0;
      
      // Record Solr's self-reported metrics
      solrQTime.add(qtime);
      solrNumFound.add(numFound);
      
      // Count slow queries by Solr's measure
      if (qtime > 100) solrQTimeOver100.add(1);
      if (qtime > 500) solrQTimeOver500.add(1);
      if (qtime > 1000) solrQTimeOver1000.add(1);
    } catch (e) {
      // Parse error
    }
  }
  
  check(res, {
    "solr 200": (r) => r.status === 200,
    "has response": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.response !== undefined;
      } catch {
        return false;
      }
    },
    "response < 500ms": (r) => r.timings.duration < 500,
    "response < 1000ms": (r) => r.timings.duration < 1000,
    "response < 2000ms": (r) => r.timings.duration < 2000,
  });
}

// Stats collector function - runs independently
export function collectStats() {
  sleep(STATS_INTERVAL);
  
  const currentVUs = exec.scenario.activeVUs || "?";
  collectSolrMetrics(`VUs: ~${currentVUs}`);
}

// Query Solr metrics endpoint
function collectSolrMetrics(label) {
  try {
    // Get Solr core metrics
    const metricsUrl = `${SOLR_URL}/solr/admin/metrics?group=core&type=all&prefix=QUERY,CACHE&wt=json`;
    const metricsRes = http.get(metricsUrl, { headers, timeout: "5s", tags: { name: "stats" } });
    
    if (metricsRes.status === 200) {
      const metrics = JSON.parse(metricsRes.body);
      
      console.log(`\n[SOLR STATS @ ${label}]`);
      
      // Try to extract useful metrics
      const coreMetrics = metrics.metrics || {};
      for (const [coreName, coreData] of Object.entries(coreMetrics)) {
        if (coreName.includes(SOLR_CORE)) {
          // Query handler stats
          const queryHandler = coreData["QUERY./select"] || {};
          if (queryHandler.requests !== undefined) {
            console.log(`  Requests: ${queryHandler.requests}`);
            console.log(`  Avg Time: ${queryHandler.avgTimePerRequest?.toFixed(2) || "N/A"}ms`);
            console.log(`  95th %ile: ${queryHandler["95thPcRequestTime"]?.toFixed(2) || "N/A"}ms`);
            console.log(`  Errors: ${queryHandler.errors || 0}`);
            console.log(`  Timeouts: ${queryHandler.timeouts || 0}`);
          }
          
          // Cache stats
          const filterCache = coreData["CACHE.searcher.filterCache"] || {};
          const queryCache = coreData["CACHE.searcher.queryResultCache"] || {};
          
          if (filterCache.hitratio !== undefined) {
            console.log(`  Filter Cache Hit Ratio: ${(filterCache.hitratio * 100).toFixed(1)}%`);
          }
          if (queryCache.hitratio !== undefined) {
            console.log(`  Query Cache Hit Ratio: ${(queryCache.hitratio * 100).toFixed(1)}%`);
          }
        }
      }
    }
    
    // Also get cluster status for shard info (once at start)
    if (label === "BASELINE") {
      const clusterUrl = `${SOLR_URL}/solr/admin/collections?action=CLUSTERSTATUS&wt=json`;
      const clusterRes = http.get(clusterUrl, { headers, timeout: "5s", tags: { name: "stats" } });
      
      if (clusterRes.status === 200) {
        const cluster = JSON.parse(clusterRes.body);
        const collection = cluster.cluster?.collections?.[SOLR_CORE];
        if (collection) {
          const shardCount = Object.keys(collection.shards || {}).length;
          const replicaCount = Object.values(collection.shards || {}).reduce((sum, shard) => {
            return sum + Object.keys(shard.replicas || {}).length;
          }, 0);
          console.log(`  Collection: ${SOLR_CORE}`);
          console.log(`  Shards: ${shardCount}`);
          console.log(`  Total Replicas: ${replicaCount}`);
          if (shardCount === 1) {
            console.log(`  ###############################################################`);
            console.log(`  ### WARNING: Single shard - no query parallelism across nodes! ###`);
            console.log(`  ###############################################################`);
          }
        }
      }
    }
  } catch (e) {
    console.log(`[SOLR STATS @ ${label}] Error collecting metrics: ${e.message}`);
  }
}

export function teardown() {
  console.log(`\n========================================`);
  console.log(`TEST COMPLETE`);
  console.log(`========================================`);
  collectSolrMetrics("FINAL");
}
