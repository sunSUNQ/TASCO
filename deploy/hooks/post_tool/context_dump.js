function createContextDump(deps) {
  const {
    fs,
    path,
    DUMP_AFTERTOOL_CONTEXT,
    getDumpDir,
    MAX_AFTERTOOL_DUMP_CHARS,
    MAX_TRANSCRIPT_DELTA_ENTRIES,
    normalizeAfterToolState,
    loadState,
    saveState,
    log,
  } = deps;
function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (_e) {
    return String(obj);
  }
}

function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const chineseChars = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const asciiChars = s.length - chineseChars;
  return Math.ceil(chineseChars + asciiChars / 4);
}

function getTranscriptPath(payload) {
  return (
    payload.transcript_path ||
    payload.transcriptPath ||
    payload.transcript ||
    ""
  );
}

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_e) {
    // ignore
  }
}

function ensureDumpDir() {
  if (!DUMP_AFTERTOOL_CONTEXT) {
    return;
  }
  fs.mkdirSync(getDumpDir(), { recursive: true });
}

function safeFileName(name) {
  return String(name || "unknown")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function tryParseJsonLine(line) {
  try {
    return { ok: true, obj: JSON.parse(line) };
  } catch (_e) {
    return { ok: false, obj: null };
  }
}

function normalizeContextText(text) {
  return String(text || "")
    // 去掉 Process Group PGID 这类运行元数据
    .replace(/\n?Process Group PGID:\s*\d+\s*/gi, "")
    // 去掉 Output: 后面过多空行
    .replace(/Output:\s*\n{3,}/g, "Output:\n")
    // 压缩行尾空格
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    // 压缩过多空行
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractFunctionResponseTextFromObj(obj) {
  const results = [];

  function visit(x) {
    if (!x || typeof x !== "object") {
      return;
    }

    if (Array.isArray(x)) {
      for (const item of x) visit(item);
      return;
    }

    if (x.functionResponse && x.functionResponse.response) {
      const resp = x.functionResponse.response;

      if (resp.output) {
        results.push(String(resp.output));
      }

      if (resp.error) {
        results.push(String(resp.error));
      }

      if (resp.llmContent) {
        results.push(String(resp.llmContent));
      }

      if (resp.returnDisplay) {
        results.push(String(resp.returnDisplay));
      }
    }

    for (const v of Object.values(x)) {
      visit(v);
    }
  }

  visit(obj);

  return normalizeContextText(results.join("\n\n"));
}

function extractToolCallsResponseText(obj) {
  const results = [];

  if (!obj || typeof obj !== "object") {
    return "";
  }

  const toolCalls = Array.isArray(obj.toolCalls) ? obj.toolCalls : [];

  for (const call of toolCalls) {
    const callParts = [];

    if (call.name) {
      callParts.push(`[tool] ${call.name}`);
    }

    if (call.args && call.args.command) {
      callParts.push(`[command] ${call.args.command}`);
    }

    if (call.status) {
      callParts.push(`[status] ${call.status}`);
    }

    const responseText = extractFunctionResponseTextFromObj(call.result || call.response || call);
    if (responseText) {
      callParts.push(responseText);
    }

    const compact = normalizeContextText(callParts.join("\n"));
    if (compact) {
      results.push(compact);
    }
  }

  return normalizeContextText(results.join("\n\n"));
}

function extractRealContextText(obj, fallbackLine) {
  if (!obj) {
    return normalizeContextText(fallbackLine || "");
  }

  // 1. user entry usually contains functionResponse results.
  const functionResponseText = extractFunctionResponseTextFromObj(obj);
  if (functionResponseText) {
    return functionResponseText;
  }

  // 2. gemini entry may contain toolCalls with results.
  const toolCallsText = extractToolCallsResponseText(obj);
  if (toolCallsText) {
    return toolCallsText;
  }

  // 3. assistant/model natural language content.
  if (typeof obj.content === "string" && obj.content.trim()) {
    return normalizeContextText(obj.content);
  }

  // 4. some transcript schemas use text/message.
  if (typeof obj.text === "string" && obj.text.trim()) {
    return normalizeContextText(obj.text);
  }

  if (typeof obj.message === "string" && obj.message.trim()) {
    return normalizeContextText(obj.message);
  }

  // 5. Ignore pure metadata entries.
  return "";
}


function detectDumpEntryRole(obj, rawLine) {
  if (!obj) {
    return "raw";
  }

  if (obj.role) {
    return String(obj.role);
  }

  if (obj.type) {
    return String(obj.type);
  }

  const lower = String(rawLine || safeJsonStringify(obj)).toLowerCase();

  if (lower.includes('"role":"user"')) return "user";
  if (lower.includes('"role":"assistant"') || lower.includes('"role":"model"')) return "assistant";
  if (lower.includes("tool_response") || lower.includes("toolresult") || lower.includes("tool_result")) return "tool_result";
  if (lower.includes("tool_call") || lower.includes("toolcall") || lower.includes("functioncall")) return "tool_call";

  return "unknown";
}

function readTranscriptEntriesForDump(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return [];
  }

  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  return lines
    .map((line, index) => {
      const parsed = tryParseJsonLine(line);
      const obj = parsed.ok ? parsed.obj : null;

      const realContextText = parsed.ok
        ? extractRealContextText(obj, line)
        : normalizeContextText(line);

      return {
        index,
        role: detectDumpEntryRole(obj, line),
        contextText: realContextText,
        contextChars: realContextText.length,
        contextTokens: estimateTokens(realContextText)
      };
    })
    // 只保留真正有上下文内容的 entry。
    .filter(entry => entry.contextText && entry.contextText.trim());
}

function formatDumpEntry(entry) {
  return [
    `===== CONTEXT_ENTRY ${entry.index} =====`,
    `role: ${entry.role}`,
    `context_chars: ${entry.contextChars}`,
    `context_tokens_est: ${entry.contextTokens}`,
    ``,
    `[CONTEXT_TEXT]`,
    String(entry.contextText || ""),
    ``
  ].join("\n");
}

function writeDumpFile(prefix, text, meta = {}) {
  if (!DUMP_AFTERTOOL_CONTEXT) {
    return "";
  }

  ensureDumpDir();

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${ts}_${safeFileName(prefix)}.txt`;
  const dumpPath = path.join(getDumpDir(), fileName);

  const raw = String(text || "");
  const clipped =
    raw.length > MAX_AFTERTOOL_DUMP_CHARS
      ? raw.slice(0, MAX_AFTERTOOL_DUMP_CHARS) +
        `\n\n...[DUMP_TRUNCATED raw_chars=${raw.length} max=${MAX_AFTERTOOL_DUMP_CHARS}]...\n`
      : raw;

  const header = [
    `[AFTERTOOL_CONTEXT_DUMP]`,
    `time: ${new Date().toISOString()}`,
    `prefix: ${prefix}`,
    `raw_chars: ${raw.length}`,
    `written_chars: ${clipped.length}`,
    `tokens_est: ${estimateTokens(raw)}`,
    `meta: ${safeJsonStringify(meta)}`,
    ``,
    `========================================`,
    ``
  ].join("\n");

  fs.writeFileSync(dumpPath, header + clipped, "utf8");
  return dumpPath;
}

function getTranscriptLineCount(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return 0;
  }

  return fs.readFileSync(transcriptPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .length;
}

function dumpAfterToolContext(payload, toolName, toolText, rawChars) {
  if (!DUMP_AFTERTOOL_CONTEXT) {
    return {};
  }

  const transcriptPath = getTranscriptPath(payload);
  const state = normalizeAfterToolState(loadState());

  if (!state.aftertool_dump_state) {
    state.aftertool_dump_state = {};
  }

  const dumpState = state.aftertool_dump_state;
  const sessionKey =
    payload.session_id ||
    payload.sessionId ||
    payload.run_id ||
    payload.runId ||
    "default";

  if (!dumpState[sessionKey]) {
    dumpState[sessionKey] = {
      lastTranscriptEntries: 0,
      lastDumpAt: 0
    };
  }

  const item = dumpState[sessionKey];

  // 等一下 transcript flush。否则 AfterTool 触发时 transcript 可能还没写完。
  sleepMs(300);

  const rawAfterEntries = getTranscriptLineCount(transcriptPath);
  const beforeEntries = Number(item.lastTranscriptEntries || 0);

  const allContextEntries = readTranscriptEntriesForDump(transcriptPath);

  const deltaEntries = allContextEntries
    .filter(e => e.index >= beforeEntries && e.index < rawAfterEntries)
    .slice(-MAX_TRANSCRIPT_DELTA_ENTRIES);

  const cleanedToolText = normalizeContextText(toolText || "");

  const toolOutputDumpPath = writeDumpFile(
    `tool_output_${toolName}`,
    cleanedToolText,
    {
      tool_name: toolName,
      raw_chars: rawChars,
      cleaned_chars: cleanedToolText.length,
      transcript_path: transcriptPath,
      session_key: sessionKey,
      dump_mode: "clean_tool_output"
    }
  );

  let transcriptDeltaDumpPath = "";

  if (deltaEntries.length > 0) {
    const body = deltaEntries.map(formatDumpEntry).join("\n\n");

    transcriptDeltaDumpPath = writeDumpFile(
      `real_context_delta_${toolName}_entries_${beforeEntries}_${rawAfterEntries}`,
      body,
      {
        tool_name: toolName,
        transcript_path: transcriptPath,
        session_key: sessionKey,
        before_entries: beforeEntries,
        after_entries: rawAfterEntries,
        delta_entries_total: rawAfterEntries - beforeEntries,
        dumped_entries: deltaEntries.length
      }
    );
  }

  item.lastTranscriptEntries = rawAfterEntries;
  item.lastDumpAt = Date.now();
  dumpState[sessionKey] = item;

  state.aftertool_dump_state = dumpState;
  saveState(state);

  log(
    `aftertool context dumped tool=${toolName}, toolOutput=${toolOutputDumpPath || ""}, transcriptDelta=${transcriptDeltaDumpPath || ""}, beforeEntries=${beforeEntries}, afterEntries=${rawAfterEntries}`
  );

  return {
    toolOutputDumpPath,
    transcriptDeltaDumpPath,
    transcriptPath,
    beforeEntries,
    afterEntries: rawAfterEntries,
    dumpedEntries: deltaEntries.length
  };
}

  return { safeJsonStringify, dumpAfterToolContext };
}

module.exports = { createContextDump };
