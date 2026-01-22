/**
 * Format a summary for console output
 * @param {Object} data - k6 summary data
 * @param {Object} options - Options for formatting
 * @param {boolean} options.includeSolrQtime - Include Solr QTime metrics
 * @param {number} options.peakVUs - Manually tracked peak VUs (more accurate during abort)
 * @param {number} options.thresholdPercentile - The percentile used for threshold (default 98)
 * @returns {string} Formatted summary string
 */
export function formatSummary(data, options = {}) {
  const lines = ["", "=".repeat(60), "TEST SUMMARY", "=".repeat(60)];

  const m = data.metrics;
  const pct = options.thresholdPercentile || 98;

  // Result overview - prefer manually tracked peak VUs over k6 metric
  const peakVUs = options.peakVUs || m.vus?.values?.max;
  if (peakVUs) lines.push(`  peak_vus................: ${peakVUs}`);
  if (m.http_reqs)
    lines.push(`  http_reqs...............: ${m.http_reqs.values.count}`);
  if (m.iterations)
    lines.push(`  iterations..............: ${m.iterations.values.count}`);
  if (m.http_req_failed)
    lines.push(
      `  http_req_failed.........: ${(m.http_req_failed.values.rate * 100).toFixed(2)}%`,
    );

  lines.push("");

  // Timing (using median - resistant to timeout skew)
  if (m.http_req_duration) {
    const d = m.http_req_duration.values;
    const pctValue = d[`p(${pct})`]?.toFixed(2) || "N/A";
    lines.push(
      `  http_req_duration.......: med=${d.med?.toFixed(2)}ms p(90)=${d["p(90)"]?.toFixed(2)}ms p(${pct})=${pctValue}ms`,
    );
  }
  if (m.http_req_waiting) {
    lines.push(
      `  http_req_waiting (TTFB).: med=${m.http_req_waiting.values.med?.toFixed(2)}ms`,
    );
  }
  if (options.includeSolrQtime && m.solr_qtime) {
    const q = m.solr_qtime.values;
    const pctValue = q[`p(${pct})`]?.toFixed(2) || "N/A";
    lines.push(
      `  solr_qtime..............: med=${q.med?.toFixed(2)}ms p(${pct})=${pctValue}ms`,
    );
  }

  lines.push("");

  // Data transfer
  if (m.data_received) {
    const mb = (m.data_received.values.count / 1024 / 1024).toFixed(2);
    lines.push(`  data_received...........: ${mb} MB`);
  }

  lines.push("=".repeat(60));
  lines.push("");
  return lines.join("\n");
}

/**
 * Extract abort reason from thresholds
 * @param {Object} data - k6 summary data
 * @param {Object} config - Optional config with thresholdPercentile, abortMs, maxFailRate, peakVUs, maxVUs
 * @returns {string} Abort reason or "completed" if test finished successfully
 */
export function getAbortReason(data, config = {}) {
  const failedThresholds = [];

  // Method 1: Check k6's thresholds object for failures
  if (data.thresholds) {
    for (const [name, threshold] of Object.entries(data.thresholds)) {
      if (threshold.ok === false) {
        failedThresholds.push(name);
      } else if (Array.isArray(threshold.thresholds)) {
        for (const t of threshold.thresholds) {
          if (t.ok === false) {
            failedThresholds.push(name);
            break;
          }
        }
      }
    }
  }

  // Method 2: Check actual metrics against config (backup if k6 thresholds not reliable)
  if (failedThresholds.length === 0 && config.abortMs && config.thresholdPercentile) {
    const m = data.metrics;
    const pctKey = `p(${config.thresholdPercentile})`;
    const pctValue = m?.http_req_duration?.values?.[pctKey];
    
    if (pctValue && pctValue >= config.abortMs) {
      failedThresholds.push(`http_req_duration p(${config.thresholdPercentile})=${pctValue.toFixed(0)}ms >= ${config.abortMs}ms`);
    }
  }

  if (failedThresholds.length === 0 && config.maxFailRate) {
    const failRate = data.metrics?.http_req_failed?.values?.rate || 0;
    if (failRate >= config.maxFailRate) {
      failedThresholds.push(`http_req_failed rate=${(failRate * 100).toFixed(1)}% >= ${(config.maxFailRate * 100).toFixed(0)}%`);
    }
  }

  // Method 3: Check if test ended early (didn't reach max VUs)
  if (failedThresholds.length === 0 && config.peakVUs && config.maxVUs) {
    if (config.peakVUs < config.maxVUs) {
      // Test ended before reaching max VUs - likely aborted but we don't know why
      return `aborted early (reached ${config.peakVUs}/${config.maxVUs} VUs)`;
    }
  }

  if (failedThresholds.length > 0) {
    return `aborted: ${failedThresholds.join("; ")}`;
  }

  return "completed";
}

