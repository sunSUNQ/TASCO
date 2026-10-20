/**
 * mojibake_detect.js
 *
 * Shared utility for detecting mojibake (encoding-corrupted text) in tool outputs.
 *
 * Detection strategy:
 * - NOT based on "Chinese character ratio" — avoids false positives on normal Chinese spec text.
 * - Uses two tiers of patterns:
 *   1. STRONG patterns: Unicode replacement char, Private Use Area chars, known multi-char
 *      mojibake fragments (e.g., "鑻ヤ负", "鍙噸"). Even 1-2 hits strongly suggest mojibake.
 *   2. WEAK chars: individual mojibake artifact characters that can sometimes appear in
 *      normal text (e.g., punctuation artifacts). Only count as supplemental evidence.
 *
 * Usage:
 *   const { detectMojibake, buildMojibakeDroppedOutput } = require('./post_tool/mojibake_detect.js');
 *   const result = detectMojibake(someText);
 *   if (result.mojibake) { ... }
 */

// =========================================================
// Strong mojibake patterns — regex-based multi-char fragments
// These are encoding-corruption artifacts, never normal text.
// =========================================================

// Unicode replacement character — definitive mojibake marker.
const REPLACEMENT_CHAR_RE = /\uFFFD/g;

// Private Use Area (PUA) characters — never appear in normal text.
const PUA_RE = /[\uE000-\uF8FF]/g;

// Known multi-character mojibake fragments (UTF-8 bytes misinterpreted as GBK/GB2312).
// These are NOT valid Chinese words — they are encoding artifacts.
const STRONG_FRAGMENTS = [
  // Common GBK-misread fragments from UTF-8 Chinese text
  /\u947b\u4e5f\u8d1f/g,    // 鑻ヤ负 (from 若为)
  /\u947b\u99ac\u91cd/g,    // 鍙噸 (from 可重)
  /\u6545\u932f\u4e5f/g,    // 閿欒 (from 错误)
  /\u932f\u8aa4\u932f/g,    // 欒 (from 误)
  /\u7d5b\u6b63\u5f85/g,    // 绛夊 (from 等待)
  /\u6b12\u6aa2\u6d60/g,    // 妫€鏌 (from 检查)
  /\u951b\u582c/g,           // 锛岄 (from ，)
  /\u9286\u20ac/g,           // 銆€ (from \u3000)
  /\u9286\u4f72/g,           // 銆 (from 。)
  /\u20ac\u6ebe/g,           // €溾 (from " or 「)
  /\u20ac\u6fc4/g,           // €濆 (from )
  /\u9352\u55d8/g,           // 硠槻 (from 保护)
  /\u9352\u6d98/g,           // 硠 (from 护)
  /\u9352\u72bb/g,           // 硠 (from 护)
  /\u9359\u509b/g,           // 鎶 (from 报)
  /\u9359\u6a40/g,           // 鎶 (from 报)
  /\u934f\u62bd/g,           // 锛 (from ：)
  /\u9350\u546d/g,           // 锛 (from ：)
  /\u9357\u66de/g,           // 锛 (from ；)
  /\u9358\u71b7/g,           // 锛 (from ）
  /\u9352\u55d8\u703d/g,     // 硠槻 (from 保护)
  /\u9352\u6d98\u7f13/g,     // 硠 (from 护)
  /\u9352\u72bb\u6ace/g,     // 硠 (from 护)
  /\u9359\u509b\u669f/g,     // 鎶 (from 报)
  /\u9359\u6a40\u567a/g,     // 鎶 (from 报)
  /\u9357\u5fda/g,           // 锛 (from ；)
  /\u9358\u71b7\u7037/g,     // 锛 (from ）
  /\u934f\u3125\u772c/g,     // 锛 (from ：)
  /\u934f\ue0ff\u7d11/g,     // 锛 (from ：)
  /\u9350\u546d\ue190/g,     // 锛 (from ：)
  /\u9352\u55d8\u703d/g,     // 硠槻 (from 保护)
  /\u9352\u6d98\u7f13/g,     // 硠 (from 护)
  /\u9352\u72bb\u6ace/g,     // 硠 (from 护)
  /\u9359\u509b\u669f/g,     // 鎶 (from 报)
  /\u9359\u6a40\u567a/g,     // 鎶 (from 报)
  /\u9357\u5fda\ue185/g,    // 锛 (from ；)
  /\u9358\u71b7\u7037/g,     // 锛 (from ）
  /\u934f\u3125\u772c/g,     // 锛 (from ：)
  /\u934f\ue0ff\u7d11/g,     // 锛 (from ：)
  /\u9350\u546d\ue190/g,     // 锛 (from ：)
];

// Combine all strong patterns into one regex for efficient scanning.
function buildStrongRe() {
  const sources = [];
  sources.push(REPLACEMENT_CHAR_RE.source);
  sources.push(PUA_RE.source);
  for (const re of STRONG_FRAGMENTS) {
    sources.push(re.source);
  }
  return new RegExp(sources.join("|"), "g");
}

const STRONG_RE = buildStrongRe();

