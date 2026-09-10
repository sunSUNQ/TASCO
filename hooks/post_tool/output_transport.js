function createOutputTransport(deps) {
  const {
    fs,
    path,
    BASE_DIR,
    log,
    createOutputArchiver,
    extractToolText,
    extractToolName,
    loadState,
    normalizeAfterToolState,
    saveState,
    metrics,
  } = deps;
const { sessionPath } = require("../guard_core/runtime_paths");
let activePayload = null;

function describeShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") return `object:${Object.keys(value).sort().join(",")}`;
  return typeof value;
}

function appendPostToolDiagnostic(record) {
  try {
    const diagnosticFile = sessionPath("posttool_replacements.jsonl");
    fs.appendFileSync(
      diagnosticFile,
      JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n",
      "utf8"
    );
  } catch (error) {
    log(`posttool diagnostic write failed error=${String(error)}`);
  }
}

const { archiveOriginalToolOutput } = createOutputArchiver({
  getArchiveDir: () => sessionPath("tool_output_archive"),
  log,
  maxArchiveFiles: process.env.CODE_GUARD_MAX_TOOL_ARCHIVES || "100",
});
function buildUpdatedToolOutput(payload, compressedText) {
  const original = payload?.tool_response ?? payload?.toolResponse ?? payload?.response;
  if (!original || typeof original === "string") return compressedText;

  let updated;
  try {
    updated = structuredClone(original);
  } catch (_e) {
    updated = JSON.parse(JSON.stringify(original));
  }

  if (typeof updated.content === "string") {
    updated.content = compressedText;
    if (typeof updated.numLines === "number") updated.numLines = compressedText.split(/\r?\n/).length;
    return updated;
  }
  if (typeof updated.stdout === "string") {
    updated.stdout = compressedText;
    return updated;
  }
  if (updated.file && typeof updated.file === "object" && typeof updated.file.content === "string") {
    updated.file.content = compressedText;
    if (typeof updated.file.numLines === "number") updated.file.numLines = compressedText.split(/\r?\n/).length;
    return updated;
  }
  if (typeof updated.output === "string") {
    updated.output = compressedText;
    return updated;
  }
  if (Array.isArray(updated.content)) {
    const textBlock = updated.content.find((block) => block && typeof block === "object" && typeof block.text === "string");
    if (textBlock) {
      textBlock.text = compressedText;
      return updated;
    }
  }
  return compressedText;
}

// 可观测性打点边界:硬 fail-open。
// 任何 metrics 异常(含其内部日志写入失败)都不得向 output() 外抛,
// Tool Result 交付路径不受 observability 影响。
function safeMetricsFinalize(params) {
  try {
    if (metrics && typeof metrics.finalize === "function") {
      metrics.finalize(params);
    }
  } catch (_e) {
    // observability failure must not block tool result delivery.
  }
}

