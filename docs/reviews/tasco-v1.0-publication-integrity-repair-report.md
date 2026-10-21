# TASCO v1.0.0 Publication Integrity Repair — Final Closure Report (R1)

- 日期：2026-10-21
- 修复分支：`repair/publication-integrity-r1`（基于 `origin/main` @ `6d3e4fb`）
- 目标发布：`tasco-v1.0.0`（tag → commit `ccfef36`；Release 已存在）
- 报告文件：本文

## 0. 结论（先看这里）

**最终判定：`TASCO_V1.0_PUBLICATION_INTEGRITY_FINAL_PASS`**

三项已批准发布决策均在修复分支上完成、提交、推送并完成最小回归；无新增问题。
`--check` 在最终提交后的干净工作区通过。修复分支不移动 tag、不修改 Release、不创建新版本。

> 注意：本轮同时暴露了一个**发布完整性既有缺陷**（deploy 闭包镜像到 root 时丢弃了
> ADV1 / Test/Build Structured / Repeat-Delivery-Suppression 三处运行时能力，见 §8）。
> 该缺陷不属于本轮三项决策的修复范围，但会直接影响「v1.0.0 是否真正应按当前
> Release/tag 交付」——详见 §9 建议，需负责人单独裁决。

---

## 1. 最终提交 SHA 与来源

| 项 | 值 |
| --- | --- |
| 最终提交 SHA（产品/发布顶点） | `a175556a57374fcea57efd2bd7b4922703bfd6cd`（阶段二 Manifest 提交） |
| 阶段一（源代码）提交 | `a13271d873afc286995f4724922f5693bb60229d` |
| 阶段二（Manifest）提交 | `a175556a57374fcea57efd2bd7b4922703bfd6cd` |
| 阶段三（最终报告，docs 记录，不改产品内容） | `8891f63f23803573e66ec93f142c99c80a8ced6d` |
| Manifest `sourceCommit` | `a13271d873afc286995f4724922f5693bb60229d` |

两阶段提交满足「sourceCommit 记录可追溯源代码提交、不要求等于最终 Manifest 提交 HEAD」的决策，
不存在自引用循环：`sourceCommit` = 阶段一（纯源代码）提交，阶段二的 Manifest 提交不把自身 HEAD 写入。

---

## 2. Manifest 文件数量与 SHA 校验结果

生成器：`product/tools/build_deploy_manifest.js`（确定性，两阶段 `--source-commit` + `--check`）。

| 字段 | 修复后值 | 说明 |
| --- | --- | --- |
| `version` / `releaseTag` | `tasco-v1.0.0` | 保持不变 |
| `payloadFileCount` | **142** | 原为 230（错误；`files` 数组仅 143 项且含 2 个幽灵项） |
| `packageFileCount` | **146** | = 142 payload + 4 顶级部署文档 |
| `sha256` 覆盖文件数 | **328** | 全部受版本管控的非产物文件（payload + `deploy/` + `examples/` + 文档） |

`--check`（最终提交后的干净工作区）结果：

```text
payload verified=142 payload_bad=0 payload_missing_unlisted=0 payload_extra_unlisted=0
sha256 shipped=328 sha_missing=0 sha_hash_bad=0 sha_unlisted=0
exit=0
```

修复前 Manifest 的完整性缺陷（已被本次重新生成一并修正）：

- `sourceCommit` 为 tasco-dev `5e57cf5e`，且生成器语义 = `git rev-parse HEAD`（自引用风险）。
- `sha256` 含 52 条「不存在的路径」（`* .test.js` / `examples/…/.tasco-runs/…` 运行日志无机前缀）、
  1 条 `package-lock.json`（仓库无此文件）、2 条 `tools/frozen_maps/`（payloadScope 声明排除）；
  `README.md` / `post_tool_policy_hook.js` / `session_marker.py` / `claude_bridge.js` 等多条 hash 与磁盘不符。
- `payloadFileCount=230` 与 `files` 数组（143 项）自相矛盾。

---

## 3. ADV1 默认 OFF 的测试证据（决策 1）

文件：`deploy/adapters/claude_bridge.js`、`deploy/adapters/claude_bridge_adv1_transport.test.js`。

