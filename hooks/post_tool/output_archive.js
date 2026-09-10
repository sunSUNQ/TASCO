const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function createOutputArchiver({ getArchiveDir, log, maxArchiveFiles }) {
  const archiveLimit = Number(maxArchiveFiles || "100");

  function archiveDir() {
    return typeof getArchiveDir === "function"
      ? getArchiveDir()
      : path.join(String(getArchiveDir || ""), "tool_output_archive");
  }

  function safeArchivePart(value) {
    return String(value || "unknown")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 100);
  }

  function pruneToolOutputArchives() {
    try {
      const dir = archiveDir();
      const files = fs.readdirSync(dir)
        .map((name) => {
          const filePath = path.join(dir, name);
          return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const stale of files.slice(archiveLimit)) {
        fs.unlinkSync(stale.filePath);
      }
    } catch (_error) {
      // Archive retention is best-effort and must never break a hook response.
    }
  }

  function archiveOriginalToolOutput(payload, rawText) {
    try {
      const dir = archiveDir();
      fs.mkdirSync(dir, { recursive: true });
      const sessionId = safeArchivePart(payload?.session_id || payload?.sessionId || "default");
      const toolUseId = safeArchivePart(payload?.tool_use_id || payload?.toolUseId || Date.now());
      const toolName = safeArchivePart(payload?.claude_tool_name || payload?.tool_name || payload?.toolName || "tool");
      const sha256 = crypto.createHash("sha256").update(rawText, "utf8").digest("hex");
      const archivePath = path.join(dir, `${sessionId}_${toolUseId}_${toolName}.json`);
      const originalResponse = payload?.tool_response ?? payload?.toolResponse ?? payload?.response ?? null;
      fs.writeFileSync(archivePath, JSON.stringify({
        version: 1,
        archived_at: new Date().toISOString(),
        session_id: sessionId,
        tool_use_id: toolUseId,
        tool_name: toolName,
        raw_chars: rawText.length,
        sha256,
        raw_text: rawText,
        original_response: originalResponse,
      }), "utf8");
      pruneToolOutputArchives();
      return { archivePath, sha256 };
    } catch (error) {
      log(`tool output archive failed error=${String(error)}`);
      return null;
    }
  }

  return { archiveOriginalToolOutput };
}

module.exports = { createOutputArchiver };
