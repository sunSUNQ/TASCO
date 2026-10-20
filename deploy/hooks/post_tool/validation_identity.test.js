"use strict";

// ============================================================================
// validation_identity.test.js — Line-8A（M-V3 Semantic Validation Identity）gate
// ============================================================================
// 唯一实验变量 = sameCommand/foldCommand identity → validationIdentity/vkey。
// 判定：
//   FP（错误合并，Release blocker）= 0
//   FN（保守不合并）= 可分析、不阻断（记录在案）
// 已冻结行为不缩小：identity null 时比较层回退 raw foldCommand 恒等。
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const { validationIdentity } = require("./validation_identity");
const {
  buildFingerprint,
  sameCommand,
  tryCompressValidationDelta,
} = require("./validation_delta");

const CWD = "/repo_a";

// ---------------------------------------------------------------- fixtures
const TAP44 = [
  "TAP version 13",
  ...Array.from({ length: 44 }, (_, i) => `ok ${i + 1} - case ${i} registers the host scoped matcher`),
  "1..44",
  "# tests 44",
  "# pass 44",
  "# fail 0",
].join("\n");

const BUILD_OK = [
  "> webpack 5.89.0",
  ...Array.from({ length: 40 }, (_, i) => `asset chunk.${i}.js 12.4 KiB [emitted] [minimized]`),
  "compiled successfully",
].join("\n");

// ---------------------------------------------------------------- positive
test("identity: build 命令形态漂移收敛到同一 validation_key（tail / 2>&1 / tee）", () => {
  const plain = validationIdentity("npm run build", CWD);
  const tail = validationIdentity("npm run build | tail -60", CWD);
  const dup = validationIdentity("npm run build 2>&1 | tail -60", CWD);
  const tee = validationIdentity("npm run build | tee build.log | tail -5", CWD);
  for (const v of [plain, tail, dup, tee]) {
    assert.ok(v, "identity parses");
    assert.equal(v.kind, "build");
    assert.equal(v.target, "npm:build");
  }
  assert.equal(plain.variant, "plain");
  assert.equal(tail.variant, "wrapped");
  assert.equal(plain.key, tail.key);
  assert.equal(plain.key, dup.key);
  assert.equal(plain.key, tee.key);
});

test("identity: 重定向写文件是 presentation-only（> file 2>&1 与 plain 同 key）", () => {
  const plain = validationIdentity("npm run build", CWD);
  const toFile = validationIdentity("npm run build > build.log 2>&1", CWD);
  const append = validationIdentity("npm run build >> build.log", CWD);
  assert.equal(plain.key, toFile.key);
  assert.equal(plain.key, append.key);
});

test("identity: npm run test 与 npm test 是同一验证目标", () => {
  assert.equal(
    validationIdentity("npm run test", CWD).key,
    validationIdentity("npm test", CWD).key
  );
});

test("identity: 空白折叠后同 key（foldCommand 既有口径保持）", () => {
  assert.equal(
    validationIdentity("npm   run   build", CWD).key,
    validationIdentity("npm run build", CWD).key
  );
});

test("identity: env 前缀同值合并、异值区分（M-V3 方案一：env 入 key）", () => {
  const env = validationIdentity("NODE_ENV=production npm run build", CWD);
  const envWrapped = validationIdentity("NODE_ENV=production npm run build | tail -5", CWD);
  const plain = validationIdentity("npm run build", CWD);
  assert.ok(env && envWrapped);
  assert.equal(env.env.join(" "), "NODE_ENV=production");
  assert.equal(env.key, envWrapped.key);
  assert.notEqual(env.key, plain.key);
});

test("identity: eslint 变体同 key；kind=check", () => {
  const plain = validationIdentity("eslint lib/", CWD);
  const wrapped = validationIdentity("eslint lib/ 2>&1 | tail -60", CWD);
  assert.ok(plain && wrapped);
  assert.equal(plain.kind, "check");
  assert.equal(plain.target, "eslint lib/");
  assert.equal(plain.key, wrapped.key);
});

test("identity: 确定性——同输入同 key", () => {
  const a = validationIdentity("cargo check 2>&1 | tail -30", CWD);
  const b = validationIdentity("cargo check 2>&1 | tail -30", CWD);
  assert.equal(a.key, b.key);
});