// =========================================================
// Weak mojibake characters — individual chars that are
// commonly mojibake artifacts but could occasionally appear
// in isolation in normal text (e.g., as punctuation artifacts).
// Only counted as supplemental evidence.
// =========================================================

// Escape a single character for safe inclusion in a regex character class.
// Handles: \ ] [ ^ -
function escapeRegexClassChar(ch) {
  if (ch === "\\") return "\\\\";
  if (ch === "]") return "\\]";
  if (ch === "[") return "\\[";
  if (ch === "^") return "\\^";
  if (ch === "-") return "\\-";
  return ch;
}

// Weak mojibake characters — single characters that are encoding artifacts.
// These appear in mojibake text but can also appear as isolated artifacts
// in normal text (e.g., certain punctuation lookalikes).
const WEAK_CHARS_STR = "" +
  "\u947b" +   // 鑻
  "\u9359" +   // 鍙
  "\u7edb" +   // 绛
  "\u95bf" +   // 閿
  "\u6b12" +   // 欒
  "\u59ab" +   // 妫
  "\u5a4a" +   // 婊
  "\u93bf" +   // 鎿
  "\u7039" +   // 瀹
  "\u70b5" +   // 炵
  "\u6d60" +   // 浠
  "\u8bf2" +   // 诲
  "\u581d" +   // 堝
  "\u5bf0" +   // 寰
  "\u5678" +   // 噸
  "\u7487" +   // 璇
  "\u56e9" +   // 囩
  "\u53e7" +   // 叧
  "\u6b91" +   // 殑
  "\u6d93" +   // 涓
  "\u6d63" +   // 浣
  "\u9366" +   // 鍦
  "\u7860" +   // 硠
  "\u69fb" +   // 槻
  "\u93b6" +   // 鎶
  "\u951b" +   // 锛
  "\u9286" +   // 銆
  "\u20ac" +   // €
  "\u4f7a" +   // 佺
  "\u7d89" +   // 綉
  "\u93bb" +   // 鎻
  "\u612e" +   // 愮
  "\u305a" +   // ず
  "\u6dc7" +   // 浼
  "\u2103" +   // ℃
  "\u4f05" +   // 伅
  "\u9428" +   // 釨
  "\u52eb" +   // 勫
  "\u5534" +   // 啴
  "\u5f52" +   // 帰
  "\u300d" +   // 』
  "\u9429" +   // 釩
  "\u7a3f" +   // 稿
  "\u5d84" +   // 嶄
  "\u7d94" +   // 綔
  "\u5e47" +   // 幇
  "\u93c2" +   // 鏂
  "\u73f7" +   // 珷
  "\u93c8" +   // 鏈
  "\u6783" +   // 桢
  "\uff47" +   // ｇ
  "\u721c" +   // 爜
  "\u30e5" +   // ュ
  "\u5f37" +   // 強
  "\u8bb3" +   // 讳
  "\u7d8d" +   // 綍
  "\u6c3e" +   // 氾
  "\u7d31" +   // 绫
  "\u7d1d" +   // 紝
  "\u4f72" +   // 佲
  "\u6ebe" +   // 溾
  "\u6fc4" +   // 濄
  "\u5b28" +   // 嬨
  "\u6a37" +   // 樷
  "\u6924" +   // 椤
  "\u572d" +   // 坭
  "\u6d30" +   // 洰
  "\u7584" +   // 疄
  "\u677f" +   // 板
  "\u74e8" +   // 瓨
  "\u934c" +   // 鏌
  "\u3125" +   // ㌥
  "\u6e74" +   // 溴
  "\u9367" +   // 鏧
  "\u56e6" +   // 囦
  "\u6b22" +   // 歡
  "\ufe40" +   // ︀
  "\ue641" +   // 
  "\u59af" +   // 姯
  "\u7609" +   // 瘉
  "\u4f77" +   // 仏
  "\u529f" +   // 功
  "\ue21a" +   // 
  "\ue568" +   // 
  "\u6fca" +   // 濊
  "\u6fc7" +   // 濇
  "\u59e2" +   // 姢
  "\u6fc6" +   // 濆
  "\u772c" +   // 眬
  "\ue0ff" +   // 
  "\u7d11" +   // 紑
  "\ue190" +   // 
  "\u55d8" +   // 喘
  "\u703d" +   // 瀽
  "\u6d98" +   // 浘
  "\u7f13" +   // 缓
  "\u72bb" +   // 犻
  "\u6ace" +   // 毎
  "\u66de" +   // 曞
  "\u5393" +   // 厓
  "\u5fda" +   // 彚
  "\ue185" +   // 
  "\u71b7" +   // 熷
  "\u7037" +   // 瀷
  "\u509b" +   // 偛
  "\u669f" +   // 暟
  "\u6a40" +   // 橀
  "\u567a" +   // 噺
  "\u5757" +   // 块
  "\u68f6" +   // 棶
  "\u675e" +   // 杞
  "\ue101" +   // 
  "\u5d32" +   // 崲
  "\u6748" +   // 杈
  "\u64b3" +   // 撳
  "\u53c6" +   // 叆
  "\u56ad" +   // 嚭
  "\u25bc" +   // ▼
  "\u65bf" +   // 斿
  "\u6d16"     // 洖