/**
 * Calculate derived metrics from k6 data
 * @param {Object} data - k6 summary data
 * @returns {Object} Derived metrics
 */
export function calculateDerivedMetrics(data) {
  const m = data.metrics;
  const totalRequests = m.http_reqs?.values?.count || 0;

  // Use k6's built-in rate metric (requests/second) - more reliable than data.state
  const rps = m.http_reqs?.values?.rate?.toFixed(2) || null;

  // Calculate duration from rate, or fall back to state
  let testDuration = 0;
  if (rps && parseFloat(rps) > 0) {
    testDuration = totalRequests / parseFloat(rps);
  } else if (data.state?.testRunDurationMs) {
    testDuration = data.state.testRunDurationMs / 1000;
  }

  return { totalRequests, testDuration, rps };
}

/**
 * Build timing section for summary
 * @param {Object} m - k6 metrics object
 * @param {number} thresholdPercentile - The percentile used for threshold (default 98)
 * @returns {Object} Timing data
 */
export function buildTimingSection(m, thresholdPercentile = 98) {
  const result = {
    med_ms: m.http_req_duration?.values?.med?.toFixed(2) || null,
    p90_ms: m.http_req_duration?.values?.["p(90)"]?.toFixed(2) || null,
    min_ms: m.http_req_duration?.values?.min?.toFixed(2) || null,
    max_ms: m.http_req_duration?.values?.max?.toFixed(2) || null,
    avg_ms_may_be_skewed: m.http_req_duration?.values?.avg?.toFixed(2) || null,
  };
  // Add the threshold percentile dynamically
  result[`p${thresholdPercentile}_ms`] = m.http_req_duration?.values?.[`p(${thresholdPercentile})`]?.toFixed(2) || null;
  return result;
}

/**
 * Build timing breakdown section for summary
 * @param {Object} m - k6 metrics object
 * @returns {Object} Timing breakdown data
 */
export function buildTimingBreakdown(m) {
  return {
    blocked_med_ms: m.http_req_blocked?.values?.med?.toFixed(2) || null,
    connecting_med_ms: m.http_req_connecting?.values?.med?.toFixed(2) || null,
    tls_handshake_med_ms:
      m.http_req_tls_handshaking?.values?.med?.toFixed(2) || null,
    sending_med_ms: m.http_req_sending?.values?.med?.toFixed(2) || null,
    waiting_med_ms: m.http_req_waiting?.values?.med?.toFixed(2) || null,
    receiving_med_ms: m.http_req_receiving?.values?.med?.toFixed(2) || null,
  };
}

/**
 * Build data transfer section for summary
 * @param {Object} m - k6 metrics object
 * @returns {Object} Data transfer data
 */
export function buildDataTransfer(m) {
  return {
    received_mb: ((m.data_received?.values?.count || 0) / 1024 / 1024).toFixed(
      2,
    ),
    sent_mb: ((m.data_sent?.values?.count || 0) / 1024 / 1024).toFixed(2),
  };
}

/**
 * Extract check pass rates from k6 data
 * @param {Object} data - k6 summary data
 * @returns {Object} Checks data
 */
export function extractChecks(data) {
  const checks = {};
  if (data.root_group?.checks) {
    for (const check of data.root_group.checks) {
      const total = check.passes + check.fails;
      checks[check.name] = {
        passes: check.passes,
        fails: check.fails,
        rate:
          total > 0 ? `${((check.passes / total) * 100).toFixed(1)}%` : "N/A",
      };
    }
  }
  return checks;
}

/**
 * Generate timestamped output filename
 * @param {string} scriptName - Name of the script (e.g., "solr", "aspen")
 * @param {string} testNumber - Test number
 * @returns {string} Output path
 */
export function generateOutputPath(scriptName, testNumber) {
  const now = new Date();
  const shortDate = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 16).replace(/:/g, "");
  // Use OUTPUT_DIR env var, or /output (Docker) if it exists, otherwise ./output (local)
  const outputDir = __ENV.OUTPUT_DIR || "/output";
  return `${outputDir}/${scriptName}-${testNumber}-${shortDate}-${time}.json`;
}