test("identity: cwd 归一化（Windows 盘符大小写/分隔符不敏感）", () => {
  const a = validationIdentity("npm run build", "C:\\Repo\\A");
  const b = validationIdentity("npm run build", "c:/repo/a");
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, validationIdentity("npm run build", "C:\\Repo\\B").key);
});

// ---------------------------------------------------------------- negative
test("identity FP=0: build vs build:prod 恒不合并", () => {
  const a = validationIdentity("npm run build", CWD);
  const b = validationIdentity("npm run build:prod", CWD);
  assert.ok(a && b);
  assert.equal(b.target, "npm:build:prod");
  assert.notEqual(a.key, b.key);
});

test("identity FP=0: npm test vs npm test -- auth 恒不合并", () => {
  const a = validationIdentity("npm test", CWD);
  const b = validationIdentity("npm test -- auth", CWD);
  assert.ok(a && b);
  assert.deepEqual(b.relevantArgs, ["--", "auth"]);
  assert.notEqual(a.key, b.key);
});

test("identity FP=0: tsc vs tsc -p tsconfig.prod.json 恒不合并", () => {
  const a = validationIdentity("tsc", CWD);
  const b = validationIdentity("tsc -p tsconfig.prod.json", CWD);
  assert.ok(a && b);
  assert.equal(b.config, "tsconfig.prod.json");
  assert.notEqual(a.key, b.key);
});

test("identity: compound 一律 null（&& / ; / || / 后台 &）", () => {
  for (const cmd of [
    "npm run build && npm test",
    "npm run build; npm test",
    "npm run build || npm run build:prod",
    "npm run build &",
  ]) {
    assert.equal(validationIdentity(cmd, CWD), null, cmd);
  }
});

test("identity: 未知 pipeline member 一律 null（不智能猜测）", () => {
  assert.equal(validationIdentity("npm run build | wc -l", CWD), null);
  assert.equal(validationIdentity("npm run build | grep error", CWD), null);
  assert.equal(validationIdentity("npm run build | head -20 | sort", CWD), null);
});

test("identity: 变异/watch 参数 fail-closed（冻结负区不扩大）", () => {
  assert.equal(validationIdentity("eslint . --fix", CWD), null);
  assert.equal(validationIdentity("ruff check . --fix", CWD), null);
  assert.equal(validationIdentity("npm run lint -- --watch", CWD), null);
});

test("identity: 非验证命令 null", () => {
  for (const cmd of ["ls -la", "npm install", "git status", "npm run format"]) {
    assert.equal(validationIdentity(cmd, CWD), null, cmd);
  }
});

test("identity: 畸形输入 null（空 / 尾管道 / 引号 / 命令替换 / 子 shell）", () => {
  for (const cmd of [
    "",
    "   ",
    "npm run build |",
    '| npm run build',
    'npm run "build x"',
    "npm run `echo build`",
    "npm run $(echo build)",
  ]) {
    assert.equal(validationIdentity(cmd, CWD), null, JSON.stringify(cmd));
  }
});

test("identity: stdin 重定向 / heredoc null（可能改变被验证行为）", () => {
  assert.equal(validationIdentity("npm run build < input.txt", CWD), null);
  assert.equal(validationIdentity("npm run build << EOF", CWD), null);
});

test("identity FP=0: 工具链差异保守区分（FN 记录在案，不阻断）", () => {
  // npm vs yarn 同 script：保守不合并
  assert.notEqual(
    validationIdentity("npm run build", CWD).key,
    validationIdentity("yarn build", CWD).key
  );
  // cargo check vs cargo clippy：lint 集不同
  assert.notEqual(
    validationIdentity("cargo check", CWD).key,
    validationIdentity("cargo clippy", CWD).key
  );
  // npx tsc vs tsc：npx 可能解析不同工具版本（保守 FN）
  assert.notEqual(
    validationIdentity("npx tsc --noEmit", CWD).key,
    validationIdentity("tsc --noEmit", CWD).key
  );
});

