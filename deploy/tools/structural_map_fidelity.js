#!/usr/bin/env node
"use strict";

// Structural Map Producer — Fidelity Gate V1（2026-08-31）。
// 对比自动 map 与冻结 map（关系集合），输出节点覆盖 / 边召回 / 边精度。
// 纯确定性，无模型。
//
// 用法：
//   node structural_map_fidelity.js --root <repo> --mode callgraph|moduledeps \
//     --expected <expected_map.txt>
//
// 归一化：moduledeps 中 util_N.js → util_*.js；callgraph 中额外的
// "(none)" 行不计为边（只影响展示，不影响关系精度）。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = path.resolve(argValue("--root") || ".");
const MODE = argValue("--mode") || "callgraph";
const EXPECTED = path.resolve(argValue("--expected") || "");
const PRODUCER = path.join(__dirname, "structural_map_producer.js");

function parseLines(text, mode) {
  const lines = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("[") || /^(call graph|module imports)/.test(t)) continue;
    const m = t.match(/^(.+?)\s*→\s*(.+)$/);
    if (!m) continue;
    let src = m[1].trim();
    let dst = m[2].trim();
    if (mode === "moduledeps") {
      src = src.replace(/util_\d+\.js/i, "util_*.js");
      dst = dst.replace(/util_\d+\.js/i, "util_*.js");
    }
    lines.push({ src, dst, isNone: dst === "(none)" });
  }
  return lines;
}

function main() {
  const r = spawnSync(process.execPath, [PRODUCER, "--root", ROOT, "--mode", MODE], {
    encoding: "utf8",
  });
  const produced = parseLines(r.stdout, MODE);
  const expected = parseLines(fs.readFileSync(EXPECTED, "utf8"), MODE);

  const expEdges = expected.filter((e) => !e.isNone);
  const prodEdges = produced.filter((e) => !e.isNone);
  const expNodes = new Set(expEdges.flatMap((e) => [e.src, e.dst]));
  const prodNodes = new Set(prodEdges.flatMap((e) => [e.src, e.dst]));
  const prodEdgeSet = new Set(prodEdges.map((e) => `${e.src}->${e.dst}`));
  const expEdgeSet = new Set(expEdges.map((e) => `${e.src}->${e.dst}`));

  const missingNodes = [...expNodes].filter((n) => !prodNodes.has(n));
  const missingEdges = [...expEdgeSet].filter((e) => !prodEdgeSet.has(e));
  const extraEdges = [...prodEdgeSet].filter((e) => !expEdgeSet.has(e));
  const recall = expEdgeSet.size ? (expEdgeSet.size - missingEdges.length) / expEdgeSet.size : 1;
  const precision = prodEdgeSet.size ? (prodEdgeSet.size - extraEdges.length) / prodEdgeSet.size : 1;
  const coverage = expNodes.size ? (expNodes.size - missingNodes.length) / expNodes.size : 1;

  console.log(`=== Structural Map Fidelity Gate (${MODE}) ===`);
  console.log(`root: ${ROOT}`);
  console.log(`node coverage: ${(100 * coverage).toFixed(1)}% (${expNodes.size - missingNodes.length}/${expNodes.size})`);
  console.log(`edge recall:    ${(100 * recall).toFixed(1)}% (${expEdgeSet.size - missingEdges.length}/${expEdgeSet.size})`);
  console.log(`edge precision: ${(100 * precision).toFixed(1)}% (${prodEdgeSet.size - extraEdges.length}/${prodEdgeSet.size})`);
  if (missingNodes.length) console.log(`missing nodes: ${missingNodes.join(" | ")}`);
  if (missingEdges.length) console.log(`missing edges: ${missingEdges.join(" | ")}`);
  if (extraEdges.length) console.log(`extra edges:   ${extraEdges.join(" | ")}`);
  const pass = coverage >= 1 && recall >= 0.95 && precision >= 0.95;
  console.log(`GATE: ${pass ? "PASS" : "FAIL"} (coverage=100%, recall>=95%, precision>=95%)`);
  process.exit(pass ? 0 : 1);
}

main();
