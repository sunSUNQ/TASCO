"use strict";

function normalizeRepoRelativePath(value) {
  if (typeof value !== "string") return null;
  let normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) return null;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return normalized;
}

function identityKey(value, caseSensitive = process.platform !== "win32") {
  const normalized = normalizeRepoRelativePath(value);
  return normalized && !caseSensitive ? normalized.toLowerCase() : normalized;
}

function explicitJsPaths(taskText) {
  if (typeof taskText !== "string") return [];
  const matches = taskText.match(/[A-Za-z0-9._\\/-]+\.js\b/g) || [];
  return [...new Set(matches.map(normalizeRepoRelativePath).filter(Boolean))];
}

function resolveRuntimeEntryPath({ task_text: taskText, source_paths: sourcePaths, case_sensitive: caseSensitive } = {}) {
  if (!Array.isArray(sourcePaths)) {
    return { entry_path: null, entry_path_source: "unresolved", entry_resolved: false };
  }
  const canonical = new Map();
  for (const sourcePath of sourcePaths) {
    const key = identityKey(sourcePath, caseSensitive);
    if (!key || canonical.has(key)) {
      return { entry_path: null, entry_path_source: "unresolved", entry_resolved: false };
    }
    canonical.set(key, normalizeRepoRelativePath(sourcePath));
  }
  const matches = explicitJsPaths(taskText)
    .map((candidate) => canonical.get(identityKey(candidate, caseSensitive)))
    .filter(Boolean);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    return { entry_path: null, entry_path_source: "unresolved", entry_resolved: false };
  }
  return {
    entry_path: unique[0],
    entry_path_source: "task_explicit_path",
    entry_resolved: true,
  };
}

module.exports = { explicitJsPaths, normalizeRepoRelativePath, resolveRuntimeEntryPath };
