# TASCO Validation Delta Smoke（主线③：M3 重复验证结果压缩）

**问题**：同一验证命令反复执行时，每次都把几千字节的全部通过用例重发给模型。

**本冒烟验证**：第二次执行起，只交付一份"发生了什么变化"的 delta 报告——

```text
[VALIDATION_DELTA]
mode=success_unchanged
case_level_changes=0
unchanged_since_previous_run: pass=45
counts: pass=45 fail=0 skip=0
```

计数变了就只报变化（`mode=success_counts_changed` + `counts_delta: pass 45->50`）；
没有可比较的上一轮就保持 Native（不伪造 delta）；flag OFF 时逐字节回滚。

## 运行

```powershell
cd deploy\examples\validation-delta-smoke
npm run smoke
```

## 期望输出

```text
raw TAP45 6xxx chars -> unchanged delta 1xx chars
raw TAP50 6xxx chars -> counts_changed delta 2xx chars
  PASS - flag OFF: 第一次 Native
  PASS - flag OFF: 重复执行仍 Native（无 delta）
  PASS - flag OFF: 无 fingerprint 状态文件（逐字节回滚）
  PASS - 首次成功: 不伪造 delta（无 comparable previous）
  PASS - 重复成功: 交付 [VALIDATION_DELTA]
  PASS - 重复成功: mode=success_unchanged
  PASS - 重复成功: 只报结果不重传全文（< 原文 20%）
  PASS - 重复成功: 保留权威计数 (counts: pass=45)
  PASS - 计数变化: mode=success_counts_changed
  PASS - 计数变化: 报告增量 (pass 45->50)
  PASS - 计数变化: 仍然只传变化（< 原文 5%）

SMOKE PASS — repeated validation reports only the change
```

## 机制

- 真实链路：`claude_bridge.js` PostToolUse → fingerprint（按 canonical 命令存
  `claude_validation_<session>.json`）→ 下一轮同命令可比较 → delta。
- P1 失败载体开启后，失败轮的 fingerprint 也被记录，因此
  `failure_to_success_resolution` 模式在线可达（S2b Online A run2 实证）。
- 本冒烟关闭 Terminal-State 以隔离 primitive；真实会话中 terminal 与 VD 的
  优先级由冻结仲裁（主线②）决定：stable VD > terminal。
