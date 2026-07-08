// lib/solr.js - Solr request helpers ( auth headers, query building ) imported
// by solr_http.js.
import http from "k6/http";
import encoding from "k6/encoding";

/**
 * Build auth headers for Solr requests
 * @param {string} user - Solr username
 * @param {string} pass - Solr password
 * @returns {Object} Headers object
 */
export function getSolrHeaders(user, pass) {
  const headers = {
    "Accept": "application/json",
  };
  if (user && pass) {
    const credentials = encoding.b64encode(`${user}:${pass}`);
    headers["Authorization"] = `Basic ${credentials}`;
  }
  return headers;
}

/**
 * Fetch Solr system info from /admin/info/system
 * @param {string} solrUrl - Base Solr URL
 * @param {Object} headers - Request headers
 * @returns {Object|null} System info or null on error
 */
export function fetchSolrSystemInfo(solrUrl, headers) {
  try {
    const sysInfoUrl = `${solrUrl}/solr/admin/info/system?wt=json`;
    const res = http.get(sysInfoUrl, { headers, timeout: "10s" });
    if (res.status === 200) {
      return JSON.parse(res.body);
    }
  } catch (e) {
    return { error: `Could not fetch: ${e.message}` };
  }
  return null;
}

/**
 * Fetch Solr core metrics (query handler, cache stats)
 * @param {string} solrUrl - Base Solr URL
 * @param {string} solrCore - Core/collection name
 * @param {Object} headers - Request headers
 * @param {string} label - Label for logging
 */
export function collectSolrMetrics(solrUrl, solrCore, headers, label) {
  try {
    const metricsUrl = `${solrUrl}/solr/admin/metrics?group=core&type=all&prefix=QUERY,CACHE&wt=json`;
    const metricsRes = http.get(metricsUrl, { headers, timeout: "5s", tags: { name: "stats" } });
    
    if (metricsRes.status === 200) {
      const metrics = JSON.parse(metricsRes.body);
      
      console.log(`\n[SOLR STATS @ ${label}]`);
      
      const coreMetrics = metrics.metrics || {};
      for (const [coreName, coreData] of Object.entries(coreMetrics)) {
        if (coreName.includes(solrCore)) {
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
    
    // Get cluster status for shard info (once at start)
    if (label === "BASELINE") {
      const clusterUrl = `${solrUrl}/solr/admin/collections?action=CLUSTERSTATUS&wt=json`;
      const clusterRes = http.get(clusterUrl, { headers, timeout: "5s", tags: { name: "stats" } });
      
      if (clusterRes.status === 200) {
        const cluster = JSON.parse(clusterRes.body);
        const collection = cluster.cluster?.collections?.[solrCore];
        if (collection) {
          const shardCount = Object.keys(collection.shards || {}).length;
          const replicaCount = Object.values(collection.shards || {}).reduce((sum, shard) => {
            return sum + Object.keys(shard.replicas || {}).length;
          }, 0);
          console.log(`  Collection: ${solrCore}`);
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

