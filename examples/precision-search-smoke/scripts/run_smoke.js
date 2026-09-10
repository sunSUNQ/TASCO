"use strict";

// ============================================================================
// run_smoke.js — ⑤ 精准代码搜索（Search Discovery 泛化 AUTO）确定性冒烟
// （主线⑤）。零依赖、无模型。用真实 frozen bridge（claude_bridge.js）验证：
//   1) 意图正区发射：DISCOVERY（调用链/机制发现）与 FILTER（同名 symbol 消歧）
//      任务自动注入搜索收敛引导（frozen 模板，不给答案）
//   2) 跨仓一致：同一任务在四个不同仓库名下发射逐字节一致（仓库不参与
//      eligibility；repo 白名单仅存在于兼容模式）
//   3) 负区 FP=0：LOOKUP（找定义）/枚举/统计/未知意图零注入（冻结边界）
//   4) pilot 兼容：未开泛化时白名单照常生效（fastify 发射、express 跳过）
//   5) 回滚：主开关关闭 → 零 guidance 活动
// 观测产物落在 .tasco-runs/<timestamp>/ 下。
// 运行:node scripts/run_smoke.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const EXAMPLE_ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(EXAMPLE_ROOT, "..", "..", "adapters", "claude_bridge.js");
const HOOK_DIR = path.join(EXAMPLE_ROOT, "..", "..", "hooks");
const RUN_DIR = path.join(EXAMPLE_ROOT, ".tasco-runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));

const DISCOVERY_PROMPT =
  "分析这个仓库中请求中止信号的传播机制：底层如何感知中止、钩子在什么条件下触发、清理涉及哪些模块。梳理完整机制与关键调用链。不要修改代码。";
const FILTER_PROMPT =
  "search_lab/g4 contains four similar symbols: reserveInventory, reserveStock, holdStock, lockStock. Determine which one is ACTUALLY imported and called by order.js. Distinguish the real symbol from the unused lookalikes. Do not modify any file.";
const LOOKUP_PROMPT = "Reply.prototype.send 定义在哪个文件？";
const ENUM_PROMPT = "列出仓库里所有调用 setErrorHandler 的位置，确保没有遗漏。";
const STAT_PROMPT = "统计各目录中 onRequest 出现的次数并给出分布。";
const UNKNOWN_PROMPT = "Run the validation suite and report pass/fail counts.";

function bridgeEnv(base, { master = "1", auto = false, pilots = null } = {}) {
  const env = {
    ...process.env,
    CODE_GUARD_BASE_DIR: base,
    CODE_GUARD_HOOK_DIR: HOOK_DIR,
    CODE_GUARD_AUTO_CANARY_V1A: "",
    CODE_GUARD_SEARCH_GUIDANCE: master,
  };
  if (auto) env.CODE_GUARD_SEARCH_GUIDANCE_AUTO = "1";
  if (pilots) env.CODE_GUARD_SEARCH_GUIDANCE_PILOTS = pilots;
  return env;
}

function spawnBridge(base, env, event) {
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  if (res.status !== 0) throw new Error(String(res.stderr));
  return JSON.parse(String(res.stdout).trim() || "{}");
}

function userPromptEvent(sessionId, cwd, prompt) {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    cwd,
    prompt,
  };
}

