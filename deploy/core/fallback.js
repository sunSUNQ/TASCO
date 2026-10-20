"use strict";

// ============================================================================
// fallback.js — Compression Fallback Mechanism (Phase 2)
// ============================================================================
// Three-layer protection against bad compression:
//
//   success        -> adopt the compressed output;
//   timeout/error  -> keep the original output (native context);
//   low confidence -> keep the original output (native context).
//
// The runtime post hook does not yet emit a confidence score, so this module
// uses an explainable proxy: a "summary" that keeps less than 5% of a large
// source (or collapses below a minimum length) is treated as truncation /
// corruption rather than a valid compression. When the runtime provides an
// explicit confidence (e.g. from an RLM model), it wins and the 0.7 threshold
// from the review applies directly.
//
// Phase 3 upgrade — Evidence Coverage Score: a length heuristic alone cannot
// tell a good summary ("OrderService.updateStatus() calls
// PaymentClient.confirm() at line 234") from a generic one ("该文件负责处理
// 业务逻辑"). Coverage = substantive code symbols found in the compressed text
// (file paths / identifiers / line refs) that also appear in the original.
// ============================================================================

const CONFIDENCE_THRESHOLD = 0.7;
const MIN_COMPRESSION_RATIO = 0.05;
const MIN_COMPRESSION_CHARS = 80;
const LARGE_OUTPUT_CHARS = 8000;
const EVIDENCE_COVERAGE_THRESHOLD = 0.5;
const MIN_EVIDENCE_SYMBOLS = 3; // 代码富文本的摘要至少保留 3 个实质符号
const SMALL_SYMBOL_SOURCE = 8; // 源符号少于该数时，1 个符号即视为有证据
const MAX_EXPECTED_SYMBOLS = 300;

// 常见代码/英文停用词，避免“the/this/return/function”之类泛词抬高覆盖率。
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "with", "that", "this", "from", "have",
  "has", "had", "not", "but", "you", "all", "can", "will", "its", "his",
  "her", "our", "your", "they", "them", "into", "over", "then", "than",
  "function", "return", "const", "let", "var", "class", "import", "export",
  "default", "if", "else", "for", "while", "true", "false", "null",
  "undefined", "new", "async", "await", "try", "catch", "throw", "switch",
  "case", "break", "continue", "typeof", "instanceof", "extends", "super",
  "void", "static", "public", "private", "protected", "string", "number",
  "boolean", "object", "array", "file", "files", "line", "lines", "code",
  "logic", "handler", "handle", "service", "module", "functionality",
]);

const PATH_RE = /[\w./\\-]+\.(?:js|jsx|ts|tsx|py|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|kt|sql|json|yaml|yml|md|sh|bat|ps1)\b/gi;
const IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;
const LINE_REF_RE = /\b(?:line|L)\s*\d+\b|:\d{1,6}(?=\s|$)/gi;

function isStopword(token) {
  return STOPWORDS.has(token.toLowerCase());
}

/**
 * 从文本中提取实质代码符号：文件路径、行号引用、非停用词标识符。
 * 返回去重后的小写集合。
 */
function extractEvidenceSymbols(text) {
  const s = String(text || "");
  const set = new Set();
  const push = (m) => {
    const t = String(m || "").trim();
    if (t) set.add(t.toLowerCase());
  };
  for (const m of s.match(PATH_RE) || []) push(m);
  for (const m of s.match(LINE_REF_RE) || []) push(m);
  for (const m of s.match(IDENTIFIER_RE) || []) {
    if (!isStopword(m)) push(m);
  }
  return set;
}

/**
 * Evidence Coverage Score：压缩文本保留的实质符号 / 源文本实质符号。
 * coverage 与 found/expected 同时返回，供 telemetry 与报告使用。
 */
function evidenceCoverage({ originalText, compressedText }) {
  const original = extractEvidenceSymbols(originalText);
  const compressed = extractEvidenceSymbols(compressedText);
  const expected = Math.min(original.size, MAX_EXPECTED_SYMBOLS);
  let found = 0;
  for (const sym of compressed) {
    if (original.has(sym)) found += 1;
  }
  const coverage = expected > 0 ? found / expected : 1;
  return { coverage, found, expected };
}

