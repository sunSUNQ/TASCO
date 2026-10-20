"use strict";

// ============================================================================
// structural_router/map_provider.js — Line-6 R2/R3 Map On-Demand Provider
// ============================================================================
// 职责边界（用户拍板 2026-09-09）：
//   Task Semantic 决定要不要 R2/R3（分类器职责，本模块不参与）；
//   Map 只提供关系事实（本模块唯一职责：解析 → 新鲜度 → 按需生成 → cache）。
//   绝不让 map 参与"是否开启"的静态 Router 判断（G1 死路，已冻结）。
//
// 解析顺序：
//   1. 显式 env（CODE_GUARD_STRUCTURAL_MAP）→ operator-owned，原样使用，
//      不做新鲜度、绝不重建（与既有行为兼容）；
//   2. 仓内 cache（<cwd>/.tasco/identity_map.json）→ 校验 schema + 新鲜度；
//   3. 缺失 / 过期 → 用冻结 producer（tools/structural_map_producer.js，
//      52 nodes / 123 edges 与 pilot map 逐边 parity 实证）按需生成，
//      盖章 repo_head 后写回 cache；
//   4. 生成失败 / 超时 / 空图 → 同 HEAD 内写失败墓碑，返回 null（Native，
//      fail-closed，不猜测关系）。
//
// 新鲜度：生成时盖 repo_head（git rev-parse HEAD）；后续读取 head 不一致
// → 过期 → 重建。无 git / 无 stamp → 视为新鲜（不猜测；operator map 不动）。
//
// 成本护栏：每仓 .tasco cache 命中后成本 = 1 次文件读 + 1 次 git rev-parse；
// 只有缺失/过期才触发 producer（timeout 15s）；失败墓碑防每读重试。
// 自动生成开关：CODE_GUARD_READ_MAP_AUTOBUILD=0 → 缺 map 一律 null。
// ============================================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const PRODUCER = path.join(__dirname, "..", "..", "tools", "structural_map_producer.js");
const BUILD_TIMEOUT_MS = 15000;
const MAX_NODES = 10000;

function isValidMapText(text) {
  try {
    const parsed = JSON.parse(text);
    return (
      parsed &&
      parsed.schema === "structural-moduledeps-identity-v2" &&
      Array.isArray(parsed.nodes) &&
      parsed.nodes.length > 0 &&
      parsed.nodes.length <= MAX_NODES
    );
  } catch (_e) {
    return false;
  }
}

function currentRepoHead(cwd, spawnSync) {
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    if (res.status === 0) {
      const head = String(res.stdout || "").trim();
      return head ? head.slice(0, 40) : null;
    }
  } catch (_e) {
    /* fallthrough */
  }
  return null;
}

function buildMap(cwd, head, spawnSync) {
  const res = spawnSync(
    process.execPath,
    [PRODUCER, "--root", cwd, "--mode", "moduledeps", "--format", "identity-json"],
    { cwd, encoding: "utf8", timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0 || !res.stdout) return null;
  const text = String(res.stdout);
  if (!isValidMapText(text)) return null;
  // 盖章（parser 只读 schema/nodes，额外字段安全）。
  try {
    const parsed = JSON.parse(text);
    parsed.repo_head = head || null;
    parsed.generated_at = new Date().toISOString();
    return JSON.stringify(parsed, null, 2);
  } catch (_e) {
    return null;
  }
}

/**
 * 解析（必要时按需生成）当前仓的 moduledeps identity map。
 *
 * @param {object} input
 * @param {string} input.cwd          仓库根
 * @param {string|null} input.envMapPath 显式 env map 路径（operator-owned）
 * @param {boolean} input.allowBuild  是否允许按需生成（READ_COMPRESSION=1 且未禁用）
 * @param {Function} [input.spawnSync] 注入（默认 child_process.spawnSync）
 * @returns {string|null} map JSON 文本；null = 不可用（R2/R3 → Native）
 */
function resolveOrBuildModuleMap({ cwd, envMapPath, allowBuild, spawnSync } = {}) {
  const sp = spawnSync || cp.spawnSync;
  const root = String(cwd || process.cwd());

  // 1) 显式 env map：operator-owned，原样使用（合法即用，不重建）。
  if (envMapPath) {
    try {
      const text = fs.readFileSync(envMapPath, "utf8");
      return isValidMapText(text) ? text : null;
    } catch (_e) {
      return null;
    }
  }

  const cachePath = path.join(root, ".tasco", "identity_map.json");
  const tombstonePath = path.join(root, ".tasco", "identity_map.failed.json");
  const head = allowBuild ? currentRepoHead(root, sp) : null;

  // 2) cache 命中：schema 合法 + 新鲜（无 stamp / head 不可得 / head 相等）。
  let cached = null;
  try {
    cached = fs.readFileSync(cachePath, "utf8");
  } catch (_e) {
    cached = null;
  }
  if (cached && isValidMapText(cached)) {
    let stamp = null;
    try {
      stamp = JSON.parse(cached).repo_head || null;
    } catch (_e) {
      stamp = null;
    }
    if (!stamp || !head || stamp === head) {
      return cached; // 无 stamp（operator/legacy map）或 head 一致 → 新鲜
    }
    // stamp != head → 过期 → 落到重建
  }

  if (!allowBuild) return cached && isValidMapText(cached) ? cached : null;

  // 失败墓碑：同 head 内不重复尝试（producer 失败是仓属性，不是瞬态）。
  // head=null（无 git）时墓碑同样命中——无法识别变化的环境里不重试。
  try {
    const tomb = JSON.parse(fs.readFileSync(tombstonePath, "utf8"));
    if (tomb && (tomb.repo_head || null) === (head || null)) return null;
  } catch (_e) {
    /* no tombstone */
  }

  // 3) 按需生成 + 盖章 + 写回 cache（写失败不阻断本次交付）。
  const built = buildMap(root, head, sp);
  if (!built) {
    try {
      fs.mkdirSync(path.dirname(tombstonePath), { recursive: true });
      fs.writeFileSync(
        tombstonePath,
        JSON.stringify({ repo_head: head, at: new Date().toISOString() }),
        "utf8"
      );
    } catch (_e) {
      /* fail-open */
    }
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, built, "utf8");
  } catch (_e) {
    /* fail-open: 内存中的 map 仍可用于本次交付 */
  }
  return built;
}

module.exports = { resolveOrBuildModuleMap, isValidMapText };
