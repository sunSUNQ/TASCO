# TASCO v0.7 Diagnostic Semantic Compression 示例

一个零依赖的小型演示项目，用于在装好 TASCO v0.7 之后，验证默认自动开启的
**Diagnostic Semantic Compression** 正区。它只走已冻结的
`diagnostic.semantic_compression` 能力：

```text
大段单一来源的诊断输出
→ 只读根因分析
→ 诊断压缩被选中并应用
```

本目录的 fixture script 只负责产生确定性的输入，不是压缩器本身，也不是完整的
Agent qualification。它不会开启 Structural。fixture 是确定性的：
`node scripts/emit-diagnostic.js` 会输出一段模拟的结账服务故障日志——唯一根因是
缺失 `PAYMENTS_API_URL`，中间夹杂大量重复的重试/堆栈噪音。

## 前置条件

- TASCO v0.7 部署包（本目录所在的那一份即可）；
- Node.js（18+）；
- Agent CLI 已登录，模型可访问（示例默认 CodeAgentCLI + `DeepSeek-v4-Flash-SZ`；Claude Code 则用 `-Agent claude -Model deepseek-v4-flash`）。

不要在已经有 `.claude/settings.local.json` 的项目里运行：runner 会拒绝覆盖已有的本地 hook 配置。

## 一键冒烟

```powershell
& D:\tasco\run-tasco-task.ps1 `
  -Agent codeagent -Model "DeepSeek-v4-Flash-SZ" `
  -WorkDir D:\tasco\examples\diagnostic-compression-smoke `
  -Prompt "Run node scripts/emit-diagnostic.js exactly once. Diagnose the root cause of the simulated checkout outage from that output. State the failing component, the missing configuration key, and the safe next step. Do not modify files and do not run tests." `
  -EnableTasco
```

- `-Prompt` 是唯一必填参数；`-EnableTasco` 不加则完全不接入 TASCO hooks（等于裸跑对照），验证压缩时**必须加**。
- Diagnostic Semantic Compression 在标准 TASCO runner 的 `-EnableTasco` 会话中默认自动开启；本样例不需要额外的 Diagnostic 开关。
- CodeAgentCLI 必须显式给 `-Model`；Claude Code 场景两个参数都可省略（代码默认 `claude` + `deepseek-v4-flash`）。
- 完整 runner 参数说明见 [RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](../../RUNNER-OBSERVABILITY-GUIDE.zh-CN.md)。

预期任务结论：

```text
component: payments-client
missing key: PAYMENTS_API_URL
next step: configure PAYMENTS_API_URL and restart checkout-api
```

## 怎么算成功

具体调用次数与节省字符数会因模型轨迹略有差异，但至少应看到一条压缩事件：

```text
selected = true
applied  = true
saved_chars > 0
```

`npm run diagnostic` 只生成大型诊断 fixture；实际 Agent + TASCO 压缩验证必须通过上面的标准
`run-tasco-task.ps1 -EnableTasco` 命令完成。`diagnostic_semantic` 是记录在
`context_budget/claude_auto_canary.jsonl` 里的 Router/能力决策；NDJSON 的 `strategy` 字段记录
实际执行压缩的压缩器（本 fixture 可能是 `quick_shell`），两者不必是同一个字符串。

## 跑完之后看结果

每次运行的结果都落在本目录的 `.tasco-runs/<run>/` 下（run 目录名是 `yyyyMMdd-HHmmss`）。最省事的查看方式：

```powershell
# 最近一次 session 的结论：压缩前后字符、净节省、效果判定
& D:\tasco\tools\get-latest-tasco-session.ps1 `
  -Path D:\tasco\examples\diagnostic-compression-smoke

# 全部历史 session 的逐次结论 + 汇总
& D:\tasco\tools\get-tasco-session-history.ps1 `
  -Path D:\tasco\examples\diagnostic-compression-smoke
```

两个脚本的参数、输出示例与报错说明见 [RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](../../RUNNER-OBSERVABILITY-GUIDE.zh-CN.md)「用户观测脚本」；各结果文件的含义见 [../../README.md](../../README.md)「运行产物」。

对本 smoke 来说，`selected/applied > 0` 且 `gross_saved > 0` 即证明压缩链路可用；provider 在第一个有效回合前就失败属于 `QUALIFICATION_BLOCKED`，不是压缩失败。