// 覆盖率是否可接受：代码富文本必须有实质符号证据，泛泛而谈的摘要不算。
function coverageAcceptable({ found, expected }) {
  const minFound = expected < SMALL_SYMBOL_SOURCE ? 1 : MIN_EVIDENCE_SYMBOLS;
  if (found < minFound) return false;
  // 超大源文本（>150 个实质符号）要求至少 2% 的符号留存率，防止极端截断。
  if (expected > 150 && found / expected < 0.02) return false;
  return true;
}

/**
 * Code-aware Compression Fidelity（ECOR v1.1, Patch 2）：
 * 从原始输出提取可执行证据（文件路径 / 符号 / 行号），生成紧凑 evidence
 * footer 追加到压缩输出，保证摘要保留代码实体而不只是“总结这段内容”。
 */
function buildEvidenceFooter(originalText, options) {
  const opts = options || {};
  const maxSymbols = Number(opts.maxSymbols) || 24;
  const maxFiles = Number(opts.maxFiles) || 6;
  const maxLines = Number(opts.maxLines) || 8;
  const maxChars = Number(opts.maxChars) || 1200;
  const s = String(originalText || "");
  const pathLike = new RegExp(PATH_RE.source, "i");

  const files = [...extractEvidenceSymbols(s)]
    .filter((t) => pathLike.test(t))
    .slice(0, maxFiles);
  const lineRefs = (s.match(LINE_REF_RE) || [])
    .map((m) => m.toLowerCase())
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, maxLines);
  const identifiers = (s.match(IDENTIFIER_RE) || [])
    .filter((m) => !isStopword(m))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, maxSymbols);

  const parts = [];
  if (files.length) parts.push(`file: ${files.join(", ")}`);
  if (identifiers.length) parts.push(`symbols: ${identifiers.join(", ")}`);
  if (lineRefs.length) parts.push(`lines: ${lineRefs.join(", ")}`);
  if (parts.length === 0) return "";

  let footer = `\n\n[evidence] ${parts.join("; ")}`;
  if (footer.length > maxChars) {
    footer = footer.slice(0, maxChars - 3) + "...";
  }
  return footer;
}

/**
 * 压缩采用守卫的 rescue 路径：长度/置信度合格但符号覆盖不足（low_coverage）
 * 时，追加 evidence footer 后重新判定。截断（low_confidence）不回退到 rescue，
 * 直接保持原始输出。
 */
function rescueCompression({ raw, compressed, guard, footerOptions, minCoverage }) {
  const minCov = Number(minCoverage) || 0.5;
  const coverageValue =
    guard.coverage && typeof guard.coverage.coverage === "number"
      ? guard.coverage.coverage
      : 1;
  // 需要 rescue 的两种情况：低覆盖被拒（low_coverage），或已采用但保真度不足
  // （coverage < minCoverage）——后者是 ECOR v1.1.1 收紧的采用门槛。
  const needsRescue =
    (!guard.adopt && guard.reason === "low_coverage") ||
    (guard.adopt && coverageValue < minCov);
  if (!needsRescue) {
    return { adopted: guard.adopt, output: null, guard, footer: "" };
  }
  const footer = buildEvidenceFooter(raw, footerOptions);
  if (!footer) {
    return { adopted: false, output: null, guard, footer: "" };
  }
  const rescued = compressed + footer;
  // rescue 输出不允许比原始输出还大（否则直接保留 raw 更有价值）。
  if (rescued.length >= String(raw).length) {
    return {
      adopted: false,
      output: null,
      guard,
      footer,
      rejectedReason: "rescue_larger_than_raw",
    };
  }
  const reGuard = shouldAdoptCompression({
    originalLength: String(raw).length,
    compressedLength: rescued.length,
    originalText: raw,
    compressedText: rescued,
  });
  return {
    adopted: reGuard.adopt,
    output: reGuard.adopt ? rescued : null,
    guard: reGuard,
    footer,
  };
}