代码变更（唯一逻辑变更，1 行）：`adv1Enabled = adv1Flag === "1"`（原 `adv1Flag === undefined || === "1"`）。

真值表测试（`node --test deploy/adapters/claude_bridge_adv1_transport.test.js`）关键通过项：

```text
✔ ADV1 flag OFF values (kill-switch 0 / legacy other): eligible-shaped event stays native, zero ADV1 telemetry
✔ ADV1 flag truth table: unset=OFF, 1=ON, 0=OFF, legacy=OFF (published default contract)
✔ ADV1 flag ON: eligible event routed -> V1-D applied via existing full policy
✔ ADV1 flag ON: kill-switch CODE_GUARD_TEST_BUILD_STRUCTURED=0 fail-closes the prefilter
……
```

- unset → OFF（无交付、零 ADV1 telemetry）✅
- `0` → OFF ✅
- `1` → ON ✅
- 其它值（`legacy` / `yes`）→ OFF ✅
- OFF 路径不新增内容变换、不产生 ADV1 介入事件、原有 Native 回退（`terminal_delivery_fallback`）不变 ✅

注：该测试文件整体为 8 通过 / 1 失败；失败的 1 条为**既有缺陷**（`terminal-success precedence` 用例
读取不随本仓发布的 fixture `docs/experiments/…/f1-tap-44pass.out`，ENOENT），非本次变更引入，详见 §8。

---

## 4. TBS 默认 ON 的验证证据（决策 2）

`CODE_GUARD_TEST_BUILD_STRUCTURED` 默认 ON，保留 kill-switch，无代码行为变更；本轮为**说明补齐**：

- `README.md`：新增「Test/Build Structured 不是独立能力」附注 + 能力开关/环境变量表格行；
  Roadmap 行改为「已作为内部输入预处理随本版交付，非独立 winner」。
- `RUNNER-OBSERVABILITY-GUIDE.zh-CN.md`：能力边界表新增一行 + 仲裁段落后补充「输入预处理」说明。
- `deploy_manifest.json`：新增 `inputPreprocessing.testBuildStructured`（flag / default ON / 预处理类型 /
  P1–P5 patterns / 保留契约 / kill-switch）。

判定（`node --test deploy/hooks/post_tool/test_build_structured_default_flag.test.js`，4/4 通过）：

```text
✔ flag truth table 1+3: env absent == env=1 -> enabled (applied telemetry + folded delivery)
✔ flag truth table 2: env=0 -> kill-switch (no structured participation, no residual applied telemetry)
✔ flag truth table 4: other explicit values keep legacy semantics (contract not extended)
✔ negative fixture: default flip does not expand the negative zone (unset delivery == kill-switch delivery)
```

确认项：无新增 Compression Winner；不扩大默认压缩适用范围；输入证据保留契约未退化；kill-switch 正常；
既有诊断信息风险说明（G5 词面口径盲区）保留于 CAPABILITY-EVIDENCE（未改动）。

---

## 5. root / deploy 一致性结果（Step 4）

用文件级比对（非 payload 的 `*.test.js` 不参与）：

| 维度 | 数量 | 明细 |
| --- | --- | --- |
| root 运行时文件 | 140 | `adapters/core/hooks/plugin/tools` + entry 文件 |
| deploy 非测试文件 | 116 | `deploy/` 运行时闭包 |
| 仅 root 有 | 30 | `config/`、`skills/`（全部）、`specs/`（全部）——Skill/Spec 引导资产 |
| 仅 deploy 有 | 6 | `README.md`、`hooks/post_tool/repeated_delivery_suppression.js`、`hooks/post_tool/test_build_structured.js`、`requirements.txt`、`tools/frozen_maps/*`（2） |
| 两侧均存在但内容不同 | 2 | `adapters/claude_bridge.js`（deploy 含 ADV1 块）、`hooks/post_tool_policy_hook.js`（deploy 含 TBS/quick_shell 接线） |

结论：root 是「deploy 闭包镜像」，但为**裁剪版**——ADV1、Test/Build Structured、Repeat-Delivery-Suppression
三处运行时能力只在 `deploy/` 源里，未镜像进 root。这是既有分流，见 §8。

