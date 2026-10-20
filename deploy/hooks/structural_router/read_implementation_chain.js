"use strict";

// ============================================================================
// structural_router/read_implementation_chain.js — Line-6 R3 Implementation
// Chain primitive
// ============================================================================
// 纯函数、无 I/O、确定性。为 R3（wrapper → 真实实现链）任务提供**链证据**：
//   entry -> forwarding targets -> (2-hop) targets' targets
// 全部来自 identity module map（边结构上不可能幻觉）。
//
// v1 诚实边界（记录）：本 primitive 交付"链证据"（哪条边存在、每步 file 证据），
// 不做语义级"哪个是 wrapper / 哪个是真实现"判定——那需要符号级语义，超出静态
// map 表达范围（与 G1 结论一致的边界纪律）。链的选择交给模型，逐边可核对。
//
// 只在 R3 类任务上 eligible；entry 无法解析 / map 缺失 → null（Native）。
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

const MAX_CHAIN_LINES = 24;

/**
 * 构建 1..max_hops 实现链证据（BFS，cycle-safe，每条边都来自 map）。
 * 返回 null = 不 eligible（调用方保持 Native）。
 */
function buildImplementationChain({ task_text, module_map, task_class, max_hops } = {}) {
  if (task_class !== "R3") return null;
  const nodes = parseIdentityModuleMap(module_map);
  if (!nodes) return null;
  const identity = resolveRuntimeEntryPath({ task_text: String(task_text || ""), source_paths: [...nodes.keys()] });
  if (!identity.entry_resolved) return null;
  if (!nodes.has(identity.entry_path)) return null;

  const hops = Math.max(1, Math.min(Number(max_hops) || 2, 3));
  const chainLines = [];
  const seenEdges = new Set();
  let frontier = [identity.entry_path];
  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next = [];
    for (const from of frontier) {
      for (const to of nodes.get(from) || []) {
        const key = `${from}->${to}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        chainLines.push(`chain: ${key}`);
        if (chainLines.length >= MAX_CHAIN_LINES) break;
        next.push(to);
      }
      if (chainLines.length >= MAX_CHAIN_LINES) break;
    }
    if (chainLines.length >= MAX_CHAIN_LINES) break;
    frontier = [...new Set(next)].filter((n) => nodes.has(n)); // cycle-safe
  }

  if (!chainLines.length) return null;

  const text = [
    `[READ_IMPLEMENTATION_CHAIN]`,
    `entry: ${identity.entry_path} (hops<=${hops}, source: structural module map; per-edge file evidence, verify implementation in source)`,
    ...chainLines,
    `chain edges: ${chainLines.length}`,
  ].join("\n");

  return { entry_path: identity.entry_path, edges: [...seenEdges].map((e) => e.split("->")), text };
}

module.exports = { buildImplementationChain, parseIdentityModuleMap };
