#!/usr/bin/env node
"use strict";
// Deterministic deploy manifest generator for the TASCO public release repo.
//
// This repo mirrors the deploy closure to ROOT (adapters/core/hooks/plugin/
// skills/specs/tools/config + requirements.txt + run-tasco-task.ps1). The
// nested deploy/ tree is the authoritative source (with tests and experimental
// transport guards) kept alongside for reproducibility; it is NOT payload.
//
// Source provenance (two-phase commit contract):
//   Phase 1 — commit the runtime code + docs + this generator (no manifest).
//             That commit SHA is the traceable "sourceCommit".
//   Phase 2 — run this generator with --source-commit <phase1-sha> to write
//             deploy_manifest.json recording that SHA, then commit the manifest.
//   The final manifest commit therefore NEVER records its own HEAD as
//   sourceCommit (no self-reference loop), and regeneration is deterministic.
//
// Usage:
//   node product/tools/build_deploy_manifest.js [--source-commit <sha>]   # write
//   node product/tools/build_deploy_manifest.js --check                    # verify
//
// --check verifies the on-disk manifest against the tree WITHOUT writing and
// WITHOUT consulting HEAD, so it still passes after the final commit.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST = path.join(ROOT, "deploy_manifest.json");

const PAYLOAD_DIRS = ["adapters", "config", "core", "hooks", "plugin", "skills", "specs", "tools"];
const PAYLOAD_ENTRY_FILES = ["requirements.txt", "run-tasco-task.ps1"];

function isExcludedPayload(rel) {
  if (rel.endsWith(".test.js")) return true;
  if (rel.includes("__pycache__")) return true;
  if (rel.endsWith(".pyc") || rel.endsWith(".pyo")) return true;
  if (rel === "tools/frozen_maps" || rel.startsWith("tools/frozen_maps/")) return true;
  return false;
}

function isExcludedShipped(rel) {
  if (rel === "deploy_manifest.json") return true;
  if (rel === ".gitattributes" || rel === ".gitignore") return true;
  if (rel.startsWith("tools/frozen_maps/") || rel.startsWith("deploy/tools/frozen_maps/")) return true;
  if (rel.includes("__pycache__")) return true;
  if (rel.endsWith(".pyc") || rel.endsWith(".pyo")) return true;
  if (rel === "product" || rel.startsWith("product/")) return true; // build tooling, not product
  if (rel === "docs" || rel.startsWith("docs/")) return true; // review/audit metadata, not product payload
  return false;
}

function sha256File(abs) {
  return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

function walkPayload() {
  const out = [];
  const push = (dir, base) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) push(abs, rel);
      else out.push(rel);
    }
  };
  for (const d of PAYLOAD_DIRS) push(path.join(ROOT, d), d);
  for (const f of PAYLOAD_ENTRY_FILES) out.push(f);
  return out.filter((rel) => !isExcludedPayload(rel)).sort();
}

function listShipped() {
  const out = cp
    .execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return out.filter((rel) => !isExcludedShipped(rel)).sort();
}

// ---- require closure gate (comment-stripped, quote-aware) -----------------
function stripComments(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const lines = out.split("\n").map((line) => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"' || c === "`") {
        quote = c;
      } else if (c === "/" && line[i + 1] === "/") {
        return line.slice(0, i);
      }
    }
    return line;
  });
  return lines.join("\n");
}

function resolveRequire(fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const fromDir = path.posix.dirname(fromRel);
  let target = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [];
  if (target.endsWith(".js")) candidates.push(target);
  else {
    candidates.push(`${target}.js`);
    candidates.push(`${target}/index.js`);
  }
  return candidates;
}

function closureCheck(payloadSet, files) {
  const missing = [];
  for (const rel of files) {
    if (!rel.endsWith(".js")) continue;
    const abs = path.join(ROOT, ...rel.split("/"));
    const text = stripComments(fs.readFileSync(abs, "utf8"));
    const re = /require\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const candidates = resolveRequire(rel, m[1]);
      if (!candidates) continue;
      const hit = candidates.find((c) => payloadSet.has(c));
      if (!hit) missing.push({ from: rel, spec: m[1], tried: candidates });
    }
  }
  return missing;
}

function gitRev(args) {
  const r = cp.spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} failed`);
  return r.stdout.trim();
}

