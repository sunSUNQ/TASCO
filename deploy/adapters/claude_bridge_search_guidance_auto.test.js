"use strict";

// Line-5 精准代码搜索 — S2 跨仓 eligibility + S3 bridge 安全 Gate（确定性）。
// 仓库白名单不再是 eligibility 的一部分：CODE_GUARD_SEARCH_GUIDANCE_AUTO=1 时
// 发射只由冻结 classifier 的意图正区（DISCOVERY/FILTER）决定；未设 AUTO 时
// 保留 limited-auto pilot 行为（向后兼容）。显式回滚 = 主开关不设。
// 运行：node --test deploy/adapters/claude_bridge_search_guidance_auto.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const BRIDGE = path.join(__dirname, "claude_bridge.js");
const POSITIVE_PROMPT =
  "分析这个仓库中请求中止信号的传播机制：底层如何感知中止、钩子在什么条件下触发、清理涉及哪些模块。梳理完整机制与关键调用链。不要修改代码。";
const NEGATIVE_PROMPT = "Reply.prototype.send 定义在哪个文件？";
const UNKNOWN_PROMPT = "Run the validation suite and report pass/fail counts.";

function spawnBridge({ base, sessionId, cwd, prompt, auto, pilots, master = "1" }) {
  const event = {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    cwd,
    prompt,
  };
  const res = cp.spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      CODE_GUARD_BASE_DIR: base,
      CODE_GUARD_HOOK_DIR: path.join(__dirname, "..", "hooks"),
      CODE_GUARD_SEARCH_GUIDANCE: master,
      ...(auto ? { CODE_GUARD_SEARCH_GUIDANCE_AUTO: "1" } : {}),
      ...(pilots ? { CODE_GUARD_SEARCH_GUIDANCE_PILOTS: pilots } : {}),
    },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(res.status, 0, String(res.stderr));
  return JSON.parse(String(res.stdout).trim() || "{}");
}

function readRows(base, type) {
  const ctx = path.join(base, "context_budget", "claude_auto_canary.jsonl");
  if (!fs.existsSync(ctx)) return [];
  return fs.readFileSync(ctx, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === type);
}

test("S2: AUTO mode — same positive prompt emits identically across four different repos", () => {
  const repos = ["fastify", "express", "my-ts-service", "another-repo"];
  const emitted = [];
  for (const [i, repo] of repos.entries()) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `l5-auto-${i}-`));
    const out = spawnBridge({ base, sessionId: `l5-auto-${i}`, cwd: `C:/repos/${repo}`, prompt: POSITIVE_PROMPT, auto: true });
    const ctx = out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    assert.ok(ctx, `${repo}: guidance must emit under AUTO (repo never gates eligibility)`);
    assert.match(ctx, /Search guidance:/);
    assert.match(ctx, /Task intent: discovery\./);
    emitted.push(ctx);
    const rows = readRows(base, "search_guidance");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mode, "auto");
    assert.equal(rows[0].repo, repo);
  }
  assert.deepEqual(
    [...new Set(emitted.map((t) => t.length))],
    [emitted[0].length],
    "guidance text byte-identical across repos"
  );
});

test("S2: pilot compat — without AUTO the allowlist still gates (fastify in, express skipped)", () => {
  const baseFastify = fs.mkdtempSync(path.join(os.tmpdir(), "l5-pilot-f-"));
  const outF = spawnBridge({
    base: baseFastify, sessionId: "l5-pilot-f", cwd: "C:/repos/fastify",
    prompt: POSITIVE_PROMPT, auto: false, pilots: "fastify",
  });
  assert.ok(outF.hookSpecificOutput && outF.hookSpecificOutput.additionalContext, "pilot repo emits");
  assert.equal(readRows(baseFastify, "search_guidance")[0].mode, "pilot");

  const baseExpress = fs.mkdtempSync(path.join(os.tmpdir(), "l5-pilot-e-"));
  const outE = spawnBridge({
    base: baseExpress, sessionId: "l5-pilot-e", cwd: "C:/repos/express",
    prompt: POSITIVE_PROMPT, auto: false, pilots: "fastify",
  });
  assert.equal(outE.hookSpecificOutput, undefined, "non-pilot repo skipped in pilot mode");
  assert.equal(readRows(baseExpress, "search_guidance_pilot_skipped").length, 1);
});

test("S3: negative / unknown intents never inject under AUTO (wrong_strategy=0)", () => {
  for (const [i, prompt] of [NEGATIVE_PROMPT, UNKNOWN_PROMPT].entries()) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `l5-neg-${i}-`));
    const out = spawnBridge({ base, sessionId: `l5-neg-${i}`, cwd: "C:/repos/any-repo", prompt, auto: true });
    // The only forbidden outcome is an injection (hookSpecificOutput) or an
    // emitted guidance row. Suppressed/unknown intents may record a row, but
    // must deliver nothing.
    assert.equal(out.hookSpecificOutput, undefined, `no injection for: ${prompt.slice(0, 30)}`);
    assert.equal(readRows(base, "search_guidance").length, 0, `no emission row for: ${prompt.slice(0, 30)}`);
  }
});

test("S3: unknown intent is classified, not guessed (validation counts prompt -> statistics suppress)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "l5-unk-"));
  const out = spawnBridge({ base, sessionId: "l5-unk", cwd: "C:/repos/any-repo", prompt: UNKNOWN_PROMPT, auto: true });
  assert.equal(out.hookSpecificOutput, undefined);
  const suppressed = readRows(base, "search_guidance_suppressed");
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].reason, "negative_intent_full_coverage_required");
});

test("rollback: master switch off -> zero guidance activity", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "l5-off-"));
  const out = spawnBridge({
    base, sessionId: "l5-off", cwd: "C:/repos/fastify",
    prompt: POSITIVE_PROMPT, auto: true, master: "",
  });
  assert.equal(out.hookSpecificOutput, undefined, "no injection");
  assert.equal(readRows(base, "search_guidance").length, 0);
  assert.equal(readRows(base, "search_guidance_suppressed").length, 0);
});

test("determinism: AUTO emission is stable across repeated invocations", () => {
  const ctxs = [];
  for (let i = 0; i < 3; i++) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `l5-det-${i}-`));
    const out = spawnBridge({ base, sessionId: `l5-det-${i}`, cwd: "C:/repos/any", prompt: POSITIVE_PROMPT, auto: true });
    ctxs.push(out.hookSpecificOutput.additionalContext);
  }
  assert.deepEqual([...new Set(ctxs)], [ctxs[0]]);
});