// ---------------------------------------------------------------- 结构字段
test("identity: 结构字段完整（kind/target/config/relevantArgs/env）", () => {
  const v = validationIdentity("npx tsc --noEmit", CWD);
  assert.equal(v.kind, "build");
  assert.equal(v.target, "npx tsc");
  assert.deepEqual(v.relevantArgs, ["--noEmit"]);
  assert.equal(v.config, "");

  const p = validationIdentity("tsc -p tsconfig.prod.json", CWD);
  assert.equal(p.target, "tsc");
  assert.equal(p.config, "tsconfig.prod.json");

  const t = validationIdentity("npm test -- auth", CWD);
  assert.equal(t.kind, "test");
  assert.equal(t.target, "npm:test");
  assert.deepEqual(t.relevantArgs, ["--", "auth"]);

  const e = validationIdentity("NODE_ENV=production npm run build", CWD);
  assert.deepEqual(e.env, ["NODE_ENV=production"]);
});

// ---------------------------------------------------------------- VD 集成
test("VD 集成: baseline plain → current wrapped 变体可比（M-V3 正区）", () => {
  const prev = buildFingerprint({ command: "npm run build", text: BUILD_OK, cwd: CWD });
  assert.ok(prev && prev.vkey, "fingerprint carries vkey");
  assert.equal(sameCommand(prev, "npm run build | tail -60", CWD), true);
  const r = tryCompressValidationDelta({
    command: "npm run build | tail -60",
    text: BUILD_OK,
    previous: prev,
    cwd: CWD,
  });
  assert.ok(r, "delta produced");
  assert.equal(r.mode, "success_unchanged");
  assert.match(r.deltaText, /^\[VALIDATION_DELTA\]/);
});

test("VD 集成: baseline wrapped → current plain 同样可比（方向对称）", () => {
  const prev = buildFingerprint({ command: "npm run build | tee build.log | tail -5", text: BUILD_OK, cwd: CWD });
  assert.equal(sameCommand(prev, "npm run build", CWD), true);
});

test("VD 集成: compound current 不得与 plain baseline 比较（fail-closed）", () => {
  const prev = buildFingerprint({ command: "npm run build", text: BUILD_OK, cwd: CWD });
  assert.equal(sameCommand(prev, "npm run build && echo done", CWD), false);
  assert.equal(
    tryCompressValidationDelta({
      command: "npm run build && echo done",
      text: BUILD_OK,
      previous: prev,
      cwd: CWD,
    }),
    null
  );
});

test("VD 集成: legacy 无 vkey 记录回退 raw 恒等（不缩小已冻结行为）", () => {
  const legacy = {
    ok: true,
    countsAvailable: false,
    kind: "build",
    state: "success",
    command: "npm run build",
    at: new Date().toISOString(),
    counts: { pass: 0, fail: 0, skip: 0, todo: 0 },
    caseCount: 0,
    passedCount: 0,
    failedNames: [],
  };
  assert.equal(sameCommand(legacy, "npm run build"), true); // raw 恒等保持
  assert.equal(sameCommand(legacy, "npm run build | tail -60", CWD), false); // FN（可分析，不阻断）
});

test("VD 集成: test 族 counts 比对经 wrapped 变体仍成立", () => {
  const prev = buildFingerprint({ command: "npm test", text: TAP44, cwd: CWD });
  assert.equal(sameCommand(prev, "npm test | tail -20", CWD), true);
  const r = tryCompressValidationDelta({
    command: "npm test | tail -20",
    text: TAP44,
    previous: prev,
    cwd: CWD,
  });
  assert.ok(r);
  assert.equal(r.mode, "success_unchanged");
  assert.match(r.deltaText, /pass=44/);
});

test("VD 集成: evidence gate 不被 identity bypass（unknown 输出 → fp null / 无 delta）", () => {
  assert.equal(buildFingerprint({ command: "npm run build", text: "boom, no shape", cwd: CWD }), null);
  const prev = buildFingerprint({ command: "npm run build", text: BUILD_OK, cwd: CWD });
  assert.equal(
    tryCompressValidationDelta({
      command: "npm run build | tail -60",
      text: "boom, no shape",
      previous: prev,
      cwd: CWD,
    }),
    null
  );
});

test("VD 集成: 失败 current 不产生 delta（既有边界保持）", () => {
  const prev = buildFingerprint({ command: "npm test", text: TAP44, cwd: CWD });
  const failText = TAP44.replace("# pass 44", "# pass 43").replace("# fail 0", "# fail 1") + "\nnot ok 44 - case 43";
  assert.equal(
    tryCompressValidationDelta({ command: "npm test | tail -20", text: failText, previous: prev, cwd: CWD }),
    null
  );
});
