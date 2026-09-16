"use strict";

// ============================================================================
// post_tool/validation_identity.js — M-V3 Semantic Validation Identity
// ============================================================================
// TASCO v0.8 / Line-8A（唯一实验变量：sameCommand identity → validation_key）。
//
// 目标：Validation Delta 的重复验证 identity 从 raw same-command 恒等升级为
// fail-closed 的 semantic validation identity。同一验证意图下 Agent 会自然
// 产生 shell 表达漂移（`npm run build | tail -60` vs
// `npm run build | tee build.log | tail -5`），raw 恒等把它们视为不同命令，
// 导致 VD 漏命中。本模块把"验证语义相同"的命令映射到同一 validation_key。
//
// 铁律（M-V3 amendment，docs/architecture/VALIDATION-DELTA-CONTRACT-V1.md §12）：
//   1. identity 只决定"能否找到语义相同的历史验证"；是否允许真正参与 VD
//      比较，继续由现有输出 evidence gate 独立决定（detectTerminalState
//      unknown → fingerprint null / test counts availability / 长度护栏）。
//      semantic identity 绝不 bypass 可比性证据。
//   2. wrapper 白名单：只有确认不改变验证语义的展示/载体 wrapper（tail /
//      head / tee / cat + stdout/stderr 重定向）可以剥离。出现未识别
//      pipeline member → null，不做 semantic merge，不智能猜测。
//   3. fail-closed 边界（一律 null）：compound 命令（&& / ; / & / ||）；
//      引号 / 反引号 / 命令替换 / 子 shell；stdin 重定向与 heredoc；
//      变异/watch 参数（复用 terminal_state 冻结 CHECK_MUTATION_RE）；
//      未知验证命令；畸形输入。identity 为 null 时调用方回退到既有
//      raw foldCommand 恒等（不缩小已冻结行为，只不扩大正区）。
//   4. env 前缀不静默忽略：逐字纳入 validation_key（M-V3 方案一）。
//      `NODE_ENV=production npm run build` 与 `npm run build` 恒不等。
//   5. 语义差异参数逐字保留：build vs build:prod、test vs `test -- auth`、
//      tsc vs `tsc -p tsconfig.prod.json` 恒不等。
//
// 纯函数、无 I/O、确定性：同输入 → 同 key。
// ============================================================================

const { classifyCommand, CHECK_MUTATION_RE } = require("./terminal_state");

// ---------------------------------------------------------------- 常量
// 展示/载体 wrapper 白名单：只影响输出呈现，不影响验证语义。
const WRAPPER_HEADS = new Set(["tail", "head", "tee", "cat"]);

// 命令头部 env 赋值 token（逐字入 key）。
const ENV_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

// 包管理器头部（script 名必须入 target：build vs build:prod 恒不等）。
const NPM_LIKE = new Set(["npm", "yarn", "pnpm", "bun"]);

// config 类 flag（信息性提取；relevant_args 已逐字保证区分度）。
const CONFIG_FLAGS = new Set(["-p", "--project", "--config"]);

