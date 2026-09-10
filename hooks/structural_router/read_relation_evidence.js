"use strict";

// ============================================================================
// post_tool/read_relation_evidence.js — Line-6 R2 Relation Evidence primitive
// ============================================================================
// 纯函数、无 I/O、确定性。为 R2（调用关系读取）任务提供"关系边 + 少量证据"：
//   entry → direct targets（1-hop），全部来自 identity module map。
//
// 铁律（与任务书 §六 一致）：
//   - 边只能来自 map（hallucinated edge 结构上不可能）；
//   - 不输出 callee 文件原文（v1.1 callee-following 已被历史否决）；
//   - 只在 R2 类任务上 eligible（调用方负责传 task_class；R1/R3/R5/R0 → null）；
//   - entry 无法解析 / map 缺失 → null（Native，不猜测）。
// ============================================================================

const { resolveRuntimeEntryPath, normalizeRepoRelativePath } = require("./entry_identity.js");

function parseIdentityModuleMap(moduleMap) {
  let parsed = moduleMap;
  if (typeof moduleMap === "string") {
    try { parsed = JSON.parse(moduleMap); } catch (_error) { return null; }
  }
  if (!parsed || parsed.schema !== "structural-moduledeps-identity-v2" || !Array.isArray(parsed.nodes)) return null;
  const nodes = new Map();
  for (const node of parsed.nodes) {
    const sourcePath = normalizeRepoRelativePath(node && node.source_path);
    if (!sourcePath || nodes.has(sourcePath) || !Array.isArray(node.targets)) return null;
    const targets = [];
    for (const target of node.targets) {
      const targetPath = normalizeRepoRelativePath(target && target.target_path);
      if (!targetPath) return null;
      targets.push(targetPath);
    }
    nodes.set(sourcePath, targets);
  }
  return nodes.size ? nodes : null;
}

/**
 * 构建关系证据。返回 null = 不 eligible（调用方保持 Native）。
 */
function buildRelationEvidence({ task_text, module_map, task_class } = {}) {
  if (task_class !== "R2") return null;
  const nodes = parseIdentityModuleMap(module_map);
  if (!nodes) return null;
  const identity = resolveRuntimeEntryPath({ task_text: String(task_text || ""), source_paths: [...nodes.keys()] });
  if (!identity.entry_resolved) return null;
  const targets = nodes.get(identity.entry_path);
  if (!targets || targets.length === 0) return null;

  const edges = targets.map((to) => ({ from: identity.entry_path, to }));
  const lines = [
    `[READ_RELATION_EVIDENCE]`,
    `entry: ${identity.entry_path} (direct dependency edges, source: structural module map)`,
    ...edges.map((e) => `- ${e.from} -> ${e.to}`),
    `edges: ${edges.length} (1-hop; verify details in source when precision matters)`,
  ];
  return {
    entry_path: identity.entry_path,
    edges,
    text: lines.join("\n"),
  };
}

module.exports = { buildRelationEvidence, parseIdentityModuleMap };
