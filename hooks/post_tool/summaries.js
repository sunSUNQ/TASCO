function createSummaries(deps) {
  const {
    normalizeToolName,
    extractCommand,
    hasShellError,
    isReplaceFailedText,
    loadState,
    normalizeAfterToolState,
    ensureObject,
    ensureArray,
    ensureSearchGovernanceState,
    addUnique,
    addUniqueLimited,
    syncTopLevelEvidence,
    saveState,
    log,
    extractFilePathsFromSearchText,
    extractLikelySymbolsFromSearchText,
    shortenRepoPath,
  } = deps;
function isHookPreCompressed(text) {
  // Detect outputs from our hook scripts that already have built-in compression.
  // These scripts enforce their own output limits (e.g., smart_read_file.py caps at 2000 chars,
  // read_file_slice.py at 100 lines, safe_replace.py at 120 diff lines).
  // Re-compressing them with RLM is wasteful since they're already compact.
  const markers = [
    "[SMART_READ_RESULT]",
    "[SMART_READ]",
    "[READ_FILE_SLICE_RESULT]",
    "[SPEC_INDEX_COMPACT]",
    "[SPEC_CONTRACT]",
    "[SPEC_CONTRACT_READY]",
    "[SPEC_INDEX_CACHE_HIT]",
    "[SPEC_CONTRACT_CACHE_HIT]",
    "[SAFE_REPLACE_RESULT]",
    "[REPO_MAP]",
    "[REPO_MAP_RESULT]",
    "[READ_RANGE]",
  ];

  const raw = String(text || "");
  for (const marker of markers) {
    if (raw.includes(marker)) {
      return true;
    }
  }

  // Also detect hook script command references in the text
  const hookScripts = [
    "smart_read_file.py",
    "read_file_slice.py",
    "spec_read_file.py",
    "safe_replace.py",
    "repo_map.py",
  ];

  for (const script of hookScripts) {
    if (raw.includes(script)) {
      return true;
    }
  }

  return false;
}

function shouldSkipAfterToolCompression(toolName, text) {
  const name = String(toolName || "").toLowerCase();
  const chars = String(text || "").length;

  if (chars < 3000) {
    return true;
  }

  if (
    name.includes("update_topic") ||
    name.includes("write_file")
  ) {
    return true;
  }

  // Skip RLM compression for already-compressed hook script outputs.
  // These scripts have built-in output limits and re-compressing them is wasteful.
  if (isHookPreCompressed(text)) {
    return true;
  }

  if (
    (
      String(text || "").includes("[safe_replace]") ||
      String(text || "").includes("[SAFE_REPLACE_RESULT]")
    ) &&
    !isReplaceFailedText(text)
  ) {
    return true;
  }

  return false;
}

function quickShellSummary(toolName, text) {
  const lines = text.split(/\r?\n/);

  const raw = String(text || "");

  if (
    raw.includes("smart_read_file.py") ||
    raw.includes("[SMART_READ]") ||
    raw.includes("[SMART_READ_RESULT]")
  ) {
    return quickSmartReadSummary(raw);
  }

  const important = lines.filter((line) => {
    return (
      /traceback/i.test(line) ||
      /assertionerror/i.test(line) ||
      /\bfailed\b/i.test(line) ||
      /\berror\b/i.test(line) ||
      /exception/i.test(line) ||
      /file .* line /i.test(line) ||
      /npm err!/i.test(line) ||
      /fatal:/i.test(line) ||
      /command failed/i.test(line) ||
      /permission denied/i.test(line) ||
      /cannot find module/i.test(line)
    );
  });

  const selected =
    important.length > 0
      ? important.slice(0, 80).join("\n")
      : text.slice(0, 1200) +
        "\n...[truncated]...\n" +
        text.slice(-1200);

  return `
[Shell 工具输出快速摘要]

工具名称: ${toolName}
原始长度: ${text.length} chars
处理方式: error-focused extraction

关键输出:
${selected}
`.trim();
}

function quickSmartReadSummary(text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/);

  const kept = [];
  let inSliceTargets = false;
  let inSymbolSummary = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 保留文件、模式、查询等头部信息
    if (
      trimmed.startsWith("[SMART_READ]") ||
      trimmed.startsWith("[SMART_READ_RESULT]") ||
      trimmed.startsWith("tool:") ||
      trimmed.startsWith("tool=") ||
      trimmed.startsWith("file:") ||
      trimmed.startsWith("file=") ||
      trimmed.startsWith("mode:") ||
      trimmed.startsWith("mode=") ||
      trimmed.startsWith("query:") ||
      trimmed.startsWith("query=") ||
      trimmed.startsWith("language:") ||
      trimmed.startsWith("symbol_summary:") ||
      trimmed.startsWith("classes:") ||
      trimmed.startsWith("functions:")
    ) {
      kept.push(line);
      continue;
    }

    // 保留 slice_targets 区域
    if (
      trimmed.includes("slice_targets") ||
      trimmed.includes("[slice_targets]") ||
      trimmed.includes("SLICE_TARGETS")
    ) {
      inSliceTargets = true;
      kept.push(line);
      continue;
    }

    if (inSliceTargets) {
      // 空行后结束，避免把后续代码片段也带进去
      if (!trimmed) {
        inSliceTargets = false;
        kept.push(line);
        continue;
      }

      kept.push(line);
      continue;
    }

    // 兼容 symbol summary 标题
    if (
      trimmed.includes("symbol_summary") ||
      trimmed.includes("[symbol_summary]") ||
      trimmed.includes("SYMBOL_SUMMARY")
    ) {
      inSymbolSummary = true;
      kept.push(line);
      continue;
    }

    if (inSymbolSummary) {
      if (!trimmed) {
        inSymbolSummary = false;
        kept.push(line);
        continue;
      }

      // 只保留较短的摘要行，跳过代码行
      if (trimmed.length <= 220 && !looksLikeCodeLine(trimmed)) {
        kept.push(line);
      }

      continue;
    }

    // 保留明确的行号范围
    if (
      /L\d+\s*-\s*L?\d+/.test(trimmed) ||
      /start_line|end_line|hit_line/.test(trimmed)
    ) {
      kept.push(line);
      continue;
    }
  }

  const compact = kept.join("\n").trim();

  if (!compact) {
    return `
[smart_read_file summarized]
raw_chars=${raw.length}
kept=none
note=Output looked like code snippets only. Omitted to avoid context bloat.
next=Use read_file_slice.py with exact line ranges if code is needed.
`.trim();
  }

  return `
[smart_read_file summarized]
raw_chars=${raw.length}
kept_chars=${compact.length}
rule=keep structure and slice targets; omit code snippets

${compact}

[next]
Use read_file_slice.py only for the selected ranges needed for edit/test.
`.trim();
}

