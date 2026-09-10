#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
session_marker.py — TASCO 会话打点（skill 开始/结束）
=====================================================

在 code-guard-workflow skill 的开始与结束各调用一次，产出看板所需的
会话级统计数据。零第三方依赖（stdlib only）、全程 fail-open（任何失败
都不影响 agent 工作流）。

用法（由 SKILL.md 指示 agent 调用）：
  python session_marker.py start --skill code-guard-workflow --task "bug root cause"
  python session_marker.py end --outcome success

行为：
  start : 追加一行 {"type":"session_start", ...} 到看板 NDJSON
  end   : 从本仓既有遥测（tasco_compression.ndjson / session_summary.json /
          claude_auto_canary.jsonl / .tasco-runs summary.json）汇总压缩效果，
          追加 {"type":"session_end", ...} 一行；并可选 POST 到看板。

看板对接（二选一，互不冲突）：
  1. tail 本地 NDJSON：默认 <cwd>/.code-guard/markers/dashboard.ndjson，
     可用环境变量 TASCO_DASHBOARD_LOG 覆盖；
  2. HTTP POST：设置环境变量 TASCO_DASHBOARD_URL 后，每行同时 POST
     （超时 3s，失败静默——本地文件始终是权威记录）。

统计口径（与 Metrics Contract V2 一致）：
  saved_chars 只计 model-visible 事件（transport_replacement_emitted=true
  或 applied=true 且 delivered < before）；fallback 单独计数。
