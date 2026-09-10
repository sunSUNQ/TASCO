# TASCO Failure Carrier Smoke（主线④：P1 失败诊断自动处理）

**问题**：真实测试/构建失败时，失败命令在 Claude Code 上不产生 PostToolUse
（平台约束），失败结果进不了压缩链——模型每次都收到整段原始失败日志。

**本冒烟验证**（离线、无模型，链路与真实会话同构）：

```text
原始 Bash（node --test ...）
→ PreToolUse 自动改写为 carrier shim（Agent 无感知，tool_use 语义保持原命令）
→ shim 真实执行原命令恰一次
→ 失败：stdout 收到 FAILURE-CARRIER-CONTRACT-V1 报告，wrapper exit=0
→ PostToolUse 正常触发 → carrier 识别 → Diagnostic 唯一胜出
→ 压缩交付（root cause 保留，raw 区块不透传）
```

同时验证两条负区：

- **成功命令**：输出逐字节透传，绝不产生 failure carrier（保护主线①/③的 M3 链）；
- **unsafe 命令**（`&&` 等）：绝不自动改写，保持 legacy 执行（fail-closed）。

## 运行

```powershell
cd deploy\examples\failure-carrier-smoke
npm run smoke
```

## 期望输出

```text
raw carrier    7xxx chars (exit code in-band: 1)
delivered diag 7xx chars (x.x% of raw)
success passthrough 3xxx chars, carrier absent: true
  PASS - PreToolUse: 原命令被自动改写为 carrier 形态
  PASS - original_command 保留（in-band，逐字等于原命令）
  PASS - original_exit_code 保留（真实非零）
  PASS - wrapper exit=0（transport 成功，is_error 不再发生）
  PASS - stdout 收到 Carrier V1 报告
  PASS - PostToolUse: Diagnostic 唯一胜出并交付
  PASS - 交付为压缩摘要（root cause 保留，raw 区块不在）
  PASS - wrong_capability=0（无 terminal/VD 记账）
  PASS - double_apply=0
  PASS - single execution（1 rewrite = 1 shim 执行行）
  PASS - 成功命令: 透传原始输出，绝不产生 failure carrier
  PASS - unsafe 命令: 不改写（legacy 执行）

SMOKE PASS — real failure auto-carried into Diagnostic with single execution
```

## 机制

- 原命令以 base64url in-band 传入 shim（无 quoting 风险；同一原命令 → 同一
  wrapper 文本），shim 经 bash 重放（与 Claude Code 的 Git Bash 一致），剥离
  test-runner 上下文环境变量，保证重放语义透明。
- 失败语义只看 `original_exit_code`，与 wrapper 进程 exit=0 严格分离。
- 单次执行证据 = `carrier_shim.jsonl` 每次执行一行，与 rewrite telemetry、
  fixture 副作用标记三方对账。
- 标准会话默认开启（`-EnableTasco` 注入 `CODE_GUARD_FAILURE_CARRIER_AUTO=1`；
  显式 `0` 回滚 legacy）。开启后 Validation Delta 的 failure→success 模式
  在线可达（失败轮 fingerprint 经 carrier 记录）。
