"use strict";

// ============================================================================
// map_provider.test.js — Line-6 Map On-Demand（R2/R3 关系事实供给）测试
// ============================================================================
// 覆盖：cache miss 按需生成（真实冻结 producer）+ 盖章写回 + R2 primitive
// 消费；cache 命中零生成；head 过期重建；legacy map 不动；env map 原样；
// 失败墓碑；allowBuild=false；invalid schema 重建。
// 运行：node --test deploy/hooks/structural_router/map_provider.test.js
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const { resolveOrBuildModuleMap } = require("./map_provider.js");
const { buildRelationEvidence } = require("./read_relation_evidence.js");

function git(args, cwd) {
  const res = cp.spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15000 });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(res.stderr).slice(0, 200)}`);
  return String(res.stdout).trim();
}

function makeRepo({ git: withGit, files }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-prov-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  if (withGit) {
    git(["init"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@local", "add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init", "--quiet"], dir);
  }
  return dir;
}

const A_SRC = "'use strict';\nconst { run } = require('./b');\nfunction entry() { return run(1); }\nmodule.exports = { entry };\n";
const B_SRC = "'use strict';\nfunction run(x) { return x + 1; }\nmodule.exports = { run };\n";

test("cache miss: builds map via frozen producer, stamps repo_head, writes cache; R2 primitive consumes it", () => {
  const dir = makeRepo({ git: false, files: { "lib/a.js": A_SRC, "lib/b.js": B_SRC } });
  const map = resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: true });
  assert.ok(map, "map built on demand");
  const parsed = JSON.parse(map);
  assert.equal(parsed.schema, "structural-moduledeps-identity-v2");
  assert.equal(parsed.nodes.length, 2);
  assert.ok("repo_head" in parsed, "generation stamped");
  const cached = JSON.parse(fs.readFileSync(path.join(dir, ".tasco", "identity_map.json"), "utf8"));
  assert.equal(cached.nodes.length, 2);

  // R2 primitive consumes the generated map (entry resolution + edges).
  const ev = buildRelationEvidence({
    task_text: "Analyze lib/a.js: trace its direct dependency path. Do not modify files.",
    module_map: map,
    task_class: "R2",
  });
  assert.ok(ev, "evidence built from on-demand map");
  assert.equal(ev.entry_path, "lib/a.js");
  assert.ok(ev.edges.some((e) => e.to === "lib/b.js"), "edge a->b present");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cache hit: fresh map returns without invoking the producer", () => {
  const dir = makeRepo({ git: false, files: { "lib/a.js": A_SRC, "lib/b.js": B_SRC } });
  const first = resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: true });
  assert.ok(first);
  const throwing = () => { throw new Error("producer must not run on cache hit"); };
  const second = resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: true, spawnSync: throwing });
  assert.equal(second, first, "cache served byte-identical");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stale map (repo_head changed) is rebuilt with the new head stamp", () => {
  const dir = makeRepo({ git: true, files: { "lib/a.js": A_SRC, "lib/b.js": B_SRC } });
  const head1 = git(["rev-parse", "HEAD"], dir);
  const first = resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: true });
  assert.equal(JSON.parse(first).repo_head, head1);

  // 代码变化：新文件 + 新 commit → head 变化 → 重建（新边进入 map）
  fs.writeFileSync(path.join(dir, "lib/c.js"), "'use strict';\nconst { entry } = require('./a');\nmodule.exports = { entry };\n", "utf8");
  git(["-c", "user.name=t", "-c", "user.email=t@local", "add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "add c", "--quiet"], dir);
  const head2 = git(["rev-parse", "HEAD"], dir);
  assert.notEqual(head1, head2);

  const second = resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: true });
  const parsed = JSON.parse(second);
  assert.equal(parsed.repo_head, head2, "rebuilt with fresh head stamp");
  assert.ok(parsed.nodes.some((n) => n.source_path === "lib/c.js"), "new node in rebuilt map");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy/operator map without repo_head stamp is accepted as-is (never rebuilt)", () => {
  const dir = makeRepo({ git: false, files: {} });
  const cacheDir = path.join(dir, ".tasco");
  fs.mkdirSync(cacheDir, { recursive: true });
  const legacy = JSON.stringify({
    schema: "structural-moduledeps-identity-v2",
    nodes: [{ source_path: "lib/x.js", source_basename: "x.js", targets: [] }],
  }, null, 2);
  fs.writeFileSync(path.join(cacheDir, "identity_map.json"), legacy, "utf8");
  const throwing = () => { throw new Error("producer must not run for legacy stamped map"); };
  const map = resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: true, spawnSync: throwing });
  assert.equal(map, legacy, "legacy map served byte-identical");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("explicit env map is operator-owned: used as-is, never rebuilt, invalid -> null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-env-"));
  const mapPath = path.join(dir, "explicit.json");
  const map = JSON.stringify({
    schema: "structural-moduledeps-identity-v2",
    nodes: [{ source_path: "lib/x.js", source_basename: "x.js", targets: [] }],
  });
  fs.writeFileSync(mapPath, map, "utf8");
  const throwing = () => { throw new Error("producer must not run for explicit env map"); };
  assert.equal(
    resolveOrBuildModuleMap({ cwd: dir, envMapPath: mapPath, allowBuild: true, spawnSync: throwing }),
    map
  );
  fs.writeFileSync(mapPath, "{ not json", "utf8");
  assert.equal(
    resolveOrBuildModuleMap({ cwd: dir, envMapPath: mapPath, allowBuild: true, spawnSync: throwing }),
    null,
    "invalid env map -> null (fail-closed, no guessing)"
  );
  assert.equal(resolveOrBuildModuleMap({ cwd: dir, envMapPath: path.join(dir, "missing.json"), allowBuild: true }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("build failure (no .js files -> empty map) writes a tombstone; same head retries are skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-fail-"));
  const first = resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: true });
  assert.equal(first, null, "empty map invalid -> null");
  assert.ok(fs.existsSync(path.join(dir, ".tasco", "identity_map.failed.json")), "tombstone written");
  const throwing = () => { throw new Error("producer must not retry within same head"); };
  const second = resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: true, spawnSync: throwing });
  assert.equal(second, null, "tombstone hit -> null without producer run");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("allowBuild=false: no build attempted; existing cache still served", () => {
  const dir = makeRepo({ git: false, files: { "lib/a.js": A_SRC, "lib/b.js": B_SRC } });
  const throwing = () => { throw new Error("producer must not run when allowBuild=false"); };
  assert.equal(resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: false, spawnSync: throwing }), null);
  // 先手动放一个 cache → allowBuild=false 仍应命中（读不建）
  const cacheDir = path.join(dir, ".tasco");
  fs.mkdirSync(cacheDir, { recursive: true });
  const manual = JSON.stringify({
    schema: "structural-moduledeps-identity-v2",
    nodes: [{ source_path: "lib/a.js", source_basename: "a.js", targets: [{ target_path: "lib/b.js", target_basename: "b.js" }] }],
  });
  fs.writeFileSync(path.join(cacheDir, "identity_map.json"), manual, "utf8");
  assert.equal(
    resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: false, spawnSync: throwing }),
    manual
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("invalid schema cache is rebuilt (not served)", () => {
  const dir = makeRepo({ git: false, files: { "lib/a.js": A_SRC, "lib/b.js": B_SRC } });
  const cacheDir = path.join(dir, ".tasco");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "identity_map.json"), JSON.stringify({ schema: "wrong", nodes: [] }), "utf8");
  const map = resolveOrBuildModuleMap({ cwd: dir, envMapPath: null, allowBuild: true });
  assert.ok(map, "invalid cache rebuilt");
  assert.equal(JSON.parse(map).schema, "structural-moduledeps-identity-v2");
  fs.rmSync(dir, { recursive: true, force: true });
});