function extractReadRangesFromText(text) {
  const raw = String(text || "");
  const ranges = [];

  const patterns = [
    /(?:start_line|startLine)\s*[=:]\s*(\d+)[,\s]+(?:end_line|endLine)\s*[=:]\s*(\d+)/gi,
    /L(\d+)\s*-\s*L?(\d+)/gi,
    /lines?\s+(\d+)\s*-\s*(\d+)/gi
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(raw)) !== null) {
      const start = Number(m[1]);
      const end = Number(m[2]);

      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start > 0 &&
        end >= start
      ) {
        ranges.push({ startLine: start, endLine: end });
      }

      if (ranges.length >= 20) break;
    }
  }

  return ranges.slice(0, 20);
}

function recordRecentSliceFromAfterTool(state, filePath, startLine, endLine) {
  const file = String(filePath || "").replace(/[\\/]+/g, "\\").toLowerCase();

  if (!file || !startLine || !endLine) {
    return;
  }

  state.replace_policy_state = ensureObject(state.replace_policy_state);
  state.replace_policy_state.recentSlices = ensureArray(
    state.replace_policy_state.recentSlices
  );

  state.replace_policy_state.recentSlices.push({
    file,
    startLine: Number(startLine),
    endLine: Number(endLine),
    updatedAt: Date.now()
  });

  state.replace_policy_state.recentSlices =
    state.replace_policy_state.recentSlices.slice(-100);

  state.search_policy_state = ensureObject(state.search_policy_state);
  state.search_policy_state.readRangeRecords = ensureArray(
    state.search_policy_state.readRangeRecords
  );

  state.search_policy_state.readRangeRecords.push({
    file,
    startLine: Number(startLine),
    endLine: Number(endLine),
    updatedAt: Date.now(),
    source: "aftertool_read_slice",
  });

  state.search_policy_state.readRangeRecords =
    state.search_policy_state.readRangeRecords.slice(-500);
}

