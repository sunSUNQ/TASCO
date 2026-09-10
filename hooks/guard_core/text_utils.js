// ============================================================================
// guard_core/text_utils.js — Pure text/array/object utility functions
// ============================================================================
// All functions here are "pure": they do NOT depend on taskState, payload,
// file I/O, or any runtime state from the main hook file.
// ============================================================================

const { MAX_REASON_CHARS, COMPACT_REASON_CHARS, DEBUG_REASON_CHARS } = require("./constants");

/**
 * Truncate text to maxChars, appending a truncation marker if needed.
 * @param {string} text
 * @param {number} [maxChars=MAX_REASON_CHARS]
 * @returns {string}
 */
function clampText(text, maxChars = MAX_REASON_CHARS) {
  const raw = String(text || "");
  if (raw.length <= maxChars) {
    return raw;
  }
  return raw.slice(0, maxChars) + "\n...[HOOK_REASON_TRUNCATED]";
}

/**
 * Ensure a value is a plain object (not array, not null).
 * @param {*} value
 * @returns {object}
 */
function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/**
 * Ensure a value is an array.
 * @param {*} value
 * @returns {array}
 */
function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Ensure a value is a finite number.
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function ensureNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Add a unique string item to an array, keeping at most maxItems items.
 * @param {array} arr
 * @param {*} item
 * @param {number} [maxItems=200]
 * @returns {array}
 */
function addUniqueLimited(arr, item, maxItems = 200) {
  const result = ensureArray(arr);

  const v = String(item || "").trim();
  if (!v) {
    return result;
  }

  if (!result.includes(v)) {
    result.push(v);
  }

  return result.slice(-maxItems);
}

/**
 * Strip surrounding single or double quotes from a string.
 * @param {string} s
 * @returns {string}
 */
function stripQuotes(s) {
  return String(s || "").replace(/^["']|["']$/g, "");
}

/**
 * Check if a user query is blank, empty, or a known generic fallback text.
 * Blank queries (empty string, null, undefined, whitespace-only) should be
 * treated as generic because they carry no user intent.
 * @param {*} query
 * @param {boolean} hasTranscriptPath
 * @returns {boolean}
 */
function isBlankOrGenericUserQuery(query, hasTranscriptPath) {
  if (!query || String(query).trim() === "") {
    return true;
  }
  if (!hasTranscriptPath) {
    return true;
  }
  const q = String(query).trim();
  if (
    q === "Locate task-related functions, classes, and code paths." ||
    q === "Locate task-related functions and classes."
  ) {
    return true;
  }
  return false;
}

module.exports = {
  clampText,
  ensureObject,
  ensureArray,
  ensureNumber,
  addUniqueLimited,
  stripQuotes,
  isBlankOrGenericUserQuery,
};