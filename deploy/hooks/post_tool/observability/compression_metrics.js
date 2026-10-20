// ============================================================================
// observability/compression_metrics.js — 压缩效果统计口径(纯计算,无 I/O)
// ============================================================================
// 第一阶段「压缩效果可观测性」:
//   统一单次压缩事件的统计口径,与策略实现解耦。
// 所有函数为纯函数:不依赖 payload、文件系统或运行时状态,保证
// observability failure 不影响 TASCO 正常工作。
// ============================================================================

/**
 * 轻量 token 估算,复用项目现有口径(context_dump.js estimateTokens):
 *   中文/全角字符按 1 token/字符,其余 ASCII 按 4 字符 ≈ 1 token,向上取整。
 * 本阶段不引入强模型绑定 tokenizer;估算值一律标记 token_mode=estimated,
 * 不允许伪装成真实 token usage。
 */
function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const chineseChars = (s.match(/[一-鿿]/g) || []).length;
  const asciiChars = s.length - chineseChars;
  return Math.ceil(chineseChars + asciiChars / 4);
}

/**
 * 按统一口径计算单次压缩事件的核心指标。
 *
 * 口径定义(与策略无关):
 *   saved_chars   = max(0, before_chars - delivered_chars)
 *   reduction_rate = before_chars > 0 ? saved_chars / before_chars : 0
 *   delta_chars    = delivered_chars - before_chars  (负收益诊断,不伪造负 saved)
 *
 * @param {object} params
 * @param {string} params.beforeText      TASCO 接收到的原始 Tool Result 正文
 * @param {string|null} params.candidateText 策略生成的压缩 candidate 正文(无则 null)
 * @param {string} params.deliveredText   最终真正交付给 Agent 的 Tool Result 正文
 * @returns {object} 指标对象(candidate_chars 无 candidate 时为 null)
 */
function computeEvent({ beforeText, candidateText, deliveredText }) {
  const before = String(beforeText || "");
  const candidate = candidateText == null ? null : String(candidateText);
  const delivered = String(deliveredText || "");

  const beforeChars = before.length;
  const candidateChars = candidate == null ? null : candidate.length;
  const deliveredChars = delivered.length;

  const savedChars = Math.max(0, beforeChars - deliveredChars);
  const reductionRate = beforeChars > 0 ? savedChars / beforeChars : 0;
  const deltaChars = deliveredChars - beforeChars;

  const beforeTokens = estimateTokens(before);
  const candidateTokens = candidate == null ? null : estimateTokens(candidate);
  const deliveredTokens = estimateTokens(delivered);
  const savedTokens = Math.max(0, beforeTokens - deliveredTokens);

  return {
    before_chars: beforeChars,
    candidate_chars: candidateChars,
    delivered_chars: deliveredChars,
    saved_chars: savedChars,
    reduction_rate: reductionRate,
    delta_chars: deltaChars,
    before_tokens_est: beforeTokens,
    candidate_tokens_est: candidateTokens,
    delivered_tokens_est: deliveredTokens,
    saved_tokens_est: savedTokens,
  };
}

/**
 * 事件状态分类。统一三种可区分状态:
 *   selected = 策略确实生成了 candidate
 *   applied  = candidate 最终真正交付给 Agent
 *   fallback = 策略选中但最终交付原文(candidate 被丢弃/拒绝)
 * reason 由调用点给出,指明交付路径:
 *   "applied"                       -> candidate 真正交付
 *   "insufficient_savings"          -> output() 拒绝替换(节省不足)
 *   "archive_receipt_erased_savings"-> output() 拒绝替换(归档回执抹掉节省)
 *   "candidate_discarded"           -> 策略生成 candidate 但未提交给 output()
 *   "guidance" | "native"           -> 未选中压缩
 *
 * @param {boolean} selected  是否生成了 candidate
 * @param {string} reason     交付路径原因
 * @returns {{selected: boolean, applied: boolean, fallback: boolean}}
 */
function classifyEvent({ selected, reason }) {
  if (!selected) {
    return { selected: false, applied: false, fallback: false };
  }
  const applied = reason === "applied";
  return { selected: true, applied, fallback: !applied };
}

function createCompressionMetrics(_deps) {
  return { estimateTokens, computeEvent, classifyEvent };
}

module.exports = { createCompressionMetrics, estimateTokens, computeEvent, classifyEvent };
