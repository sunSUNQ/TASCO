# TASCO v1.0.1 Maintenance Patch Release — Report

- 日期：2026-10-21
- 仓库：https://github.com/sunSUNQ/TASCO
- 基线 main（修复后）：`d3cfad7d73acf4e7ea64d8fce9a29112be40c7dd`
- 旧标签：`tasco-v1.0.0` → `ccfef36e3429436caea40f57ffed7f31e0f2e67a`（未改动）
- 新标签：`tasco-v1.0.1` → `002faf070f9d536287e86e02abf775a218805834`

## 1. 预检结论（Step 0）

- main 无新增未经审查的能力变更（自 `tasco-v1.0.0` 起仅有 fix/release/docs/merge 提交）。
- 先前的 P0 修复与发布一致性报告全部有效，main 的 Manifest `--check` 通过（144 payload / 331 sha256）。
- 未重复执行已通过的大规模验证。

## 2. 发布分支与版本修改（Step 1）

分支 `release/tasco-v1.0.1`（自 `d3cfad7`）。仅维护补丁必需的版本/文档修改：

- README「当前版本」→ `tasco-v1.0.1`、安装命令 → `git checkout tasco-v1.0.1`、Roadmap 增补 v1.0.1、BibTeX note → v1.0.1。
- `deploy/README.md`、`DEPLOYMENT-GUIDE.zh-CN.md`、`RUNNER-OBSERVABILITY-GUIDE.zh-CN.md` 版本声明 → v1.0.1。
- Manifest `version` / `releaseTag` → `tasco-v1.0.1`。
- 历史版本（v1.0.0 及更早）与研究证据保持原样。

阶段一（源码+版本+文档）提交：`ecaa11c7c3dfd3e1d8da107d06981302f0813567`

## 3. Manifest 两阶段重建（Step 2）

阶段二（依据阶段一 ecaa11c 生成 Manifest）提交：`b102c5bbe0eeba6dd074da679848f14a0f2cddb2`

| 字段 | 值 |
| --- | --- |
| version / releaseTag | `tasco-v1.0.1` |
| sourceCommit | `ecaa11c7c3dfd3e1d8da107d06981302f0813567`（阶段一，可追溯，非 Manifest 自身） |
| payload / package / sha256 | 144 / 148 / 331 |
| generatedAt | 由 sourceCommit 提交时间派生（确定性） |

验收：同源两次生成字节一致；`--check` 全通过（0 缺失/0 哈希错/0 未登记）；无 CRLF/LF 新漂移；未自引用 Manifest 提交。

## 4. 最小发布回归（Step 3，全部通过）

1. Manifest `--check`：PASS
2. root/deploy 关键运行时一致性：differ=0（claude_bridge / post_tool_policy_hook / test_build_structured / repeated_delivery_suppression 逐字节一致）
3. ADV1 默认 OFF：9/9 PASS
4. TBS 默认 ON 与 kill-switch：4/4 PASS
5. Node 语法：PASS；PowerShell Parser：PASS
6. 离线 smoke：7/7 SMOKE PASS
7. README 链接 0 断链、UTF-8 0 乱码、版本扫描 clean
8. 清洁工作区：通过

缺少研发仓 fixture 的 read/search 测试未计入 PASS（未伪造通过）。

## 5. PR、合并与 tag（Step 4）

- PR #2：https://github.com/sunSUNQ/TASCO/pull/2（`release/tasco-v1.0.1` → `main`，mergeable=CLEAN）
- 合并后最终 main HEAD：`002faf070f9d536287e86e02abf775a218805834`
- 最终 main 快照上 Manifest `--check` 通过。
- annotated tag `tasco-v1.0.1`（对象 `4e16483`）→ `002faf0`，已推送。
- 全新克隆 `git checkout tasco-v1.0.1`：Manifest `--check` 通过（LF canonical 无漂移）、README 推荐 v1.0.1、部署指南在根目录正确存在。
- 未移动/覆盖 `tasco-v1.0.0`（仍指向 `ccfef36e`）。

## 6. GitHub Release（Step 5）

- 标题：`TASCO v1.0.1 — Maintenance Patch`
- 状态：isDraft=false、isPrerelease=false（正式发布），tag `tasco-v1.0.1`
- 内容含：修复背景、v1.0.0 缺陷清单、v1.0.1 修复内容、安装命令、部署指南路径、默认 AUTO/OFF 能力、资格化模型、适用范围与限制、负收益与 G5 风险、Manifest 验证方式。
- 模型说明：当前资格化模型 DeepSeek-v4-Flash-SZ；历史在线审计实验用 GLM-5.3-Flash（研究记录，未改动）。

## 7. 旧 Release 勘误（Step 6）

在 `tasco-v1.0.0` Release 末尾追加勘误：说明原始快照存在已确认缺陷、推荐使用 v1.0.1，保留旧 tag 与原始证据。

## 8. 最终远程验证（Step 7）

- 新 tag 指向已验证提交 `002faf0`：✅
- 新 Release 已发布、非 Draft、非 Pre-release：✅
- main README 推荐 v1.0.1：✅
- tag 干净克隆 README 推荐 v1.0.1：✅
- 干净克隆 v1.0.1 Manifest 校验通过：✅
- 部署指南存在且路径正确（根目录，`deploy/` 为运行时闭包）：✅
- 默认能力与运行时一致：✅
- 原 `tasco-v1.0.0` tag 未变化（`ccfef36e`）：✅

## 9. 验收判定

```
TASCO_V1.0.1_MAINTENANCE_RELEASE_COMPLETE
```

## 10. 停止点

发布与远程验证全部完成，STOP。未启动 RTK 对比、未开发新压缩能力、未进行无关工程优化。