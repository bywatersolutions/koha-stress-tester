// lib/utils.js - shared helpers ( random/weighted sampling, load-option
// builders ) imported by the k6 benchmark scripts.

/**
 * Randomly selects an element from an array
 * @param {Array} arr - The array to pick an element from
 * @returns {*} A random element from the input array
 */
export function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a random alphanumeric string
 * @param {number} length - Length of the string to generate
 * @returns {string} Random alphanumeric string
 */
export function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Randomly selects an element from a cumulative-weight array, so elements
 * are picked proportionally to their weight (e.g. real search terms picked
 * as often as real patrons searched them).
 * @param {Array<{t: *, c: number}>} cumArr - Elements with cumulative weights,
 *   c ascending (c = sum of all weights up to and including this element)
 * @returns {*} The 't' value of the selected element
 */
export function weightedElement(cumArr) {
  const r = Math.random() * cumArr[cumArr.length - 1].c;
  let lo = 0;
  let hi = cumArr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumArr[mid].c <= r) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return cumArr[lo].t;
}

/**
 * Sample a value from a measured distribution given as a quantile table
 * (inverse-CDF with linear interpolation). The analyzer emits think times
 * as 11 quantiles (p0, p10, ... p100).
 * @param {Array<number>} q - Quantile values, evenly spaced from p0 to p100
 * @returns {number} A random sample following the measured distribution
 */
export function sampleQuantiles(q) {
  const u = Math.random() * (q.length - 1);
  const i = Math.floor(u);
  const f = u - i;
  return i + 1 < q.length ? q[i] + f * (q[i + 1] - q[i]) : q[i];
}

/**
 * Build the load-model portion of k6 options. When ratePerHour is set,
 * returns an open-model ramping-arrival-rate scenario (iterations arrive at
 * the measured rate whether or not the server keeps up - the honest model
 * for validating against real traffic). Otherwise returns the legacy
 * closed-model staged ramp.
 * @param {Object} opts
 * @param {number} opts.ratePerHour - Iterations per hour (0/undefined = staged model)
 * @param {string} opts.duration - Steady-state duration at the target rate
 * @param {string} opts.rampTime - Ramp up/down duration
 * @param {number} opts.preAllocatedVUs - VU pool (0 = estimate from rate)
 * @param {number} opts.maxVUs - Safety cap on VUs the scenario may spin up
 * @param {string} opts.gracefulStop - Graceful stop duration
 * @param {Function} opts.generateStages - Builder for the legacy stages array
 * @returns {Object} Fragment to spread into k6 options
 */
export function buildLoadOptions({ ratePerHour, duration, rampTime, preAllocatedVUs, maxVUs, gracefulStop, generateStages }) {
  if (!ratePerHour) {
    return { gracefulStop, stages: generateStages() };
  }
  const rate = Math.max(1, Math.round(ratePerHour));
  // Little's law estimate: concurrent sessions = rate x mean session length
  // (~90s), padded 1.5x. Tune via PRE_ALLOCATED_VUS if dropped_iterations > 0.
  const pool = preAllocatedVUs || Math.ceil((rate / 3600) * 90 * 1.5);
  return {
    scenarios: {
      open_model: {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: "1h",
        stages: [
          { duration: rampTime, target: rate },
          { duration: duration, target: rate },
          { duration: rampTime, target: 0 },
        ],
        preAllocatedVUs: pool,
        maxVUs: Math.max(pool, maxVUs || pool),
        gracefulStop,
      },
    },
  };
}

/**
 * Generate a UUID v7-like identifier (timestamp + random)
 * @returns {string} UUID-like hex string
 */
export function generateUUID() {
  const timestamp = BigInt(Date.now());
  let ts = timestamp.toString(16).padStart(12, "0");

  let randomHex = "";
  for (let i = 0; i < 16; i++) {
    randomHex += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  }

  const versionNibble = "7";
  randomHex = randomHex.substring(0, 12) + versionNibble + randomHex.substring(13);

  return ts + randomHex.substring(0, 20);
}

