#!/usr/bin/env node
"use strict";

// Structural Map Producer V1（2026-08-31，spec：
// docs/experiments/structural/STRUCTURAL-MAP-PRODUCTION-V1.md）。
//
// 确定性、无依赖、无 agent、无网络。只生产两类关系 map：
//   --mode callgraph    direct call graph：caller 函数(文件) → callee 函数(文件)
//   --mode moduledeps   module imports (direct)：文件 → 直接依赖文件
//
// v1.1 覆盖：ESM `import { X } from "./rel"` + CJS `require("./rel")`
//（含解构 `const { A } = require(...)`）+ `export function F(`，
// call-site 扫描（函数体 brace-match 内的 `IDENT(` 调用，仅统计导入符号）。
// 输出形态与冻结 map（pilot_manifests/compression_lab_struct_tasks.json）
// 同构；AST 精确 call-site 与 TS 留给后续迭代。

const fs = require("fs");
const path = require("path");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = path.resolve(argValue("--root") || ".");
const MODE = argValue("--mode") || "callgraph";
const FORMAT = argValue("--format") || "text";
const SKIP_DIRS = new Set(["node_modules", "test", "tests", "dist", "build", ".git"]);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (e.name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out;
}

function parseImports(src) {
  // ESM: import { A, B } from "./rel";  /  import def from "./rel";
  const byTarget = new Map();
  const push = (target, symbols) => {
    // 只保留相对路径（跳过 node: 内置与外部包）
    if (!/^\.\.?\//.test(target)) return;
    const t = target.replace(/\\/g, "/");
    if (!byTarget.has(t)) byTarget.set(t, new Set());
    for (const s of symbols) if (s) byTarget.get(t).add(s);
  };
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const symbols = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    push(m[2], symbols);
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*from\s*["']([^"']+)["']/g)) {
    push(m[2], [m[1]]);
  }
  // CJS destructured: const { A, B } = require("./rel");
  for (const m of src.matchAll(
    /const\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g
  )) {
    const symbols = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    push(m[2], symbols);
  }
  // CJS default: const A = require("./rel");
  for (const m of src.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g
  )) {
    push(m[2], [m[1]]);
  }
  return [...byTarget].map(([target, symbols]) => ({ target, symbols: [...symbols] }));
}

function exportedFunctions(src) {
  const out = [];
  for (const m of src.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    out.push({ name: m[1], index: m.index });
  }
  return out;
}

function braceBody(src, openIndex) {
  // 从 openIndex 的 '(' 起找匹配 ')'，再从其后找 '{' 到匹配 '}'
  let i = openIndex;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    i += 1;
  }
  const brace = src.indexOf("{", i);
  if (brace < 0) return null;
  depth = 0;
  let j = brace;
  while (j < src.length) {
    const c = src[j];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    j += 1;
  }
  return j < src.length ? src.slice(brace + 1, j) : null;
}

function calledSymbols(body) {
  const set = new Set();
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) set.add(m[1]);
  return set;
}

function relFrom(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function main() {
  const files = walk(ROOT, []).sort();
  const fileMeta = new Map(); // abs -> { rel, src, imports, functions }
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    fileMeta.set(f, {
      rel: relFrom(ROOT, f),
      src,
      imports: parseImports(src),
      functions: exportedFunctions(src),
    });
  }

  const symbolOwner = new Map(); // symbol -> abs file（导入符号的来源解析）
  const moduleEdges = new Map(); // abs -> target abs[]

  for (const [f, meta] of fileMeta) {
    const dir = path.dirname(f);
    for (const imp of meta.imports) {
      // Node 风格解析：先按原路径，再补 .js / index.js
      let target = path.resolve(dir, imp.target);
      if (!fileMeta.has(target)) {
        const withJs = `${target}.js`;
        if (fileMeta.has(withJs)) target = withJs;
        else {
          const indexJs = path.join(target, "index.js");
          if (fileMeta.has(indexJs)) target = indexJs;
        }
      }
      if (!fileMeta.has(target)) continue;
      if (!moduleEdges.has(f)) moduleEdges.set(f, []);
      moduleEdges.get(f).push(target);
      for (const s of imp.symbols) symbolOwner.set(`${path.basename(f)}::${s}`, target);
    }
  }

  if (MODE === "moduledeps") {
    if (FORMAT === "identity-json") {
      const nodes = files.map((f) => ({
        source_path: relFrom(ROOT, f),
        source_basename: path.basename(f),
        targets: (moduleEdges.get(f) || []).map((target) => ({
          target_path: relFrom(ROOT, target),
          target_basename: path.basename(target),
        })),
      }));
      console.log(
        JSON.stringify({ schema: "structural-moduledeps-identity-v2", nodes }, null, 2)
      );
      return;
    }
    if (FORMAT !== "text") {
      throw new Error(`unknown moduledeps format: ${FORMAT} (text|identity-json)`);
    }
    for (const f of files) {
      const deps = (moduleEdges.get(f) || []).map((t) => path.basename(t));
      console.log(
        `${path.basename(f)} → ${deps.length ? deps.join(", ") : "(none)"}`
      );
    }
    return;
  }

  if (MODE === "callgraph") {
    console.log("call graph (direct):");
    for (const [f, meta] of fileMeta) {
      const importedSymbols = new Set(meta.imports.flatMap((i) => i.symbols));
      const fileCalls = new Set(); // symbol 名（调用）
      for (const fn of meta.functions) {
        const body = braceBody(meta.src, fn.index + fn.name.length + 1);
        if (!body) continue;
        for (const s of calledSymbols(body)) {
          if (importedSymbols.has(s)) fileCalls.add(s);
        }
      }
      const edges = [...fileCalls].sort().map((s) => {
        const owner = symbolOwner.get(`${path.basename(f)}::${s}`);
        return owner ? `${fnLabel(f, meta)} → ${s}` : `${fnLabel(f, meta)} → ${s}(unresolved)`;
      });
      // 逐函数输出（与冻结形态一致：函数级）
      for (const fn of meta.functions) {
        const body = braceBody(meta.src, fn.index + fn.name.length + 1);
        const calls = body
          ? [...calledSymbols(body)].filter((s) => importedSymbols.has(s)).sort()
          : [];
        const label = `${fn.name} (${meta.rel})`;
        if (!calls.length) {
          console.log(`${label} → (none)`);
        } else {
          for (const s of calls) console.log(`${label} → ${s}`);
        }
      }
    }
    return;
  }

  throw new Error(`unknown mode: ${MODE} (callgraph|moduledeps)`);
}

function fnLabel(f, meta) {
  return meta.functions.length ? meta.functions[0].name : path.basename(f);
}

main();