---

## 6. 最小回归汇总（Step 4）

| 检查项 | 结果 |
| --- | --- |
| Manifest 全量校验（`--check`） | PASS（142 payload / 328 sha256，0 缺失/0 哈希错/0 未登记） |
| Node 语法检查 | PASS（`claude_bridge.js`、adv1 测试、生成器均 `node --check` exit 0） |
| ADV1 默认开关测试 | PASS（真值表 `unset=OFF/1=ON/0=OFF/legacy=OFF`；1 条既有 fixture 缺失失败，见 §8） |
| TBS 相关测试 | PASS（default_flag 4/4） |
| 8 个离线 smoke | PASS（7 个 `run_smoke.js` 全 `SMOKE PASS` + `emit-diagnostic.js` exit 0） |
| root/deploy 差异检查 | 完成并记录（§5） |
| README 文档链接 | 通过（`CAPABILITY-EVIDENCE` / `DEPLOYMENT-GUIDE` / `RUNNER-OBSERVABILITY-GUIDE` / `LICENSE` / `examples/README.md` 均存在） |
| PowerShell Parser | PASS（`run-tasco-task.ps1` ParseFile 无错误） |

如无新增问题，不再安排额外测试轮次。

---

## 7. 修复分支与 PR

- 分支：`repair/publication-integrity-r1`（已推送 `origin/repair/publication-integrity-r1`）
- PR：https://github.com/sunSUNQ/TASCO/pull/1 （base `main`，未自动合并）

---

## 8. v1.0.0 tag 与修复分支的差异

修复分支相对 `tasco-v1.0.0` tag（`ccfef36`）领先 3 个提交：

```text
6d3e4fb fix(readme): repair GBK-mojibake corruption from v1.0.0 release packaging   （已存在于 main）
a13271d fix(release): ADV1 默认 OFF + TBS 预处理文档 + 两阶段 manifest 生成器
a175556 fix(release): 从已提交源码重新生成 v1.0.0 manifest（两阶段 sourceCommit）
```

变更文件 6 个：`README.md`（GBK 修复 + TBS 文档）、`RUNNER-OBSERVABILITY-GUIDE.zh-CN.md`、
`deploy/adapters/claude_bridge.js`、`deploy/adapters/claude_bridge_adv1_transport.test.js`、
`deploy_manifest.json`（重生成）、`product/tools/build_deploy_manifest.js`（新增）。

---

## 9. 既有发布完整性缺陷与本轮修复边界（诚实披露）

以下问题为本轮**整改真正由发布流程引入的完整性缺陷**时发现，但**不属于三项决策的修复范围**，未改动：

1. **deploy 闭包镜像到 root 是裁剪版**：root 缺失 `test_build_structured.js`（TBS）、
   `repeated_delivery_suppression.js`、`claude_bridge.js` 的 ADV1 块、`post_tool_policy_hook.js` 的 TBS 接线。
   即当前 `git checkout tasco-v1.0.0` 指向的 root 实际**不含** ADV1 与 TBS——决策 1/2 的运行时实体只存在于 `deploy/` 源。
2. **随包 `deploy/` 测试引用未随包发布的 fixture**：`docs/experiments/…/f1-tap-44pass.out`、
   `pilot_manifests/…`、`read_lab/…` 等均不在发布仓；`deploy/` 测试套件因此无法在本仓管道完整跑通。
3. **README 版本身份不一致**：仍含 `当前版本 tasco-v0.8-rc2`、`sourceCommit 34b858e8`、
   `tag tasco-v0.8`、`142 payload` 等多处旧版残留（与正文 `tasco-v1.0.0` 并存）。

---

## 10. GitHub Release 勘误建议（供负责人参考，不自动执行）

- **不建议**在本轮移动 `tasco-v1.0.0` tag 或改动已发布 Release（任务约束）。
- 建议在 Release 说明追加一条勘误：发布物 `deploy_manifest.json` 的 `sourceCommit`/`payloadFileCount`/`sha256`
  存在错误，已由分支 `repair/publication-integrity-r1` + PR #1 修正；root 镜像缺少 ADV1/TBS 运行时，能力以 `deploy/` 源为准。