function compressionConfidence({ originalLength, compressedLength }) {
  const o = Number(originalLength) || 0;
  const c = Number(compressedLength) || 0;
  if (o <= 0) return c > 0 ? 1 : 0;
  if (c <= 0) return 0;
  if (o < LARGE_OUTPUT_CHARS) return 1; // small outputs are not compressed anyway
  const ratio = c / o;
  if (ratio < MIN_COMPRESSION_RATIO) {
    return Math.round((ratio / MIN_COMPRESSION_RATIO) * 100) / 100;
  }
  if (c < MIN_COMPRESSION_CHARS) {
    return Math.round((c / MIN_COMPRESSION_CHARS) * 100) / 100;
  }
  return 1;
}

function shouldAdoptCompression({
  originalLength,
  compressedLength,
  explicitConfidence,
  originalText,
  compressedText,
}) {
  const confidence =
    explicitConfidence !== undefined
      ? Math.round(Number(explicitConfidence) * 100) / 100
      : compressionConfidence({ originalLength, compressedLength });
  const coverage =
    originalText !== undefined && compressedText !== undefined
      ? evidenceCoverage({ originalText, compressedText })
      : null;
  let adopt = confidence >= CONFIDENCE_THRESHOLD;
  let reason = adopt ? "ok" : "low_confidence";
  if (adopt && coverage && !coverageAcceptable(coverage)) {
    adopt = false;
    reason = "low_coverage";
  }
  return {
    adopt,
    confidence,
    coverage,
    reason,
  };
}

// Narrow guard for task-classified FILTER search only. It evaluates the
// completeness of retained actionable evidence, not retention of arbitrary
// duplicate raw matches. Callers must still keep STATISTICS/ENUMERATION Native.
function searchFilterEvidenceGuard({ candidate, maxChars = 1800 }) {
  const text = String(candidate || "");
  const items = [...text.matchAll(/(^[^\n]+):L(\d+)\nsymbol:\s*([^\n]+)\nmatch:\s*([^\n]+)/gm)]
    .map((m) => ({ file: m[1], line: m[2], symbol: m[3], match: m[4] }));
  const omitted = /\[omitted:\s*(\d+) matches across (\d+) files\]/.exec(text);
  const uniqueFiles = new Set(items.map((i) => i.file));
  const uniqueMatches = new Set(items.map((i) => i.match));
  const valid = items.filter((i) => i.file && i.line && i.match).length;
  const adopt =
    text.length <= maxChars &&
    items.length >= 3 && items.length <= 6 &&
    valid === items.length &&
    uniqueFiles.size === items.length &&
    uniqueMatches.size === items.length &&
    Boolean(omitted);
  return {
    adopt,
    reason: adopt ? "filter_evidence_ok" : "filter_evidence_invalid",
    evidence: {
      retained_matches: items.length,
      retained_unique_files: uniqueFiles.size,
      evidence_valid_count: valid,
      duplicate_removed: uniqueMatches.size === items.length,
      omitted_matches: omitted ? Number(omitted[1]) : null,
      omitted_files: omitted ? Number(omitted[2]) : null,
      candidate_chars: text.length,
    },
  };
}

// 后置 hook 出错/超时时返回的 fallback 原因（fail-open 到 native context）。
function fallbackReasonForError(err) {
  const code = err && err.code;
  if (code === "ETIMEDOUT") return "timeout";
  if (err && String(err.message || "").includes("timed out")) return "timeout";
  return "hook_error";
}

module.exports = {
  CONFIDENCE_THRESHOLD,
  MIN_COMPRESSION_RATIO,
  MIN_COMPRESSION_CHARS,
  LARGE_OUTPUT_CHARS,
  EVIDENCE_COVERAGE_THRESHOLD,
  extractEvidenceSymbols,
  evidenceCoverage,
  coverageAcceptable,
  buildEvidenceFooter,
  rescueCompression,
  compressionConfidence,
  shouldAdoptCompression,
  searchFilterEvidenceGuard,
  fallbackReasonForError,
};