// generatedAt must be a pure function of sourceCommit so that regenerating the
// manifest from the same source commit yields byte-identical output (no wall
// clock in the manifest). Derive it from the source commit's committer date.
function commitDateIso(sha) {
  const iso = gitRev(["show", "-s", "--format=%cI", `${sha}^{commit}`]);
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function build(sourceCommit) {
  const payloadFiles = walkPayload();
  const payloadSet = new Set(payloadFiles);
  const closure = closureCheck(payloadSet, payloadFiles);
  if (closure.length) {
    console.error("== CLOSURE GATE FAILED ==");
    for (const x of closure) console.error(`  ${x.from}  requires  ${x.spec}  (tried: ${x.tried.join(", ")})`);
    process.exit(1);
  }

  const shippedFiles = listShipped();
  const sha256 = {};
  for (const rel of shippedFiles) sha256[rel] = sha256File(path.join(ROOT, ...rel.split("/")));

  const old = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const manifest = {
    version: old.version,
    releaseTag: old.releaseTag,
    sourceCommit,
    runtimeBaseline: old.runtimeBaseline,
    buildType: "deploy-closure",
    dirtySourceAllowed: false,
    payloadFileCount: payloadFiles.length,
    packageFileCount: payloadFiles.length + 4, // +4 top-level deployment docs
    capabilities: old.capabilities,
    supportedAgents: old.supportedAgents,
    qualificationModel: old.qualificationModel,
    architecture: old.architecture,
    deploymentTransforms: old.deploymentTransforms,
    runtimeDependencies: old.runtimeDependencies,
    files: payloadFiles,
    sha256,
    generatedAt: commitDateIso(sourceCommit),
    capabilityOptions: old.capabilityOptions,
    payloadScope: old.payloadScope,
    smokeFixtures: old.smokeFixtures,
    inputPreprocessing: {
      note: "Pre-arbitration input normalization. These are NOT compression winners: they only fold repeated structure inside an existing winner branch and never create a fifth winner or expand the default compression scope.",
      testBuildStructured: {
        flag: "CODE_GUARD_TEST_BUILD_STRUCTURED",
        default: "ON (runner default)",
        kind: "pre-arbitration input normalization for the quick_shell diagnostic winner path",
        patterns: "P1 consecutive same-file stack frames; P2 identical-signature Error lines; P3 consecutive exact-duplicate boilerplate; P4 failure-group boilerplate; P5 lint-rule violation aggregation",
        retentionContract: "every 'not ok' line, first 'Error:' line, and every assertion line survives verbatim (mechanical self-check; failure -> ineligible)",
        killSwitch: "CODE_GUARD_TEST_BUILD_STRUCTURED=0 restores legacy quick_shell semantics",
      },
    },
  };
  return manifest;
}

function verifyOnDisk() {
  const dm = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

  // 1) payload closure: every listed file present + hash matches
  let ok = 0;
  const bad = [];
  for (const rel of dm.files) {
    const abs = path.join(ROOT, ...rel.split("/"));
    if (!fs.existsSync(abs)) { bad.push([rel, "missing"]); continue; }
    if (sha256File(abs) !== dm.sha256[rel]) { bad.push([rel, "hash"]); continue; }
    ok += 1;
  }

  // 2) payload completeness: no root payload file unlisted
  const expectedPayload = walkPayload().sort();
  const missingPayload = expectedPayload.filter((r) => !dm.files.includes(r));
  const extraPayload = dm.files.filter((r) => !expectedPayload.includes(r));

  // 3) shipped sha256 map: every entry present + hash matches (non-payload only)
  const shipped = new Set(listShipped());
  const shaBad = [];
  const shaMissing = [];
  for (const rel of Object.keys(dm.sha256)) {
    if (dm.files.includes(rel)) continue; // already checked above
    const abs = path.join(ROOT, ...rel.split("/"));
    if (!shipped.has(rel)) { shaMissing.push(rel); continue; }
    if (!fs.existsSync(abs)) { shaMissing.push(rel); continue; }
    if (sha256File(abs) !== dm.sha256[rel]) shaBad.push(rel);
  }
  const shaExtra = [...shipped].filter((r) => !(r in dm.sha256));

  console.log(`payload verified=${ok} payload_bad=${bad.length} payload_missing_unlisted=${missingPayload.length} payload_extra_unlisted=${extraPayload.length}`);
  for (const b of bad) console.log("  PAYLOAD BAD:", b.join(" "));
  for (const r of missingPayload) console.log("  UNLISTED PAYLOAD:", r);
  for (const r of extraPayload) console.log("  STALE PAYLOAD ENTRY:", r);
  console.log(`sha256 shipped=${shipped.size} sha_missing=${shaMissing.length} sha_hash_bad=${shaBad.length} sha_unlisted=${shaExtra.length}`);
  for (const r of shaMissing) console.log("  SHA MISSING:", r);
  for (const r of shaBad) console.log("  SHA BAD:", r);
  for (const r of shaExtra) console.log("  SHA UNLISTED:", r);

  return bad.length === 0 && missingPayload.length === 0 && extraPayload.length === 0 && shaMissing.length === 0 && shaBad.length === 0 && shaExtra.length === 0;
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const srcIdx = args.indexOf("--source-commit");
const explicitSource = srcIdx !== -1 ? args[srcIdx + 1] : null;

if (checkOnly) {
  process.exit(verifyOnDisk() ? 0 : 1);
}

const sourceCommit = explicitSource || gitRev(["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  console.error("invalid --source-commit: expected a full 40-char SHA-1");
  process.exit(2);
}
gitRev(["cat-file", "-e", `${sourceCommit}^{commit}`]); // throws if not a real commit

const manifest = build(sourceCommit);
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("== deploy manifest written ==");
console.log(`  releaseTag: ${manifest.releaseTag}`);
console.log(`  sourceCommit: ${manifest.sourceCommit}`);
console.log(`  payload: ${manifest.payloadFileCount} files (package: ${manifest.packageFileCount})`);
console.log(`  sha256 covered files: ${Object.keys(manifest.sha256).length}`);
console.log(`  closure gate: PASS`);
console.log(`  sha256(manifest): ${crypto.createHash("sha256").update(fs.readFileSync(MANIFEST)).digest("hex")}`);