// ---------------------------------------------------------------- 归一化
function fold(command) {
  return String(command || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

// cwd 归一化：反斜杠 → 正斜杠、去尾斜杠；Windows 盘符路径大小写不敏感
// （lowercase）；其余平台保留大小写（大小写敏感文件系统上保守不合并）。
function normalizeCwd(cwd) {
  const c = String(cwd || "").trim();
  if (!c) return "";
  let out = c.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:\//.test(out)) out = out.toLowerCase();
  return out;
}

// ---------------------------------------------------------------- 重定向剥离
// 仅剥离 stdout/stderr 呈现重定向（含 fd-dup / append / 合并写文件形态）。
// stdin 重定向（< / <<）不在此列 —— 由调用方 fail-closed。
function stripOutputRedirects(segment) {
  let out = segment
    .replace(/(^|\s)\d*>>\s*\S+/g, " ") // >> file / 2>> file
    .replace(/(^|\s)\d*&>\s*\S+/g, " ") // &> file（双流写文件）
    .replace(/(^|\s)\d*>&\d+(?=\s|\||$)/g, " ") // 2>&1 / >&1 / >&2（fd 复制）
    .replace(/(^|\s)\d*>\s*\S+/g, " "); // > file / 2> file
  return out.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- 主入口
/**
 * validationIdentity(command, cwd) -> identity | null
 *
 * identity = { key, kind, target, config, relevantArgs, env, variant, command }
 *   key       —— validation_key 字符串（mv3 命名空间 + JSON 结构化成分）
 *   kind      —— test | build | check（复用冻结 classifyCommand）
 *   target    —— 验证目标（npm:<script> / yarn:<script> / "<bin> <subcmd>"）
 *   config    —— -p/--project/--config 值（信息性）
 *   relevantArgs —— 语义参数逐字序列（顺序保留）
 *   env       —— 头部 env 赋值逐字序列
 *   variant   —— plain | wrapped（telemetry 观测用）
 *   command   —— raw 折叠命令（审计）
 * null = 无 semantic identity（调用方回退 raw 恒等，不扩大正区）。
 */
function validationIdentity(command, cwd) {
  const raw = String(command || "");
  const c = fold(raw);
  if (!c) return null;

  // ---- fail-closed 字符级守卫（引号/替换/子 shell 先于一切解析）----
  if (/['"`]|\$\(|\$\{|\(/.test(c)) return null;

  // ---- 按 pipeline 段切分（每段先剥离输出重定向）----
  const segments = c.split("|").map((s) => stripOutputRedirects(s));
  if (segments.some((s) => !s)) return null; // 空段（`a |` / `| b`）→ 畸形

  // ---- compound / background / stdin fail-closed（重定向剥离之后判定）----
  const headSegment = segments[0];
  const joined = segments.join(" | ");
  if (/&&|\|\||;|&/.test(joined)) return null; // compound / 后台
  if (/(^|\s)</.test(joined)) return null; // stdin 重定向 / heredoc

  // ---- wrapper 白名单（第 2..n 段）----
  const wrappers = segments.slice(1);
  for (const w of wrappers) {
    const wHead = w.split(/\s+/)[0];
    if (!WRAPPER_HEADS.has(wHead)) return null; // 未知 pipeline member
  }

  // ---- 头段解析：env 前缀逐字提取 ----
  const tokens = headSegment.split(/\s+/).filter(Boolean);
  const env = [];
  let i = 0;
  while (i < tokens.length && ENV_TOKEN_RE.test(tokens[i])) {
    env.push(tokens[i]);
    i += 1;
  }
  const rest = tokens.slice(i);
  if (rest.length === 0) return null;
  const restJoined = rest.join(" ");

  // ---- kind（冻结入口表）+ 变异/watch fail-closed（冻结负区不扩大）----
  const kind = classifyCommand(restJoined);
  if (!kind) return null; // 未知验证命令 → 无 identity
  if (CHECK_MUTATION_RE.test(restJoined)) return null; // --fix/--watch/... 冻结负区

  // ---- target + relevant_args（语义差异逐字保留）----
  let target;
  let argStart;
  if (NPM_LIKE.has(rest[0])) {
    if (rest[1] === "run" && rest[2]) {
      target = `${rest[0]}:${rest[2]}`; // npm run <script>
      argStart = 3;
    } else if (rest[1] && !rest[1].startsWith("-")) {
      target = `${rest[0]}:${rest[1]}`; // npm test / yarn build
      argStart = 2;
    } else {
      return null; // 畸形 npm 形态 → fail-closed
    }
  } else {
    target = rest[0] + (rest[1] && !rest[1].startsWith("-") ? ` ${rest[1]}` : "");
    argStart = rest[1] && !rest[1].startsWith("-") ? 2 : 1;
  }
  const relevantArgs = rest.slice(argStart);

  // ---- config 提取（信息性；args 已逐字保证区分度）----
  let config = "";
  for (let j = 0; j < relevantArgs.length - 1; j += 1) {
    if (CONFIG_FLAGS.has(relevantArgs[j])) {
      config = relevantArgs[j + 1];
      break;
    }
  }

  const key =
    "mv3|" +
    JSON.stringify([
      normalizeCwd(cwd),
      kind,
      target,
      env.join(" "),
      config,
      relevantArgs.join(" "),
    ]);

  return {
    key,
    kind,
    target,
    config,
    relevantArgs,
    env,
    variant: wrappers.length > 0 ? "wrapped" : "plain",
    command: fold(raw),
  };
}

module.exports = {
  validationIdentity,
  normalizeCwd,
  fold,
  WRAPPER_HEADS,
};
