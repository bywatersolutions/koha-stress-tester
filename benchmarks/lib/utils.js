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