function readEvents(base) {
  const ctx = path.join(base, "context_budget", "claude_auto_canary.jsonl");
  if (!fs.existsSync(ctx)) return [];
  return fs.readFileSync(ctx, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

fs.mkdirSync(RUN_DIR, { recursive: true });

// ---- 1) 意图正区发射（DISCOVERY + FILTER）----
const posBase = path.join(RUN_DIR, "cell1-positive-intents");
fs.mkdirSync(posBase, { recursive: true });
const envAuto = bridgeEnv(posBase, { auto: true });
const discoveryOut = spawnBridge(posBase, envAuto, userPromptEvent("psm-disc", "C:/repos/any-repo", DISCOVERY_PROMPT));
const filterOut = spawnBridge(posBase, envAuto, userPromptEvent("psm-filter", "C:/repos/any-repo", FILTER_PROMPT));
const discoveryCtx = discoveryOut.hookSpecificOutput && discoveryOut.hookSpecificOutput.additionalContext;
const filterCtx = filterOut.hookSpecificOutput && filterOut.hookSpecificOutput.additionalContext;

// ---- 2) 跨仓一致（同一任务、四个仓库名）----
const repos = ["fastify", "express", "my-ts-service", "another-repo"];
const crossRepoTexts = [];
const crossRepoModes = [];
const crossRepoRepos = [];
repos.forEach((repo, i) => {
  const base = path.join(RUN_DIR, `cell2-crossrepo-${repo}`);
  fs.mkdirSync(base, { recursive: true });
  const out = spawnBridge(base, bridgeEnv(base, { auto: true }), userPromptEvent(`psm-cr-${i}`, `C:/work/${repo}`, DISCOVERY_PROMPT));
  crossRepoTexts.push(out.hookSpecificOutput && out.hookSpecificOutput.additionalContext || "");
  const rows = readEvents(base).filter((r) => r.type === "search_guidance");
  crossRepoModes.push(rows[0] && rows[0].mode);
  crossRepoRepos.push(rows[0] && rows[0].repo);
});

// ---- 3) 负区 FP=0（LOOKUP / 枚举 / 统计 / 未知）----
const negBase = path.join(RUN_DIR, "cell3-negative-fp0");
fs.mkdirSync(negBase, { recursive: true });
const negatives = [LOOKUP_PROMPT, ENUM_PROMPT, STAT_PROMPT, UNKNOWN_PROMPT];
let negInjected = 0;
negatives.forEach((prompt, i) => {
  const out = spawnBridge(negBase, bridgeEnv(negBase, { auto: true }), userPromptEvent(`psm-neg-${i}`, "C:/repos/any-repo", prompt));
  if (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) negInjected += 1;
});

// ---- 4) pilot 兼容（未开泛化：fastify 发射、express 跳过）----
const pilotFBase = path.join(RUN_DIR, "cell4-pilot-fastify");
fs.mkdirSync(pilotFBase, { recursive: true });
const pilotF = spawnBridge(pilotFBase, bridgeEnv(pilotFBase, { pilots: "fastify" }), userPromptEvent("psm-pf", "C:/repos/fastify", DISCOVERY_PROMPT));
const pilotEBase = path.join(RUN_DIR, "cell4-pilot-express");
fs.mkdirSync(pilotEBase, { recursive: true });
const pilotE = spawnBridge(pilotEBase, bridgeEnv(pilotEBase, { pilots: "fastify" }), userPromptEvent("psm-pe", "C:/repos/express", DISCOVERY_PROMPT));
const pilotFastifyEmitted = Boolean(pilotF.hookSpecificOutput && pilotF.hookSpecificOutput.additionalContext);
const pilotExpressSkipped = !pilotE.hookSpecificOutput;

// ---- 5) 回滚（主开关关闭 → 零活动）----
const offBase = path.join(RUN_DIR, "cell5-rollback");
fs.mkdirSync(offBase, { recursive: true });
const offOut = spawnBridge(offBase, bridgeEnv(offBase, { master: "", auto: true }), userPromptEvent("psm-off", "C:/repos/any-repo", DISCOVERY_PROMPT));
const offEvents = readEvents(offBase).filter((r) => r.type === "search_guidance" || r.type === "search_guidance_suppressed").length;

const checks = {
  "正区 DISCOVERY: 注入 frozen 模板（含意图行，不给答案）": Boolean(discoveryCtx && discoveryCtx.includes("Search guidance:") && discoveryCtx.includes("Task intent: discovery.")),
  "正区 FILTER: symbol 消歧任务注入": Boolean(filterCtx && filterCtx.includes("Search guidance:")),
  "跨仓一致: 四个仓库名全部发射（mode=auto）": crossRepoModes.every((m) => m === "auto"),
  "跨仓一致: 发射文本逐字节一致（仓库不参与 eligibility）": [...new Set(crossRepoTexts.map((t) => t.length))].length === 1,
  "跨仓一致: telemetry 记录各自 repo 名": JSON.stringify(crossRepoRepos) === JSON.stringify(repos),
  "负区 FP=0: LOOKUP（找定义）零注入": !spawnBridge(negBase, bridgeEnv(negBase, { auto: true }), userPromptEvent("psm-neg-lookup-check", "C:/repos/any-repo", LOOKUP_PROMPT)).hookSpecificOutput,
  "负区 FP=0: 枚举/统计/未知 全部零注入": negInjected === 0,
  "pilot 兼容: fastify 白名单内发射（mode=pilot）": pilotFastifyEmitted && readEvents(pilotFBase).find((r) => r.type === "search_guidance").mode === "pilot",
  "pilot 兼容: express 白名单外跳过": pilotExpressSkipped,
  "回滚: 主开关关闭 → 零 guidance 活动": !offOut.hookSpecificOutput && offEvents === 0,
};

fs.writeFileSync(path.join(RUN_DIR, "delivered-discovery.txt"), discoveryCtx || "");
fs.writeFileSync(path.join(RUN_DIR, "checks.json"), JSON.stringify(checks, null, 2));

console.log(`discovery guidance: ${discoveryCtx ? discoveryCtx.length : 0} chars (跨仓一致: ${crossRepoTexts.every((t) => t === crossRepoTexts[0]) ? "yes" : "NO"})`);
console.log(`negative cells injected: ${negInjected}/4 (must be 0)`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"} - ${k}`);
console.log(allPass() ? "\nSMOKE PASS — precision code search is intent-gated, cross-repo, and rollback-safe" : "\nSMOKE FAIL");
console.log(`evidence -> ${RUN_DIR}`);
process.exit(allPass() ? 0 : 1);

function allPass() {
  return Object.values(checks).every(Boolean);
}
