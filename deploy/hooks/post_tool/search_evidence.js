function createSearchEvidence(deps) {
  const {
    normalizeToolName,
    loadState,
    normalizeAfterToolState,
    ensureSearchGovernanceState,
    addUniqueLimited,
    ensureArray,
    ensureObject,
    ensureNumber,
    addUnique,
    syncTopLevelEvidence,
    saveState,
    log,
    getKnownFiles,
    getKnownSymbols,
    hasKnownFiles,
    hasKnownSymbols,
    hasShellError,
    setPhaseIfForward,
    extractReadRangesFromText,
  } = deps;
function extractSearchQuery(payload) {
  return (
    payload.tool_input?.query ||
    payload.tool_input?.pattern ||
    payload.toolInput?.query ||
    payload.toolInput?.pattern ||
    payload.args?.query ||
    payload.args?.pattern ||
    payload.arguments?.query ||
    payload.arguments?.pattern ||
    payload.params?.query ||
    payload.params?.pattern ||
    payload.query ||
    payload.pattern ||
    ""
  );
}

function extractCommand(payload) {
  const input =
    payload.tool_input ||
    payload.toolInput ||
    payload.input ||
    payload.args ||
    payload.arguments ||
    payload.params ||
    {};

  return input.command || "";
}

function isRepoMapCommand(command) {
  const s = String(command || "").toLowerCase();
  return s.includes("repo_map.py");
}

function looksLikeRepoMapSuccess(text) {
  const s = String(text || "").toLowerCase();

  if (!s.trim()) {
    return false;
  }

  return (
    s.includes("repo_map") ||
    s.includes("repo map") ||
    s.includes("directory") ||
    s.includes("candidate") ||
    s.includes("focus")
  ) && !hasShellError(s);
}

function extractCommandArg(command, name) {
  const s = String(command || "");
  const re = new RegExp(`--${name}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, "i");
  const m = s.match(re);
  if (!m) return "";
  return m[1] || m[2] || m[3] || "";
}

function extractRepoMapRoot(command) {
  const s = String(command || "");

  const m = s.match(/repo_map\.py"\s+"([^"]+)"/i) ||
            s.match(/repo_map\.py\s+"([^"]+)"/i) ||
            s.match(/repo_map\.py\s+([^\s]+)/i);

  return m ? m[1].replace(/^"|"$/g, "") : "";
}

function extractRepoMapFocusTerms(command) {
  const s = String(command || "");
  const result = [];
  const re = /--focus\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi;

  let m;
  while ((m = re.exec(s)) !== null) {
    const v = String(m[1] || m[2] || m[3] || "").trim();
    if (v && !result.includes(v)) {
      result.push(v);
    }
  }

  return result.slice(0, 30);
}

function parseRepoMapArgs(command) {
  return {
    root: extractRepoMapRoot(command),
    maxDepth: Number(extractCommandArg(command, "max-depth") || 3),
    maxFilesPerDir: Number(extractCommandArg(command, "max-files-per-dir") || 12),
    maxChars: Number(extractCommandArg(command, "max-chars") || 5000),
    focusTerms: extractRepoMapFocusTerms(command),
  };
}

function markRepoMapDoneFromAfterTool(command, toolText) {
  const state = normalizeAfterToolState(loadState());
  const args = typeof parseRepoMapArgs === "function"
    ? parseRepoMapArgs(command)
    : {
        root: extractRepoMapRoot(command),
        focusTerms: extractRepoMapFocusTerms(command),
        maxDepth: Number(extractCommandArg(command, "max-depth") || 3),
        maxFilesPerDir: Number(extractCommandArg(command, "max-files-per-dir") || 12),
        maxChars: Number(extractCommandArg(command, "max-chars") || 5000),
      };

  state.repo_map = ensureObject(state.repo_map);
  state.repo_map.generated = true;
  state.repo_map.command = String(command || "").slice(0, 800);
  state.repo_map.root = args.root || state.repo_map.root || "";
  state.repo_map.focus_terms = ensureArray(args.focusTerms).slice(0, 30);
  state.repo_map.max_depth = args.maxDepth;
  state.repo_map.max_files_per_dir = args.maxFilesPerDir;
  state.repo_map.max_chars = args.maxChars;
  state.repo_map.generated_at = new Date().toISOString();
  state.repo_map.generated_ms = Date.now();

  state.phase_state = ensureObject(state.phase_state);
  state.phase_state.repo_map_done = true;

  setPhaseIfForward(state, "focus", "aftertool_repo_map_success");

  state.updated_at = new Date().toISOString();
  saveState(state);

  log(
    `repo_map_done marked by aftertool phase=${state.phase}, root=${state.repo_map.root}, focus=${state.repo_map.focus_terms.join(",")}, output_chars=${String(toolText || "").length}`
  );

  return state;
}

function isSearchCommand(command) {
  const text = String(command || "").toLowerCase();

  return (
    /\brg\b/.test(text) ||
    /\bgrep\b/.test(text) ||
    /\bfindstr\b/.test(text) ||
    text.includes("select-string") ||
    text.includes("searchtext")
  );
}

function extractFilePathsFromSearchText(text) {
  const raw = String(text || "");

  const matches =
    raw.match(/([A-Za-z]:\\[^\s:]+?\.\w+|[./\w-]+\/[./\w-]+?\.\w+)/g) || [];

  return Array.from(new Set(matches))
    .map((x) => x.replace(/[)"',;]+$/g, ""))
    .filter((x) => {
      const lower = x.toLowerCase();
      return /\.(c|cc|cpp|h|hpp|hh|py|js|ts|java|go|rs|md|txt|log|proto|cmake)$/i.test(lower);
    })
    .slice(0, 30);
}

function normalizePathSep(p) {
  return String(p || "").replace(/\\/g, "/");
}

function shortenRepoPath(filePath) {
  const p = normalizePathSep(filePath);

  const markers = [
    "/src/",
    "/include/",
    "/test/",
    "/tests/",
    "/spec/",
    "/doc/",
    "/docs/",
  ];

  for (const marker of markers) {
    const idx = p.toLowerCase().indexOf(marker);
    if (idx >= 0) {
      return p.slice(idx + 1);
    }
  }

  // 如果找不到 src/include/test，就保留最后 4 层，避免只剩 basename。
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 4) {
    return p;
  }

  return parts.slice(-4).join("/");
}

function extractLikelySymbolsFromSearchText(text) {
  const raw = String(text || "");
  const result = new Set();

  const stop = new Set([
    "found",
    "matches",
    "limited",
    "within",
    "searchtext",
    "readfile",
    "error",
    "warning",
    "unknown",
    "true",
    "false",
    "return",
    "include",
    "typedef",
    "struct",
    "class",
    "static",
    "const",
    "void",
    "char",
    "int",
    "uint32_t",
    "int32_t",
    "uint64_t",
    "int64_t"
  ]);

  const matches = raw.match(/\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g) || [];

  for (const s of matches) {
    const lower = s.toLowerCase();

    if (stop.has(lower)) continue;
    if (/^[a-f0-9]{8,}$/i.test(s)) continue;

    const looksLikeCodeSymbol =
      /^[A-Z][A-Za-z0-9_]+$/.test(s) ||
      /^[A-Za-z_]+[A-Z][A-Za-z0-9_]*$/.test(s) ||
      /^[a-z_]+_[a-z0-9_]+$/.test(s) ||
      /^test_[A-Za-z0-9_]+$/.test(s);

    if (looksLikeCodeSymbol) {
      result.add(s);
    }
  }

  return Array.from(result).slice(0, 40);
}

function extractLikelyTestsFromSearchText(text) {
  const lines = String(text || "").split(/\r?\n/);

  return lines
    .filter((line) =>
      /\b(TEST|TEST_F|test_|_test|describe\(|it\()\b/.test(line)
    )
    .map((line) => line.trim().slice(0, 240))
    .slice(0, 20);
}

function updateSearchGovernanceFromSearchOutput(payload, toolName, toolText) {
  const state = loadState();
  const sg = ensureSearchGovernanceState(state);



  const query = extractSearchQuery(payload);
  const command = extractCommand(payload);
  const evidenceText = String(toolText || "");
  const ranges = extractReadRangesFromText(evidenceText);

  const files = extractFilePathsFromSearchText(evidenceText);
  const symbols = extractLikelySymbolsFromSearchText(
    `${query}\n${command}\n${evidenceText}`
  );
  const tests = extractLikelyTestsFromSearchText(evidenceText);

  const beforeFiles = new Set(ensureArray(sg.targetFiles));
  const beforeSymbols = new Set(ensureArray(sg.targetSymbols));
  const beforeTests = new Set(ensureArray(sg.targetTests));

  const beforeRanges = new Set(
    ensureArray(sg.readRangeRecords).map((r) => {
      return `${String(r.file || "").toLowerCase()}:${r.startLine}-${r.endLine}`;
    })
  );

  for (const f of files) {
    addUnique(sg.targetFiles, f, 100);
  }

  for (const s of symbols) {
    addUnique(sg.targetSymbols, s, 120);
  }

  for (const t of tests) {
    addUnique(sg.targetTests, t, 80);
  }
  const isCodeReadHelper =
    command.includes("smart_read_file.py") ||
    command.includes("read_file_slice.py") ||
    toolName === "read_file";

  const filteredFiles = isCodeReadHelper
    ? files.filter(f => /\.(c|cc|cpp|h|hpp|hh|py|js|ts|java|go|rs|proto|cmake)$/i.test(f))
    : files;
  const newTests = tests.filter((t) => !beforeTests.has(t));
  const newFiles = filteredFiles.filter((f) => !beforeFiles.has(f));
  const newSymbols = symbols.filter((s) => !beforeSymbols.has(s));

  const newRanges = [];
  for (const f of filteredFiles) {
    const keyFile = String(f || "").replace(/[\\/]+/g, "\\").toLowerCase();

    for (const r of ranges.slice(0, 5)) {
      const k = `${keyFile}:${r.startLine}-${r.endLine}`;
      if (!beforeRanges.has(k)) {
        newRanges.push(k);
      }
    }
  }

  const readGainScore =
    newFiles.length * 3 +
    newSymbols.length * 2 +
    newRanges.length;

  sg.lastReadGain = {
    tool: toolName,
    files: filteredFiles.slice(0, 8),
    newFiles: newFiles.slice(0, 8),
    newSymbols: newSymbols.slice(0, 12),
    newRanges: newRanges.slice(0, 10),
    gainScore: readGainScore,
    updated_at: new Date().toISOString(),
  };

  sg.readGainHistory = ensureArray(sg.readGainHistory);
  sg.readGainHistory.push(sg.lastReadGain);
  sg.readGainHistory = sg.readGainHistory.slice(-50);

  const gainScore =
    newFiles.length * 3 +
    newSymbols.length * 2 +
    newTests.length * 2;

  if (gainScore > 0) {
    sg.noNewEvidenceSearchCount = 0;
  } else {
    sg.noNewEvidenceSearchCount =
      ensureNumber(sg.noNewEvidenceSearchCount, 0) + 1;
  }

  sg.lastEvidenceGain = {
    tool: toolName,
    query: String(query || command || "").slice(0, 300),
    newFiles: newFiles.slice(0, 8),
    newSymbols: newSymbols.slice(0, 12),
    newTests: newTests.slice(0, 5),
    gainScore,
    noNewEvidenceSearchCount: sg.noNewEvidenceSearchCount,
    updated_at: new Date().toISOString(),
  };

  sg.evidenceGainHistory = ensureArray(sg.evidenceGainHistory);
  sg.evidenceGainHistory.push(sg.lastEvidenceGain);
  sg.evidenceGainHistory = sg.evidenceGainHistory.slice(-50);

  let score = 0;
  if (sg.targetFiles.length > 0) score += 1;
  if (sg.targetSymbols.length > 0) score += 1;
  if (sg.targetTests.length > 0) score += 1;

  const currentGainScore =
    newFiles.length * 3 +
    newSymbols.length * 2 +
    newTests.length * 2;

  const oldScore = Number(sg.targetEvidenceScore || 0);
  sg.targetEvidenceScore = Math.max(oldScore, score);
  sg.lastEvidenceGainScore = currentGainScore;


  sg.last_search_evidence = {
    tool: toolName,
    query: String(query || command || "").slice(0, 300),
    files: files.slice(0, 8),
    symbols: symbols.slice(0, 12),
    tests: tests.slice(0, 5),
    score: sg.targetEvidenceScore,
    updated_at: new Date().toISOString()
  };

  sg.updated_at = new Date().toISOString();
  state.search_policy_state = sg;

  // 同步到 BeforeTool 使用的顶层字段，避免 knownFiles/knownSymbols 判断拿不到。
  syncTopLevelEvidence(state);

  state.updated_at = new Date().toISOString();
  saveState(state);

  log(
    `read evidence updated tool=${toolName}, files=${filteredFiles.length}, symbols=${symbols.length}, newFiles=${newFiles.length}, newSymbols=${newSymbols.length}, newRanges=${newRanges.length}, gainScore=${readGainScore}, phase=${state.phase}`
  );
  return sg;
}

function buildSearchPolicyContext(sg) {
  const state = normalizeAfterToolState(loadState());
  sg = sg || state.search_policy_state || {};

  const files = ensureArray(sg.targetFiles || state.target_files).slice(-5);
  const symbols = ensureArray(sg.targetSymbols || state.target_symbols).slice(-8);
  const tests = ensureArray(sg.targetTests).slice(-3);

  const hasFiles = files.length > 0;
  const hasSymbols = symbols.length > 0;

  // 没有文件时，不要说 evidence exists，只引导继续 exact grep / narrow glob。
  if (!hasFiles) {
    return [
      "SEARCH_POLICY_ACTIVE:",
      "phase=focus",
      "No confirmed target file yet.",
      "Next action:",
      "1. Use exact grep for spec symbols/API names/errors inside target repo.",
      "2. Use narrow glob with concrete filename keyword.",
      "3. Do not use ReadFolder, recursive listing, broad glob, or generic grep."
    ].join("\n");
  }

  // 有文件但没符号时，允许继续小范围读和精确 grep，不要 STOP。
  if (hasFiles && !hasSymbols) {
    return [
      "SEARCH_POLICY_ACTIVE:",
      "phase=focus",
      `known_files: ${files.join(", ")}`,
      "No confirmed code symbol yet.",
      "Next action:",
      "1. Use read_file_slice.py or smart_read_file.py on known files.",
      "2. Use exact grep within known files to identify symbols/interfaces.",
      "3. Do not trigger evidence complete yet."
    ].join("\n");
  }

  // 有文件 + 符号时，才进入收敛。
  return [
    "SEARCH_POLICY_ACTIVE:",
    "phase=focus",
    "knownFiles and knownSymbols are available. Avoid high-cost broad search and converge to slice/edit/test.",
    `known_files: ${files.join(", ")}`,
    `known_symbols: ${symbols.join(", ")}`,
    tests.length ? `known_tests: ${tests.join(" | ")}` : "",
    "Next action should be one of:",
    "1. read_file_slice.py around known files/symbols",
    "2. smart_read_file.py for selected target files",
    "3. targeted replace or safe_replace.py",
    "4. run narrow related tests",
    "Prefer low-cost high-gain actions; avoid repeated broad search or rereading already-read ranges."
  ]
    .filter(Boolean)
    .join("\n");
}

  return {
    extractSearchQuery,
    extractCommand,
    isRepoMapCommand,
    looksLikeRepoMapSuccess,
    markRepoMapDoneFromAfterTool,
    isSearchCommand,
    extractFilePathsFromSearchText,
    shortenRepoPath,
    extractLikelySymbolsFromSearchText,
    updateSearchGovernanceFromSearchOutput,
    buildSearchPolicyContext,
  };
}

module.exports = { createSearchEvidence };