"""

import argparse
import glob
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

try:
    VERSION = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "..", "deploy_manifest.json"), encoding="utf-8-sig")).get("version", "unknown")
except Exception:
    VERSION = os.environ.get("CODE_GUARD_TASCO_VERSION", "unknown")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def repo_name():
    return os.path.basename(os.path.abspath(os.getcwd()))


def marker_log_path():
    return os.environ.get("TASCO_DASHBOARD_LOG") or os.path.join(
        os.getcwd(), ".code-guard", "markers", "dashboard.ndjson"
    )


def append_marker(row):
    """追加到本地 NDJSON（权威记录）；设置 TASCO_DASHBOARD_URL 时同时 POST。"""
    path = marker_log_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass  # fail-open
    url = os.environ.get("TASCO_DASHBOARD_URL", "").strip()
    if url:
        try:
            req = urllib.request.Request(
                url, data=json.dumps(row, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass  # 看板不可达不影响工作流；本地文件仍是权威记录
    return path


def latest_session_dir():
    """cwd/.code-guard/<session_id>/ 中最近活跃（tasco_metrics 最新 mtime）的会话目录。"""
    best, best_mtime = None, -1.0
    base = os.path.join(os.getcwd(), ".code-guard")
    if not os.path.isdir(base):
        return None
    for entry in os.listdir(base):
        tm = os.path.join(base, entry, "tasco_metrics")
        if os.path.isdir(tm):
            m = max((os.path.getmtime(os.path.join(tm, f)) for f in os.listdir(tm)), default=0)
            if m > best_mtime:
                best, best_mtime = os.path.join(base, entry), m
    return best


def read_ndjson(path):
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return rows


def collect_compression_stats():
    """从既有遥测汇总压缩效果（不产生新打点，只读）。

    双源优先级：bridge canary 的 compression 行（交付权威，含
    transport_replacement_emitted）优先；仅当 canary 无行时回退 policy hook
    的 tasco_metrics 行（避免同一交付被两层重复计数）。
    """
    stats = {
        "events": 0, "by_strategy": {}, "before_chars": 0, "delivered_chars": 0,
        "saved_chars": 0, "model_visible_events": 0, "fallback_events": 0,
    }

    def absorb(rows, strategy_keys, before_key, delivered_key, emitted_key):
        for row in rows:
            strategy = "unknown"
            for k in strategy_keys:
                if row.get(k):
                    strategy = str(row[k])
                    break
            stats["events"] += 1
            stats["by_strategy"][strategy] = stats["by_strategy"].get(strategy, 0) + 1
            try:
                before = int(row.get(before_key) or 0)
                delivered = int(row.get(delivered_key) or 0)
                stats["before_chars"] += before
                stats["delivered_chars"] += delivered
                if 0 < delivered < before:
                    stats["saved_chars"] += before - delivered
                if row.get(emitted_key):
                    stats["model_visible_events"] += 1
            except Exception:
                pass
            if row.get("fallback"):
                stats["fallback_events"] += 1

    # 源 1（权威）：bridge canary 的 compression 行（递归覆盖
    # .tasco-runs/<run>/<session>/context_budget 与 .code-guard/context_budget）
    canary_candidates = glob.glob(
        os.path.join(os.getcwd(), ".tasco-runs", "**", "context_budget", "claude_auto_canary.jsonl"),
        recursive=True,
    )
    canary_candidates += glob.glob(os.path.join(os.getcwd(), ".code-guard", "context_budget", "claude_auto_canary.jsonl"))
    canary_candidates += glob.glob(os.path.join(os.getcwd(), ".code-guard", "**", "context_budget", "claude_auto_canary.jsonl"), recursive=True)
    canary_rows = []
    newest = max(canary_candidates, key=os.path.getmtime, default=None)
    if newest:
        canary_rows = [r for r in read_ndjson(newest) if r.get("type") == "compression"]
    if canary_rows:
        absorb(canary_rows, ["read_strategy", "capability"], "originalLength", "compressedLength", "transport_replacement_emitted")
        return stats

    # 源 2（回退）：policy hook 层 tasco_metrics 行
    for session_dir in glob.glob(os.path.join(os.getcwd(), ".code-guard", "*", "tasco_metrics")):
        absorb(
            read_ndjson(os.path.join(session_dir, "tasco_compression.ndjson")),
            ["strategy"], "raw_chars", "delivered_chars", "applied",
        )
    return stats


def collect_usage_and_recovery():
    """runner summary 的 turns/usage + 会话恢复信号（重复读计数）。"""
    usage, turns, recovery = {}, None, {"repeat_reads": 0, "re_searches": 0}
    summaries = glob.glob(os.path.join(os.getcwd(), ".tasco-runs", "*", "summary.json"))
    newest = max(summaries, key=os.path.getmtime, default=None)
    if newest:
        try:
            s = json.load(open(newest, encoding="utf-8-sig"))
            usage = s.get("usage") or {}
            turns = s.get("turns")
        except Exception:
            pass
    session = latest_session_dir()
    if session:
        state_path = os.path.join(session, "context_budget_state.json")
        try:
            st = json.load(open(state_path, encoding="utf-8-sig"))
            deliveries = st.get("after_read_deliveries") or {}
            recovery["repeat_reads"] = len(deliveries)
        except Exception:
            pass
    return usage, turns, recovery


def cmd_start(args):
    row = {
        "type": "session_start", "ts": now_iso(),
        "repo": repo_name(), "skill": args.skill, "task": args.task,
        "tasco_version": VERSION,
        "agent": os.environ.get("CODE_GUARD_AGENT_RUNTIME", "unknown"),
        "model": os.environ.get("CODE_GUARD_MODEL") or os.environ.get("ANTHROPIC_MODEL") or "unknown",
    }
    path = append_marker(row)
    print(f"[tasco-marker] session_start recorded -> {path}")
    return 0


def cmd_end(args):
    compression = collect_compression_stats()
    usage, turns, recovery = collect_usage_and_recovery()
    row = {
        "type": "session_end", "ts": now_iso(),
        "repo": repo_name(), "skill": args.skill, "task": args.task,
        "outcome": args.outcome, "tasco_version": VERSION,
        "agent": os.environ.get("CODE_GUARD_AGENT_RUNTIME", "unknown"),
        "model": os.environ.get("CODE_GUARD_MODEL") or os.environ.get("ANTHROPIC_MODEL") or "unknown",
        "usage": {"turns": turns, **({"input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"]} if usage.get("input_tokens") is not None else {})},
        "compression": compression,
        "recovery": recovery,
    }
    path = append_marker(row)
    saved = compression["saved_chars"]
    print(f"[tasco-marker] session_end recorded -> {path}")
    print(f"[tasco-marker] compression events={compression['events']} saved_chars={saved} model_visible={compression['model_visible_events']} fallback={compression['fallback_events']}")
    return 0


def main():
    p = argparse.ArgumentParser(description="TASCO session marker (skill start/end)")
    sub = p.add_subparsers(dest="phase", required=True)
    ps = sub.add_parser("start")
    ps.add_argument("--skill", default="code-guard-workflow")
    ps.add_argument("--task", default="")
    pe = sub.add_parser("end")
    pe.add_argument("--skill", default="code-guard-workflow")
    pe.add_argument("--task", default="")
    pe.add_argument("--outcome", default="success", choices=["success", "partial", "failed"])
    args = p.parse_args()
    try:
        (cmd_start if args.phase == "start" else cmd_end)(args)
    except Exception as e:  # fail-open: 打点永不阻断工作流
        print(f"[tasco-marker] skipped ({e})")
        return 0


if __name__ == "__main__":
    sys.exit(main())