;

// Build weak chars regex character class with proper escaping.
function buildWeakRe() {
  const escaped = WEAK_CHARS_STR.split("").map(escapeRegexClassChar).join("");
  return new RegExp("[" + escaped + "]", "g");
}

const WEAK_RE = buildWeakRe();

// =========================================================
// Public API
// =========================================================

/**
 * Count regex matches in text, safely handling global regex lastIndex.
 * Creates a local copy of the regex to avoid state pollution.
 */
function countRegexMatches(regex, text) {
  // Create a local copy with global flag to avoid lastIndex issues.
  const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  const localRe = new RegExp(regex.source, flags);
  let count = 0;
  while (localRe.exec(text) !== null) {
    count++;
    if (count >= 500) break; // Safety cap
  }
  return count;
}

/**
 * Detect mojibake in text.
 *
 * Uses two-tier pattern matching:
 * - Strong patterns (replacement char, PUA, known fragments) get weighted higher.
 * - Weak characters only count as supplemental evidence.
 *
 * @param {string} text - The text to analyze.
 * @param {object} [opts]
 * @param {number} [opts.sampleChars=20000] - Max chars to sample.
 * @param {number} [opts.minHitsShort=4] - Minimum total hits for short texts.
 * @param {number} [opts.minHits=8] - Minimum total hits threshold for normal texts.
 * @param {number} [opts.minRatio=0.01] - Minimum total hits/sample ratio.
 * @returns {{
 *   mojibake: boolean,
 *   hits: number,
 *   strongHits: number,
 *   weakHits: number,
 *   ratio: number,
 *   sampleChars: number
 * }}
 */
function detectMojibake(text, opts = {}) {
  const sampleChars = opts.sampleChars || 20000;
  const minHitsShort = opts.minHitsShort || 4;
  const minHits = opts.minHits || 8;
  const minRatio = opts.minRatio || 0.01;

  const sample = String(text || "").slice(0, sampleChars);
  if (!sample) {
    return { mojibake: false, hits: 0, strongHits: 0, weakHits: 0, ratio: 0, sampleChars: 0 };
  }

  // Count strong patterns and weak characters separately.
  const strongHits = countRegexMatches(STRONG_RE, sample);
  const weakHits = countRegexMatches(WEAK_RE, sample);
  const hits = strongHits + weakHits;

  const sampleLen = sample.length;
  const ratio = sampleLen > 0 ? hits / sampleLen : 0;

  // Decision logic:
  // - Short text (< 500 chars): strongHits >= 1 OR hits >= minHitsShort
  // - Normal/long text: strongHits >= 2 OR hits >= minHits OR ratio >= minRatio
  const mojibake =
    sampleLen < 500
      ? strongHits >= 1 || hits >= minHitsShort
      : strongHits >= 2 || hits >= minHits || ratio >= minRatio;

  return { mojibake, hits, strongHits, weakHits, ratio, sampleChars: sampleLen };
}

/**
 * Quick boolean check — returns true if text is likely mojibake.
 */
function isLikelyMojibake(text, opts) {
  return detectMojibake(text, opts).mojibake;
}

/**
 * Build a structured replacement output for mojibake content.
 *
 * @param {number} hits - Total mojibake pattern hits.
 * @param {number} strongHits - Strong pattern hits.
 * @param {number} weakHits - Weak character hits.
 * @param {number} sampleChars - Number of chars sampled.
 * @param {number} originalChars - Total original chars (before replacement).
 * @param {object} [opts]
 * @param {string} [opts.toolName] - Name of the tool that produced the output.
 * @param {string} [opts.helperName] - Name of the helper script (if any).
 * @returns {string}
 */
function buildMojibakeDroppedOutput(hits, strongHits, weakHits, sampleChars, originalChars, opts = {}) {
  const toolName = opts.toolName || "unknown";
  const helperName = opts.helperName || "";
  const keptChars = 500; // approx length of this output

  const lines = [
    "[HOOK_OUTPUT_DROPPED_MOJIBAKE]",
    "reason=encoding_corrupted_output",
    `mojibake_hits=${hits}`,
    `strong_hits=${strongHits}`,
    `weak_hits=${weakHits}`,
    `sample_chars=${sampleChars}`,
    `original_chars=${originalChars}`,
    `kept_chars=${keptChars}`,
    "",
    "The tool output appears to be mojibake and was omitted to protect context.",
    "Do not retry ad-hoc encoding reads.",
    "Use spec_read_file.py --query-file <query_file> --contract for specs, or read_file_slice.py for exact code ranges.",
  ];

  if (toolName) {
    lines.push(`tool_name=${toolName}`);
  }
  if (helperName) {
    lines.push(`helper_name=${helperName}`);
  }

  return lines.join("\n");
}

module.exports = {
  detectMojibake,
  isLikelyMojibake,
  buildMojibakeDroppedOutput,
  STRONG_RE,
  WEAK_RE,
  REPLACEMENT_CHAR_RE,
  PUA_RE,
  STRONG_FRAGMENTS,
};
