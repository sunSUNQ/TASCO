# Changelog

本项目遵循维护修复（Maintenance) 发布语义：只修已确认的发布阻断缺陷，不新增压缩能力。

## tasco-v1.0.2 — 诊断保真安全维护补丁

**性质**：诊断保真安全维护补丁（Security maintenance patch）。

**修复**：已知失败诊断事实丢失——在 108 次 TASCO×RTK 对比实验中被审计发现，8 个诊断压缩事件全部在 `rescued=true` 的情况下仍将 ROOT CAUSE / FATAL / 失败计数 / `not ok` / 堆栈文件:行号 未送达模型。

**机制**（`hooks/post_tool/diagnostic_fidelity.js`，model-visible 诊断保真门）：
- 三态分类：`no_risk` / `facts_identified` / `uncertain`；
- 扩展事实识别：Windows 盘符 / UNC 路径、Java `File.java:N`、Go `file.go:N`、Rust `lib.rs:N:M`、Python `File "x.py" line N`，以及 `--- FAIL` / `Exception in thread` / `Caused by` / `panicked at` / `FAILED` / `AssertionError` / `Traceback` / 失败计数；
- 诊断风险不确定（存在失败信号但无法可靠解析关键事实）时**必回退 Native**；「未识别到具体事实」不再等同于「无风险」；
- `rescued=true` **不再代表诊断保真通过**；telemetry 分账 `diagnostic_risk_state` / `fidelity_verdict` / `fallback_reason` / `actual_delivery` / `rescued`。

**可观测影响**：诊断类输出（尤其是高容量测试/构建失败）在保真门判定后可能回退完整原文，故**这些场景的局部压缩率可能下降**。诊断信息保真优先于 Token 节省。

**已知边界（如实声明，不夸大）**：
- 机械保真门存在「失败信号词汇边界」——完全不含 error/fail/exception/panic/fatal/traceback/assertion 的失败输出无法在文本层面识别；不宣称所有语言、所有异常格式均获得绝对保真保证。
- `read_file` 的 RLM 语义压缩、`invoke_agent` 子代理报告、非 shell 大工具 head-tail 截断不属于本轮 quick_shell 诊断门控范围（非 bash 失败诊断主路径）。

**回归**：新增 21 项诊断保真测试；既有 142 项能力测试全过；terminal-state 冒烟 PASS。

**注**：108 次 RTK 对比实验属于 **tasco-v1.0.1 历史研究**，其结果不能归为 v1.0.2 的性能数据。

## tasco-v1.0.1 — 维护补丁

修复 v1.0.0 已确认的发布交付缺陷（Manifest / 文档 / 版本身份对齐）；License 统一为 MIT。

## tasco-v1.0.0 — 最终稳定发布

Feature Development Frozen · Maintenance Only；能力冻结矩阵见 `tasco-v1.0-capability-matrix.md`。