function updateReadEvidenceFromOutput(payload, toolName, toolText) {
  const state = normalizeAfterToolState(loadState());

  const command = extractCommand(payload);
  const text = String(toolText || "");
  const lowerText = text.toLowerCase();

  if (
    text.includes("[READ_FILE_SLICE_RESULT]") &&
    (
      lowerText.includes("status: empty") ||
      lowerText.includes("status: failed")
    )
  ) {
    log(`skip read evidence update because read_file_slice status is not success`);
    return state;
  }

  const isReadFileSliceSuccess =
    command.includes("read_file_slice.py") &&
    (
      lowerText.includes("status: success") ||
      text.includes("[READ_RANGE]") ||
      text.includes("[READ_FILE_SLICE_RESULT]")
    );

  if (isReadFileSliceSuccess) {
    state.replace_policy_state = ensureObject(state.replace_policy_state);

    if (state.replace_policy_state.lastReplaceFailed) {
      state.replace_policy_state.recoverySliceReady = true;
      state.replace_policy_state.recoverySliceReadyAt = Date.now();

      log(
        `replace recovery slice ready after read_file_slice success, command=${command.slice(0, 300)}`
      );
    }
  }

  if (
    text.includes("[read_file_slice]") &&
    lowerText.includes("status: failed")
  ) {
    log(`skip read evidence update because legacy read_file_slice failed`);
    return state;
  }

  const combined = `${command}\n${text}`;

  const files = extractFilePathsFromSearchText(combined);
  const symbols = extractLikelySymbolsFromSearchText(combined);
  const ranges = extractReadRangesFromText(combined);

  const sg = ensureSearchGovernanceState(state);

  const isCodeReadHelper =
    command.includes("smart_read_file.py") ||
    command.includes("read_file_slice.py") ||
    toolName === "read_file";

  const filteredFiles = isCodeReadHelper
    ? files.filter(f => /\.(c|cc|cpp|h|hpp|hh|py|js|ts|java|go|rs|proto|cmake)$/i.test(f))
    : files;

  for (const f of filteredFiles) {
    addUnique(sg.targetFiles, f, 100);
    state.target_files = addUniqueLimited(state.target_files, f, 80);
    state.recent_files = addUniqueLimited(state.recent_files, f, 80);

    for (const r of ranges.slice(0, 5)) {
      recordRecentSliceFromAfterTool(state, f, r.startLine, r.endLine);
    }
  }

  for (const s of symbols) {
    addUnique(sg.targetSymbols, s, 120);
    state.target_symbols = addUniqueLimited(state.target_symbols, s, 80);
  }

  state.search_policy_state = sg;
  syncTopLevelEvidence(state);

  state.updated_at = new Date().toISOString();
  saveState(state);

  log(
    `read evidence updated tool=${toolName}, files=${filteredFiles.length}, symbols=${symbols.length}, ranges=${ranges.length}, phase=${state.phase}`
  );

  return state;
}

