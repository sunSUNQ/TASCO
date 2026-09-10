function createCompressor(deps) {
  const {
    cp,
    PYTHON_CANDIDATES,
    PY_COMPRESS_SCRIPT,
    loadState,
    normalizeAfterToolState,
    ensureSearchGovernanceState,
    buildSearchPolicyContext,
    log,
  } = deps;
function fastTruncateSummary(toolName, text) {
  const head = text.slice(0, 2500);
  const tail = text.length > 2500 ? text.slice(-2500) : "";

  return `
[工具输出快速截断摘要]

工具名称: ${toolName}
原始长度: ${text.length} chars
处理方式: head-tail truncation

[开头]
${head}

[结尾]
${tail}
`.trim();
}


function callRlmCompress(toolName, toolText) {
  let pyResult = null;
  let pythonBin = "";
  const spawnOptions = {
    input: JSON.stringify({ tool_name: toolName, tool_text: toolText }),
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  };

  for (const candidate of PYTHON_CANDIDATES) {
    const args = candidate === "py" ? ["-3", PY_COMPRESS_SCRIPT] : [PY_COMPRESS_SCRIPT];
    const attempt = cp.spawnSync(candidate, args, spawnOptions);
    if (attempt.error && attempt.error.code === "ENOENT") {
      log(`rlm python candidate unavailable tool=${toolName}, bin=${candidate}`);
      continue;
    }
    pyResult = attempt;
    pythonBin = candidate;
    break;
  }

  if (!pyResult) {
    log(`rlm spawn error tool=${toolName}: no Python interpreter found candidates=${PYTHON_CANDIDATES.join(",")}`);
    return null;
  }

  log(`rlm python selected tool=${toolName}, bin=${pythonBin}`);

  if (pyResult.error) {
    log(`rlm spawn error tool=${toolName}: ${String(pyResult.error)}`);
    return null;
  }

  if (pyResult.status !== 0) {
    log(`rlm nonzero exit tool=${toolName}, status=${pyResult.status}`);
  }

  const stderr = String(pyResult.stderr || "");
  if (stderr.trim()) {
    log(`python stderr tool=${toolName}: ${stderr.slice(0, 2000)}`);
  }

  const stdout = String(pyResult.stdout || "");
  log(`python stdout preview tool=${toolName}: ${stdout.slice(0, 800)}`);

  const lines = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch (_e) {
      continue;
    }
  }

  log(`rlm parse error tool=${toolName}: no valid json line found`);
  return null;
}

  return { fastTruncateSummary, callRlmCompress };
}

module.exports = { createCompressor };