function output(text = "", replaceOutput = false) {
  const result = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse"
    }
  };

  if (text && text.trim()) {
    if (replaceOutput) {
      const rawText = extractToolText(activePayload || {});
      if (rawText && text.length >= rawText.length * 0.8) {
        log(`replacement rejected tool=${extractToolName(activePayload || {})}, reason=insufficient_savings, raw_chars=${rawText.length}, candidate_chars=${text.length}`);
        appendPostToolDiagnostic({
          event: "PostToolUse",
          tool_name: activePayload?.claude_tool_name || activePayload?.tool_name || activePayload?.toolName || "unknown_tool",
          normalized_tool_name: extractToolName(activePayload || {}),
          tool_use_id: activePayload?.tool_use_id || activePayload?.toolUseId || "",
          raw_chars: rawText.length,
          compressed_chars: text.length,
          replacement_emitted: false,
          additional_context_emitted: false,
          rejection_reason: "insufficient_savings",
        });
        // 可观测性打点:替换被拒 → delivered 为原始正文,记 fallback。
        safeMetricsFinalize({ text, replaceOutput: true, delivered: rawText, reason: "insufficient_savings" });
        return console.log(JSON.stringify(result));
      }
      const archive = archiveOriginalToolOutput(activePayload || {}, rawText);
      // 透明治理：归档回执是 telemetry，只进内部诊断（posttool_replacements.jsonl
      // 与日志），不再注入模型可见输出。
      const recoveryReceipt = "";
      const replacementText = text + recoveryReceipt;
      if (rawText && replacementText.length >= rawText.length * 0.8) {
        log(`replacement rejected tool=${extractToolName(activePayload || {})}, reason=archive_receipt_erased_savings, raw_chars=${rawText.length}, candidate_chars=${replacementText.length}`);
        // 可观测性打点:替换被拒 → delivered 为原始正文,记 fallback。
        safeMetricsFinalize({ text, replaceOutput: true, delivered: rawText, reason: "archive_receipt_erased_savings" });
        return console.log(JSON.stringify(result));
      }
      const updated = buildUpdatedToolOutput(activePayload, replacementText);
      result.hookSpecificOutput.updatedToolOutput = updated;
      const original = activePayload?.tool_response ?? activePayload?.toolResponse ?? activePayload?.response;
      log(`replacement emitted tool=${extractToolName(activePayload || {})}, raw_chars=${rawText.length}, compressed_chars=${replacementText.length}, raw_shape=${describeShape(original)}, returned_shape=${describeShape(updated)}, archive=${archive?.archivePath || ""}, additional_context=false`);
      appendPostToolDiagnostic({
        event: "PostToolUse",
        tool_name: activePayload?.claude_tool_name || activePayload?.tool_name || activePayload?.toolName || "unknown_tool",
        normalized_tool_name: extractToolName(activePayload || {}),
        tool_use_id: activePayload?.tool_use_id || activePayload?.toolUseId || "",
        raw_chars: extractToolText(activePayload || {}).length,
        compressed_chars: replacementText.length,
        raw_shape: describeShape(original),
        returned_shape: describeShape(updated),
        replacement_emitted: true,
        additional_context_emitted: false,
        archive_path: archive?.archivePath || "",
        raw_sha256: archive?.sha256 || "",
      });
      // 可观测性打点:替换真正交付 → delivered 为最终交付正文。
      safeMetricsFinalize({ text, replaceOutput: true, delivered: replacementText, reason: "applied" });
    } else {
      result.hookSpecificOutput.additionalContext = text;
      log(`guidance emitted tool=${extractToolName(activePayload || {})}, chars=${text.length}, replacement=false`);
      appendPostToolDiagnostic({
        event: "PostToolUse",
        tool_name: activePayload?.claude_tool_name || activePayload?.tool_name || activePayload?.toolName || "unknown_tool",
        normalized_tool_name: extractToolName(activePayload || {}),
        tool_use_id: activePayload?.tool_use_id || activePayload?.toolUseId || "",
        raw_chars: extractToolText(activePayload || {}).length,
        compressed_chars: 0,
        guidance_chars: text.length,
        replacement_emitted: false,
        additional_context_emitted: true,
      });
      // 可观测性打点:guidance 不替换 Tool Result → delivered 为原始正文(native)。
      safeMetricsFinalize({ text, replaceOutput: false, delivered: extractToolText(activePayload || {}), reason: "guidance" });
    }
  } else {
    // 可观测性打点:未替换/未注入 → delivered 为原始正文(native,或策略 candidate 被丢弃)。
    safeMetricsFinalize({ text: "", replaceOutput, delivered: extractToolText(activePayload || {}), reason: "native" });
  }

  console.log(JSON.stringify(result));
}

function outputGuidanceOnce(text) {
  const guidance = String(text || "").trim();
  if (!guidance) return output();
  const state = normalizeAfterToolState(loadState());
  state.post_tool_guidance_state = state.post_tool_guidance_state || {};
  const sessionKey = String(activePayload?.session_id || activePayload?.sessionId || "default");
  const previous = state.post_tool_guidance_state[sessionKey] || {};
  if (previous.text === guidance) {
    log(`guidance suppressed tool=${extractToolName(activePayload || {})}, reason=duplicate, chars=${guidance.length}`);
    return output();
  }
  state.post_tool_guidance_state[sessionKey] = {
    text: guidance,
    emitted_at: new Date().toISOString(),
  };
  saveState(state);
  return output(guidance);
}

  function setActivePayload(payload) {
    activePayload = payload;
  }

  return { output, outputGuidanceOnce, setActivePayload };
}

module.exports = { createOutputTransport };
