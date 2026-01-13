/**
 * Format a summary for console output
 * @param {Object} data - k6 summary data
 * @param {Object} options - Options for formatting
 * @param {boolean} options.includeSolrQtime - Include Solr QTime metrics
 * @param {number} options.peakVUs - Manually tracked peak VUs (more accurate during abort)
 * @returns {string} Formatted summary string
 */
export function formatSummary(data, options = {}) {
  const lines = ["", "=".repeat(60), "TEST SUMMARY", "=".repeat(60)];

  const m = data.metrics;

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
    lines.push(
      `  http_req_duration.......: med=${d.med?.toFixed(2)}ms p(90)=${d["p(90)"]?.toFixed(2)}ms p(95)=${d["p(95)"]?.toFixed(2)}ms`,
    );
  }
  if (m.http_req_waiting) {
    lines.push(
      `  http_req_waiting (TTFB).: med=${m.http_req_waiting.values.med?.toFixed(2)}ms`,
    );
  }
  if (options.includeSolrQtime && m.solr_qtime) {
    const q = m.solr_qtime.values;
    lines.push(
      `  solr_qtime..............: med=${q.med?.toFixed(2)}ms p(95)=${q["p(95)"]?.toFixed(2)}ms`,
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
 * @returns {string|null} Abort reason or null
 */
export function getAbortReason(data) {
  if (data.thresholds) {
    for (const [name, threshold] of Object.entries(data.thresholds)) {
      if (!threshold.ok) {
        return `${name} threshold crossed`;
      }
    }
  }
  return null;
}

/**
 * Calculate derived metrics from k6 data
 * @param {Object} data - k6 summary data
 * @returns {Object} Derived metrics
 */
export function calculateDerivedMetrics(data) {
  const m = data.metrics;
  const totalRequests = m.http_reqs?.values?.count || 0;
  const testDuration =
    m.iteration_duration?.values?.count > 0
      ? (data.state?.testRunDurationMs || 0) / 1000
      : 0;
  const rps =
    testDuration > 0 ? (totalRequests / testDuration).toFixed(2) : null;

  return { totalRequests, testDuration, rps };
}

/**
 * Build timing section for summary
 * @param {Object} m - k6 metrics object
 * @returns {Object} Timing data
 */
export function buildTimingSection(m) {
  return {
    med_ms: m.http_req_duration?.values?.med?.toFixed(2) || null,
    p90_ms: m.http_req_duration?.values?.["p(90)"]?.toFixed(2) || null,
    p95_ms: m.http_req_duration?.values?.["p(95)"]?.toFixed(2) || null,
    min_ms: m.http_req_duration?.values?.min?.toFixed(2) || null,
    max_ms: m.http_req_duration?.values?.max?.toFixed(2) || null,
    avg_ms_may_be_skewed: m.http_req_duration?.values?.avg?.toFixed(2) || null,
  };
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
  return `/output/${scriptName}-${testNumber}-${shortDate}-${time}.json`;
}