- 若需以「正确闭包」重新对外发布，建议走**新的 patch 版本（如 v1.0.1）**并重新走 tag/Release（需负责人授权；本轮未做）。

---

## 11. 是否建议合入 main

**建议合入 main**（三项已批准决策均已正确落地并回归通过，Manifest 完整性显著修复，无回归）。
但合入前请负责人明确答复 §9 第 1 条（root/deploy 裁剪分流）的处置立场——它决定了 v1.0.0 的
对外能力承诺是否成立，属发布决策而非代码修复。

---

## 12. 最终判定

```
TASCO_V1.0_PUBLICATION_INTEGRITY_FINAL_PASS
```

- 三项决策：ADV1 默认 OFF ✅ / TBS 默认 ON 说明补齐 ✅ / sourceCommit 两阶段 ✅
- 最小回归：全部通过 ✅
- 修复分支已推送，PR 已创建，未移动 tag、未改 Release、未创建新版本 ✅
- 停止点：等待负责人批准合入 main。

（§9 列出的既有缺陷为发现项，不阻断本轮三项决策的完成判定，但属负责人后续裁决事项。）

---

# R2 补记（2026-10-21 · TASCO-V1.0-PR1-FINAL-GAP-CLOSURE-R2）

## 最终 PR HEAD

`5c72916be3065f976a500168c01b0527353af67d`（两阶段：源码 `aaf1d24` → manifest `5c72916`）

## 变更文件清单（20 文件）

- 运行时同步（root/deploy 一致性）：`adapters/claude_bridge.js`、`hooks/post_tool_policy_hook.js`、新增 `hooks/post_tool/test_build_structured.js`、`hooks/post_tool/repeated_delivery_suppression.js`
- 文档/版本统一：`README.md`、`deploy/README.md`、`CAPABILITY-EVIDENCE.zh-CN.md`、`DEPLOYMENT-GUIDE.zh-CN.md`、`RUNNER-OBSERVABILITY-GUIDE.zh-CN.md`
- Runner 身份：`run-tasco-task.ps1`（默认版本改读 manifest releaseTag，不再回退 tasco-v0.7）
- 生成器确定性：`product/tools/build_deploy_manifest.js`（generatedAt 取 sourceCommit 提交时间）
- 测试 fixture：新增 `deploy/fixtures/f1-tap-44pass.out`，8 个测试文件改指向新位置

## 测试结论（全部通过）

- Node 语法：PASS（运行时 / 生成器 / 8 个测试文件）
- ADV1 真值表（unset=OFF / 1=ON / 0=OFF / legacy=OFF）：**9/9 PASS**
- TBS default-flag：**4/4 PASS**
- 离线 smoke：**7/7 SMOKE PASS**
- root/deploy 入口一致性：运行时 4 文件逐字节一致（differ=0）
- PowerShell Parser：PASS；UTF-8 扫描：0 乱码；Markdown 链接：0 断链

## Manifest

- sourceCommit = `aaf1d241f7466970d5800fe11e2eaa47a705d652`（源码提交，非 manifest 自身 HEAD）
- payload = 144 / package = 148 / sha256 = 331
- `--check` 全通过（0 缺失 / 0 哈希错 / 0 未登记）
- 同源两次生成字节一致（SHA256 `58FE7AB2…`）

## 当前版本声明核查

所有「当前版本」声明统一为 `tasco-v1.0.0`；v0.x 仅存于「历史发布」与 Roadmap 历史项；
「Pending Release Approval」已删除；BibTeX = v1.0.0。

## 未解决问题（遗留，非阻断）

- `deploy/` 下 read/search 测试仍依赖研发仓 fixture（`read_lab/r1.js`、`pilot_manifests/`、`compression_lab/`、`hook_ab_test/`），未随本仓发布 → 该类测试不可独立复现，已如实标记，不计入 PASS。
- 上游 tag / Release 未改动（任务约束）。

## R2 最终判定

```
TASCO_V1.0_PR1_READY_TO_MERGE
```