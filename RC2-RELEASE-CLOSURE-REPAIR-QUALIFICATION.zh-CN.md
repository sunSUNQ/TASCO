# RC2 Release Closure Repair Qualification（tasco-v0.8-rc2）

**结论：RC2 Release Closure defect repaired = PASS；RC2 capability verdict unchanged。**
本记录定性本次缺陷为 release packaging defect，不重开任何能力线，不触发能力实验重做。

## 1. 缺陷定性

tasco-v0.8-rc2 发布同步提交（`d21a68d`）按 deploy 排除规则 `*.test.js`
清理"unit-test files"时，误删了
`examples/terminal-state-compression-smoke/fixture_tests/sample.test.js`。
该文件不是单测，而是该 smoke 的运行时 fixture（`run_smoke.js` 以
`node --test` 真实执行以产出 TAP 成功终态输出），缺失导致：

```text
examples/terminal-state-compression-smoke npm run smoke
→ "fixture test failed to run cleanly (expected exit 0)"，exit 1
```

其余 7 条 smoke、preflight 与 142/142 payload manifest 完整性在缺陷版本上
均 PASS，影响范围仅此一条 smoke。

## 2. 修复内容（最小 delta）

| 项 | 修复 |
| --- | --- |
| fixture | `git mv sample.test.js → sample.fixture.js`（字节不变），脱离 `*.test.js` 清理类 |
| runner | `run_smoke.js` 的 `TEST_CMD` 与 `spawnSync` 参数同步指向 `sample.fixture.js` |
| manifest | `version`/`releaseTag` 统一为 `tasco-v0.8-rc2`；新增 `smokeFixtures` 段对 fixture 做 SHA 入册 |

语义分离（本修复的核心设计）：

```text
*.test.js     = 项目测试代码，deploy closure 可排除
*.fixture.js  = 发布后 smoke 依赖的运行时测试输入，必须存活于 release repo
```

fixture 不进入 142 payload（`payloadScope.excluded` 保持 `examples/` 整体
排除，无白名单特例），但通过独立 `smokeFixtures` 段获得与 payload 同级的
existence + SHA gate，未来 closure sync 再丢文件会被完整性检查直接抓获。

## 3. Qualification 证据

环境：隔离克隆（win32，Node v24.18.0），从修复后工作树独立组装两个干净
闭包 A/B（排除 `.git`、`.tasco-runs`、`.code-guard` 等运行时残留），
执行同一套件。

| 判据 | 闭包 A | 闭包 B |
| --- | --- | --- |
| 8/8 smoke PASS（含 terminal-state） | PASS | PASS |
| preflight PASS | PASS | PASS |
| payload 142/142 存在 + SHA256 匹配 | PASS | PASS |
| smoke 前后各验一次 manifest（零污染） | PASS | PASS |
| closureGate：71 payload .js、95 相对 require/import 全闭合 | PASS | PASS |
| `smokeFixtures` existence + SHA + 非 payload 纪律 | PASS | PASS |
| 旧路径 `sample.test.js` 不存在 | PASS | PASS |
| release identity = tasco-v0.8-rc2 | PASS | PASS |
| payload 零漂移（142/142 SHA 与 RC1 生成 manifest 逐字节一致） | PASS | PASS |

payload 零漂移证明本修复未触碰任何能力实现字节，故
**capability verdict unchanged** 成立；两条链路同时覆盖"修复正确性"与
"没有偷偷改变能力实现"。

## 4. 提交后轻量复验（冻结门槛）

从本修复 commit 的干净 checkout（`git worktree` / `git archive`，非源码
工作树）重复执行，全部通过方可冻结：

```powershell
git worktree add --detach ..\tasco-rc2-freeze-verify HEAD
cd ..\tasco-rc2-freeze-verify
# 8 smoke（terminal-state / arbitration / validation-delta / failure-carrier
#          / diagnostic(npm run diagnostic) / read / precision-search / session-marker）
# preflight: tools\test-tasco-preflight.ps1 -WorkDir . -EnableTasco
# manifest: 142/142 SHA + identity = tasco-v0.8-rc2
```

判据：8/8 smoke PASS、preflight PASS、142/142 SHA PASS、identity = RC2。
通过后 RC2 release closure 定为冻结状态。

## 5. Follow-up（不阻塞 RC2，转入 release tooling hardening）

1. `packageFileCount=146` 记为 metadata accounting debt：d21a68d 加入
   LICENSE 后计数口径存疑，generator 不在仓内、counting contract 未定义
   （payload / payload+metadata / 整个 release closure；LICENSE、README
   是否计数），在定义前保持不动。
2. `smokeFixtures` 段固化进上游 manifest generator：payload
   （正式部署内容，SHA gate）与 smokeFixtures（发布资格验证依赖，独立
   existence/SHA gate，非 deploy payload）两类分离应在 generator 中成为
   一等公民，否则下次 generator 重生成会丢该段。

## 6. 审计备注

- 修复提交于临时隔离克隆（Temp），作者身份按仓库历史作者局部配置
  （`sunSUNQ <sunSUNQ@users.noreply.github.com>`）。
- 验证工件：manifest 验证脚本与 RC1 基线 manifest 见发布审计记录
  （rc2_verify.js / rc1_manifest_baseline.json）；合格闭包
  tasco-rc2-qual-A/B 与 post-commit 冻结验证 checkout 均可按第 4 节复现。
