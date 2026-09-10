# Session Marker Smoke（看板对接最小运行）

**给看板对接方**：一次命令跑完「一块 skill 打点 + 一次最小真实压缩 + 实时打点输出」，
用于验证看板接收链路。离线、无模型、零第三方依赖。

## 运行

```powershell
cd deploy\examples\session-marker-smoke
npm run smoke
```

需要 `python`（3.x，仅 stdlib）在 PATH 上——打点脚本 `session_marker.py`
由本 kit 以与 SKILL.md 完全相同的方式调用。

## 会发生什么（按顺序）

1. `session_marker.py start` —— 记录 session_start 行
2. 一次**最小真实压缩**（真实 frozen bridge）：4.2K 大文件读取按任务派生符号
   提取为 `[EXTRACTIVE READ v1]`（约 4236 → 800 chars，model-visible）
3. `session_marker.py end` —— 自动从遥测汇总压缩效果
4. **实时打印** `.code-guard/markers/dashboard.ndjson` 全部行

## 期望输出

```text
[marker] start recorded
[compress] raw 4236 -> 7xx chars (model-visible)
[marker] end recorded
===== dashboard.ndjson（实时）=====
{"type": "session_start", ...}
{"type": "session_end", ..., "compression": {"events": 1,
  "by_strategy": {"extractive_read": 1}, "before_chars": 4236,
  "delivered_chars": 7xx, "saved_chars": 34xx, "model_visible_events": 1,
  "fallback_events": 0}, ...}
=====================================
  PASS - 压缩: 真实交付（model-visible）
  PASS - 打点: start/end 均被触发
  PASS - 看板: session_end 行存在
  PASS - 看板: saved_chars > 0（仅 model-visible 计入）
  PASS - 看板: by_strategy 含 extractive_read
SMOKE PASS — one minimal compression + session markers, dashboard rows printed above
```

## 接入自己的看板

- **tail 文件**：`<工作目录>/.code-guard/markers/dashboard.ndjson`
  （环境变量 `TASCO_DASHBOARD_LOG` 可改路径）
- **HTTP 实时推送**：设置环境变量 `TASCO_DASHBOARD_URL=<看板端点>`，
  每行打点同时 POST（3s 超时静默失败，本地文件始终是权威记录）

字段含义与必填性见
[`skills/code-guard-workflow/references/session-markers.md`](../../skills/code-guard-workflow/references/session-markers.md)。

## 在真实会话中接入（skill 一小块）

把下面一小块加进任意 SKILL.md，并把
`skills/code-guard-workflow/scripts/session_marker.py` 复制到该 skill 的
`scripts/` 下：

```markdown
## Session telemetry markers
1. Start（激活后立即执行）:
   python scripts/session_marker.py start --skill <名称> --task "<任务标签>"
2. End（停止条件、返回答案前）:
   python scripts/session_marker.py end --task "<任务标签>" --outcome success|partial|failed
```