function looksLikeCodeLine(line) {
  const s = String(line || "").trim();

  if (/^\d+\s*[:|]\s*/.test(s)) return true;
  if (/^[{}()[\];,]+$/.test(s)) return true;
  if (/\b(if|for|while|switch|return|class|def|static|const|int|void|bool|char|struct|enum)\b/.test(s)) return true;
  if (/[{};]/.test(s)) return true;
  if (/^\s*#\s*include\b/.test(s)) return true;

  return false;
}

function quickGrepSummary(toolName, text) {
  // Search Compression v1（P1，独立 primitive）：CODE_GUARD_STRUCTURED_SEARCH=1
  // 时改用结构化 extractive 压缩——按 file 聚类、去重、保留 exact match、
  // 输出 omitted 元数据（production/test/docs 计数），不做 abstractive 总结。
  if (process.env.CODE_GUARD_STRUCTURED_SEARCH === "1") {
    return structuredGrepSummary(toolName, text);
  }
  const lines = String(text || "").split(/\r?\n/);
  const results = [];
  const seen = new Set();

  let currentFile = "";

  for (const line of lines) {
    const fileMatch = line.match(/(?:File|文件)[:：]\s*(.+)$/i);
    if (fileMatch) {
      currentFile = fileMatch[1].trim();
      continue;
    }

    const hitMatch =
      line.match(/(?:L|line\s*)(\d+)[:：]\s*(.*)$/i) ||
      line.match(/:(\d+):\s*(.*)$/);

    if (!hitMatch) continue;

    const lineno = hitMatch[1];
    const content = hitMatch[2] || "";

    const symbolMatch = content.match(/\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g);
    const symbols = symbolMatch ? Array.from(new Set(symbolMatch)).slice(0, 4) : [];

    const key = `${currentFile}:${lineno}:${symbols.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      file: currentFile || "unknown",
      line: lineno,
      symbols,
      content: content.slice(0, 120),
    });

    if (results.length >= 20) break;
  }

  const body = results
    .map((r) => `- ${r.file}:L${r.line} ${r.content}`)
    .join("\n");

  return `
[grep_search summarized]
raw_chars=${String(text || "").length}
kept_matches=${results.length}
rule=keep file,line,match; omit only redundant duplicate hits

${body || "No structured grep matches parsed."}
`.trim();
}

// Search Compression v1（FROZEN）— structured extractive grep summarizer。
// v1.1（补 per-file/per-domain 分布元数据）经实验否决：S-G2/S-G3 仍负收益，
// 且拖累 S-G1（LCR 0.82→1.19），已回退。冻结 schema 只保留 domain 计数 +
// production exact matches + omitted 计数。
function structuredGrepSummary(toolName, text) {
  if (process.env.CODE_GUARD_SEARCH_EVIDENCE_BUDGET_V1 === "1") {
    return budgetedGrepSummary(text);
  }
  const lines = String(text || "").split(/\r?\n/);
  const unique = new Map();
  let currentFile = "";
  const rawChars = String(text || "").length;

  for (const line of lines) {
    const fileMatch = line.match(/(?:File|文件)[:：]\s*(.+)$/i);
    if (fileMatch) {
      currentFile = String(fileMatch[1]).trim();
      continue;
    }
    const hitMatch =
      line.match(/(?:L|line\s*)(\d+)[:：]\s*(.*)$/i) ||
      line.match(/:(\d+):\s*(.*)$/);
    if (!hitMatch) continue;
    const lineno = hitMatch[1];
    const content = String(hitMatch[2] || "").slice(0, 120);
    const file = currentFile || "unknown";
    const key = `${file}:${lineno}:${content}`;
    if (!unique.has(key) && unique.size < 120) {
      unique.set(key, { file, line: lineno, content });
    }
  }

  const matches = Array.from(unique.values());
  const classify = (file) => {
    const f = String(file).replace(/\\/g, "/");
    if (/\/test\//.test(f) || /\.test\./.test(f) || /tests?\//.test(f)) return "test";
    if (/\/docs?\//.test(f) || /\.md$/.test(f)) return "docs";
    return "production";
  };
  const byClass = { production: [], test: [], docs: [] };
  for (const m of matches) byClass[classify(m.file)].push(m);

  const prodBody = byClass.production
    .map((m) => `- ${m.file}:L${m.line} ${m.content}`)
    .join("\n");
  const counts = {
    production: byClass.production.length,
    test: byClass.test.length,
    docs: byClass.docs.length,
  };

  return `
[SEARCH STRUCTURED v1]
raw_chars=${rawChars}
unique_matches=${matches.length}
production=${counts.production} | test=${counts.test} | docs=${counts.docs}
rule=cluster by file; keep exact match; dedupe; omit low-value hits

production matches:
${prodBody || "none"}

omitted: test=${counts.test} docs=${counts.docs} (exact lines retained only in raw output; re-grep only if a specific production match is missing)
`.trim();
}

// Productization C2 candidate only.  This does not replace frozen structured
// search v1 unless explicitly enabled: it enforces a hard evidence budget for
// FILTER tasks while retaining one exact, actionable match per selected file.
function budgetedGrepSummary(text) {
  const raw = String(text || "");
  const byFile = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const hit = line.match(/^(.+?):(?:L)?(\d+):\s*(.*)$/);
    if (!hit) continue;
    const [, file, lineNo, contentRaw] = hit;
    const content = String(contentRaw || "").slice(0, 180).trim();
    if (!content) continue;
    const score =
      (/\b(import|require|export\s+(?:async\s+)?function|function|class)\b/.test(content) ? 8 : 0) +
      (/\b(return|call|invoke|handler|route)\b/i.test(content) ? 3 : 0) +
      (/^\s*(?:\/\/|\/\*)/.test(content) ? -4 : 0) +
      (/\b(?:test|spec|docs?)\b/i.test(file) ? -2 : 0);
    const candidate = { file, line: Number(lineNo), content, score };
    const existing = byFile.get(file);
    if (!existing || candidate.score > existing.score || (candidate.score === existing.score && candidate.line < existing.line)) {
      byFile.set(file, candidate);
    }
  }
  const all = [...byFile.values()].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const kept = all.slice(0, 6);
  const omittedFiles = Math.max(0, all.length - kept.length);
  const totalMatches = raw.split(/\r?\n/).filter((line) => /^.+?:(?:L)?\d+:\s*/.test(line)).length;
  const symbolOf = (content) => {
    const match = content.match(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*\(/);
    return (match && (match[1] || match[2])) || "unknown";
  };
  const body = kept.map((m) => `${m.file}:L${m.line}\nsymbol: ${symbolOf(m.content)}\nmatch: ${m.content}`).join("\n\n");
  return [
    "[SEARCH SELECTIVE BUDGET v1]",
    body || "no actionable matches parsed",
    `[omitted: ${Math.max(0, totalMatches - kept.length)} matches across ${omittedFiles} files]`,
  ].join("\n");
}

// P2: Selective/Extractive Read v1（FROZEN）— 机械筛选相关原文，lexical
// fidelity 100%。v1.1（同文件 callee-following depth≤2）经实验否决：R2/R4 仍
// 负收益（Agent 拿到完整 callee 原文仍验证性重读），且 R3 从 Strong 退化到
// Economic，已回退。冻结 schema：只保留命中符号完整函数体 + 错误/分支行。
// CODE_GUARD_EXTRACTIVE_READ=1 启用，替代 read 的 RLM 摘要。
function extractiveReadSummary(text, knownSymbols) {
  const raw = String(text || "");
  let filePath = "";
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const pm = line.match(/<path>(.*?)<\/path>/);
    if (pm) {
      filePath = String(pm[1]).replace(/\\/g, "/");
      continue;
    }
    const num = line.match(/^\s*(\d+):\s*(.*)$/);
    if (num) rows.push({ n: Number(num[1]), text: num[2] });
  }

  // brace depth before each line
  const depth = [];
  let d = 0;
  for (const r of rows) {
    depth.push(d);
    const open = (r.text.match(/\{/g) || []).length;
    const close = (r.text.match(/\}/g) || []).length;
    d += open - close;
  }

  const declRe = /^\s*(export\s+)?(async\s+)?(function|class)\s+[A-Za-z_$]/;
  const constRe = /^\s*(export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(\(|function|async|class)/;

  // 收集所有声明区域（完整函数体，brace-matched）
  const regions = [];
  for (let i = 0; i < rows.length; i++) {
    if (!(declRe.test(rows[i].text) || constRe.test(rows[i].text))) continue;
    const base = depth[i];
    let j = i;
    while (j < rows.length) {
      j++;
      if (j < rows.length && depth[j] === base) break;
    }
    regions.push({ start: i, end: Math.min(j, rows.length), name: rows[i].text });
  }

  const syms = (knownSymbols || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  const relevant = syms.length
    ? regions.filter((r) => syms.some((s) => r.name.toLowerCase().includes(s)))
    : [];
  const selected = relevant.length ? relevant : regions; // 无符号命中时回退全保留

  const keep = new Array(rows.length).fill(false);
  for (const r of selected) {
    for (let k = r.start; k < r.end; k++) keep[k] = true;
  }
  // 仅无符号命中（回退全保留）时，额外保留区域外错误/分支行；有相关符号时
  // 目标函数体已含其分支，避免噪声行占满 cap。
  if (relevant.length === 0) {
    for (let k = 0; k < rows.length; k++) {
      if (!keep[k] && /E_[A-Z_]{3,}|throw |return \{|if \(/.test(rows[k].text)) keep[k] = true;
    }
  }

  const parts = [];
  let total = 0;
  for (let k = 0; k < rows.length; k++) {
    if (!keep[k]) continue;
    const lineText = `${rows[k].n}: ${rows[k].text}`;
    if (total + lineText.length > 3400) break;
    parts.push(lineText);
    total += lineText.length;
  }
  const first = parts.length ? parts[0].split(":")[0] : "?";
  const last = parts.length ? parts[parts.length - 1].split(":")[0] : "?";
  const header = filePath ? `file: ${filePath}\n` : "";
  return `[EXTRACTIVE READ v1]
${header}lines: ${first}-${last}
rule=keep full function/class bodies + declarations + error/branch lines verbatim (lexical fidelity 100%); omit comments/boilerplate

${parts.join("\n")}`;
}

function quickShellSearchSummary(toolName, text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/);

  const byFile = new Map();

  for (const line of lines) {
    const m =
      line.match(/^(.+?):(\d+):(.*)$/) ||
      line.match(/^(.+?)\((\d+)\):\s*(.*)$/);

    if (!m) {
      continue;
    }

    const file = shortenRepoPath(m[1]);
    const lineNo = m[2];
    const content = String(m[3] || "").trim();

    if (!byFile.has(file) && byFile.size >= 12) {
      continue;
    }

    if (!byFile.has(file)) {
      byFile.set(file, []);
    }

    const arr = byFile.get(file);
    if (arr.length < 6) {
      arr.push({
        line: lineNo,
        content: content.slice(0, 120),
      });
    }

  }

  if (byFile.size === 0) {
    return quickShellSummary(toolName, raw);
  }

  const parts = [];

  for (const [file, hits] of byFile.entries()) {
    parts.push(`file: ${file}`);
    parts.push("matches:");

    for (const h of hits) {
      parts.push(`- L${h.line}: ${h.content}`);
    }

    parts.push("");
  }

  return `
[shell_search summarized]
raw_chars=${raw.length}
files=${byFile.size}
rule=group by repo-relative file; do not repeat long absolute path per line

${parts.join("\n").trim()}

[next]
Use read_file_slice.py or smart_read_file.py on the repo-relative file above.
`.trim();
}


  return {
    isHookPreCompressed,
    shouldSkipAfterToolCompression,
    quickShellSummary,
    quickSmartReadSummary,
    updateReadEvidenceFromOutput,
    quickGrepSummary,
    quickShellSearchSummary,
    extractReadRangesFromText,
    extractiveReadSummary,
  };
}

module.exports = { createSummaries };
