# TASCO 鈥?闈㈠悜 Code Agent 鐨勯€夋嫨鎬т笂涓嬫枃浼樺寲锛堝伐鍏峰彂甯冧粨锛?
**TASCO**锛?*T**ask-**A**ware **S**elective **C**ontext **O**ptimization锛?浠诲姟鎰熺煡閫夋嫨鎬т笂涓嬫枃浼樺寲锛夋槸涓€涓潰鍚?Code Agent 鐨勯€夋嫨鎬т笂涓嬫枃浼樺寲杩愯鏃讹紝
鐩爣鏄湪**淇濊瘉浠诲姟鎴愬姛鐜囥€佺粨鏋滄纭€у拰浠撳簱鍋ュ悍搴︿笉閫€鍖?*鐨勫墠鎻愪笅锛岄€氳繃浠诲姟鎰熺煡
鐨勯€夋嫨鎬т粙鍏ワ紝闄嶄綆 Code Agent 鎵ц杩囩▼涓殑杈撳叆銆佽緭鍑恒€佺紦瀛?Token 浠ュ強涓嶅繀瑕佺殑
宸ュ叿璋冪敤鍜屾帰绱㈣疆娆°€傚畠**涓嶆槸閫氱敤 summarizer**锛氭槸鍚︿紭鍖栥€佷綍鏃朵紭鍖栫敱璇佹嵁褰㈡€佸喅瀹氾紝
鍏朵綑鍦烘櫙**榛樿淇濇寔 Native锛堝師鐢熸墽琛岋級**銆?
鏈粨 = TASCO 鐨?*浜у搧鍙戝竷浠?*锛坉eploy 闂寘闀滃儚鍒?root锛夈€傚綋鍓嶅彂甯冨唴瀹?=
**tasco-v1.0.0** 璧勬牸鍖栭棴鍖咃紙Release Qualified / Pending Release Approval锛夛細
142 payload / 146 package锛岀敱纭畾鎬х敓鎴愬櫒浜у嚭锛宍deploy_manifest.json` 鍐呭惈鍏ㄩ儴
鏂囦欢 SHA256锛屽彲绂荤嚎鏍￠獙瀹屾暣鎬с€?
## 褰撳墠鐗堟湰锛歵asco-v0.8-rc2

```text
鍙戝竷鍐呭
鈹斺攢 deploy 闂寘锛?42 payload锛宻ourceCommit 34b858e8 鏋勫缓鏍戯級
   Existing-Line Evidence Closure锛?/7 evidence lines resolved
   锛? CLOSED + 1 CLOSED-BOUNDED锛?1 units锛宺egistry 948 runs锛孎0=0锛?
   榛樿 AUTO锛坮unner 榛樿寮€鍚級锛欴iagnostic / Terminal-State /
   Validation Delta / Failure Carrier / Search Guidance锛堣法浠擄級/ Read R1-R5
   榛樿鍏筹細Search Result Compression锛坥perator flag锛夛紱Structural Context =
   frozen Native by design

鍘嗗彶鍙戝竷
鈹溾攢 tasco-v0.7  Validation Coverage Expansion锛圡-V3 楠岃瘉璇箟韬唤 + Search
鈹?             Compression bridge 闆嗘垚锛?鈹溾攢 tasco-v0.6  Read R1-R5 浠诲姟椹卞姩璇诲彇鍘嬬缉榛樿 AUTO
鈹斺攢 tasco-v0.5  Terminal / Validation Delta / Failure Carrier 榛樿 AUTO + 缁熶竴浠茶
```

- **鑳藉姏璇佹嵁鎽樿**锛歔CAPABILITY-EVIDENCE.zh-CN.md](./CAPABILITY-EVIDENCE.zh-CN.md)
- **閮ㄧ讲涓庢帴鍏?*锛歔DEPLOYMENT-GUIDE.zh-CN.md](./DEPLOYMENT-GUIDE.zh-CN.md)
- **瑙傛祴涓?telemetry**锛歔RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](./RUNNER-OBSERVABILITY-GUIDE.zh-CN.md)

## 鑳藉姏姒傝

| Capability | Tier | Default | 鍦烘櫙 |
| --- | --- | --- | --- |
| Diagnostic Semantic Compression锛圠arge Diagnostic锛?| AUTO | ON | 鈮?K 澶у瀷璇婃柇浠峰€艰緭鍑猴紙error-path 璇婃柇銆乧ompiler/stack 杈撳嚭锛夛紱`exit=0` 鐮旂┒瀵硅薄锛坄exit!=0` 褰?Failure Carrier锛?|
| Failure Carrier 鈫?Diagnostic | AUTO | ON | 鐪熷疄娴嬭瘯/鏋勫缓澶辫触锛坄exit!=0`锛夎嚜鍔ㄨ繘鍏ヨ瘖鏂帇缂╅摼锛涘師鍛戒护/exit code/杈撳嚭鍏ㄧ▼淇濈暀 |
| Terminal-State Success Compression | AUTO | ON | `exit=0` 涓斿畬鏁村彲璇嗗埆鐨勬垚鍔?test/build 缁堟€?|
| Validation Delta Compression | AUTO | ON | 鍚屼竴楠岃瘉閲嶅鎵ц涓斿彲姣旇緝锛氬彧浜や粯"鍙戠敓浜嗕粈涔堝彉鍖?锛圡-V3 璇箟韬唤锛孎P=0锛?|
| 缁熶竴浠茶 | 鍐荤粨 | 甯搁┗ | 涓€娆¤緭鍑哄彧閫変竴绉嶅唴瀹瑰彉鎹細澶辫触璇婃柇 > 绋冲畾 VD > 鎴愬姛缁堟€?> Native锛沗double_apply_count` 鎭掍负 0 |
| 绮惧噯浠ｇ爜鎼滅储锛圫earch Guidance锛?| AUTO锛堣法浠撴硾鍖栵級 | ON | DISCOVERY/FILTER 鎰忓浘姝ｅ尯鑷姩娉ㄥ叆鎼滅储鏀舵暃寮曞锛汱OOKUP/鏋氫妇/缁熻/鏈煡淇濇寔 Native |
| Read R1-R5锛圧ead Core + Read Extended锛?| AUTO | ON | 浠诲姟椹卞姩璇诲彇鍘嬬缉锛歊1 鎶藉彇 / R2 鍏崇郴杈?/ R3 瀹炵幇閾?/ R4 閲嶈鎶戝埗 / R5 鏂囨。鑺傞€夛紱R2/R3 闇€ identity map锛坥n-demand 鐢熶骇锛?|
| Search Result Compression | 鐙珛寮€鍏?| **OFF**锛坥perator flag锛?| 绛涢€夊瀷 grep 缁撴灉鍘嬬缉锛坆ridge grep 鑵匡級锛涘垎甯?璁℃暟/鏋氫妇 fail-closed锛沗CODE_GUARD_STRUCTURED_SEARCH=1` 鏄惧紡鍚敤 |
| Structural Context | frozen Native | 鈥?| 璁捐鎬?Native锛涙帰绱㈠墛鍑忚竟鐣岃瘉鎹?|

> 瀹舵棌鍙ｅ緞锛氬墠鍥涜浠诲姟杈撳嚭鑳藉姏 = **涓€涓?Task Output Compression 瀹舵棌涓嬬殑 4 绉?> 浜掓枼绛栫暐**锛堜竴娆″伐鍏疯緭鍑鸿嚦澶氫竴娆″唴瀹瑰彉鎹級銆傚叏閮ㄨ兘鍔涘綊绾充负
> **3 澶х被 / 6 瀹舵棌 / 7 鏉¤瘉鎹嚎璺?*锛堜换鍔¤緭鍑?4 + Read 2 + Search 1锛夈€?
# 瀹夎

## 鐜瑕佹眰

- Git
- Node.js >= 18锛堝疄娴?24锛?- 浠讳竴鍙楁敮鎸?Agent CLI锛欳laude Code >= 2.1.x銆丆odeAgentCLI 3.0锛圕laude 鍏煎锛?  `.cac` 閰嶇疆锛夋垨 OpenCode V1鈥斺€斾笁鑰呴€氳繃缁熶竴 Agent Adapter 娑堣垂鍚屼竴濂楀喕缁撴牳蹇?- 鍏煎 Anthropic 鍗忚鐨勬ā鍨嬬鐐广€傚綋鍓?Qualification 浣跨敤
  `deepseek-v4-flash`锛涘叾浠栨ā鍨嬫垨绔偣闇€閲嶆柊鎵ц Qualification銆?
## 鍏嬮殕骞跺浐瀹氱増鏈?
```bash
git clone https://github.com/sunSUNQ/TASCO.git tasco
cd tasco
git checkout tasco-v1.0.0          # 褰撳墠鍙戝竷 tag

# 杩愯鏃堕棴鍖呭凡闅忔湰浠撴彁渚涳紱甯搁┗鎺ュ叆鏃舵寚鍚?hooks
export CODE_GUARD_HOOK_DIR="$(pwd)/hooks"
```

## 鎺ュ叆 Agent锛圕laude Code / CodeAgentCLI / OpenCode锛?
- **Claude Code / CodeAgentCLI**锛氶€氳繃 Agent 鐨?hooks schema 鎺ョ嚎
  锛圕laude Code 鈫?`.claude/settings.json`锛汣odeAgentCLI 鈫?`.cac/settings.json`锛夛紝
  鎶?`PreToolUse` / `PostToolUse` / `UserPromptSubmit` 浜嬩欢鎺ュ埌
  `adapters/claude_bridge.js`銆?- **OpenCode**锛氳蛋鎻掍欢鍗忚銆傛妸 `plugin/governance.js` 澶嶅埗鍒伴」鐩殑
  `.opencode/plugins/`锛屽苟纭繚 `.opencode/package.json` 甯?`"type": "module"`锛?  鎻掍欢閫氳繃 `CODE_GUARD_DEPLOY_ROOT`锛堝洖閫€ `CODE_GUARD_HOOK_DIR\..`锛夎В鏋愰棴鍖呫€?
涓€閿?runner 瑕嗙洊涓夌 Agent锛堣嚜鍔ㄥ畨瑁?娓呯悊鎺ョ嚎銆佸疄鏃舵墦鍗?hook 涓?selected/applied telemetry锛夛細

```powershell
# Claude Code
& .\run-tasco-task.ps1 -Agent claude -WorkDir D:\my-project -Prompt "杩愯 npm test 骞跺垎鏋愬け璐ユ牴鍥狅紝涓嶈淇敼鏂囦欢銆? -EnableTasco

# CodeAgentCLI 3.0锛堥渶瑕?-Model 鎴?CODE_GUARD_INTERNAL_MODEL锛?& .\run-tasco-task.ps1 -Agent codeagent -Model "DeepSeek-v4-Flash-SZ" -WorkDir D:\my-project -Prompt "..." -EnableTasco

# OpenCode锛堟ā鍨嬬敱鏈満 opencode auth 鎻愪緵锛?& .\run-tasco-task.ps1 -Agent opencode -OpenCodeModel "deepseek/deepseek-v4-flash" -WorkDir D:\my-project -Prompt "..." -EnableTasco
```

鍏潯鑳藉姏绾垮湪鏍囧噯 runner锛坄-EnableTasco`锛変腑**榛樿寮€鍚?*锛屽闇€鍥炴粴鍙樉寮忓叧闂紱
Search Result Compression 榛樿鍏筹紝闇€鏄惧紡鍚敤锛?
```powershell
$env:CODE_GUARD_TERMINAL_STATE = "0"                  # 鍙€夛細鍏抽棴 Terminal-State 鍘嬬缉
$env:CODE_GUARD_VALIDATION_DELTA = "0"                # 鍙€夛細鍏抽棴 Validation Delta
$env:CODE_GUARD_FAILURE_CARRIER_AUTO = "0"            # 鍙€夛細鍏抽棴 Failure Carrier锛堝洖鍒?legacy锛?$env:CODE_GUARD_SEARCH_GUIDANCE = "0"                 # 鍙€夛細鍏抽棴绮惧噯浠ｇ爜鎼滅储
$env:CODE_GUARD_SEARCH_GUIDANCE_AUTO = "0"            # 鍙€夛細鍙叧闂法浠撴硾鍖栵紙鍥炲埌鐧藉悕鍗曟ā寮忥級
$env:CODE_GUARD_READ_COMPRESSION = "0"                # 鍙€夛細Read R1-R5 鍏?Native
$env:CODE_GUARD_STRUCTURED_SEARCH = "1"               # 鍙€夛細鍚敤 Search Result Compression锛堥粯璁ゅ叧锛?```

## 鍏抽敭鐜鍙橀噺

| 鍙橀噺 | 鐢ㄩ€?| 榛樿鍊?|
| --- | --- | --- |
| `CODE_GUARD_HOOK_DIR` | 鍐荤粨鏍稿績 hook 鐩綍锛坧re/post policy hooks銆乧ompressor锛?| 蹇呭～ |
| `CODE_GUARD_NODE_BIN` | 杩愯鏍稿績 hook 鐨?node 鍙墽琛屾枃浠?| 鑷姩瑙ｆ瀽 |
| `CODE_GUARD_BASE_DIR` | 鐘舵€?/ telemetry / 褰掓。鏍圭洰褰?| `<椤圭洰>/.code-guard` |
| `CODE_GUARD_AGENT_RUNTIME` | 寮哄埗鎸囧畾 agent 杩愯鏃讹細`opencode` / `claude-code` | 鑷姩妫€娴?|
| `CODE_GUARD_CACHE_DISCOUNT` | 鏈夋晥鎴愭湰妯℃嫙涓殑 cache-read 鏉冮噸 | `0.1` |
| `CODE_GUARD_DEPLOY_ROOT` | OpenCode 鎻掍欢瑙ｆ瀽鍐荤粨闂寘鐨勬牴鐩綍 | `CODE_GUARD_HOOK_DIR\..` |
| `CODE_GUARD_OPENCODE_CMD` | OpenCode CLI 鍙墽琛屾枃浠惰矾寰?| npm 鍏ㄥ眬 `opencode.exe` |
| `CODE_GUARD_OPENCODE_MODEL` | OpenCode 浣跨敤鐨?`provider/model` | `deepseek/deepseek-v4-flash` |
| `CODE_GUARD_TERMINAL_STATE` | Terminal-State 鎴愬姛缁堟€佸帇缂?| runner 榛樿 `1`锛涙樉寮?`0` 鍥炴粴 |
| `CODE_GUARD_VALIDATION_DELTA` | Validation Delta 閲嶅楠岃瘉澧為噺 | runner 榛樿 `1`锛涙樉寮?`0` 鍥炴粴 |
| `CODE_GUARD_FAILURE_CARRIER_AUTO` | 澶辫触鑷姩杩涜瘖鏂摼锛圓uto Failure Carrier锛?| runner 榛樿 `1`锛涙樉寮?`0` 鍥炴粴 |
| `CODE_GUARD_SEARCH_GUIDANCE` | 绮惧噯浠ｇ爜鎼滅储锛堟悳绱㈣繃绋嬭嚜鍔ㄦ敹鏁涘紩瀵硷級 | runner 榛樿 `1`锛涙樉寮?`0` 鍥炴粴 |
| `CODE_GUARD_SEARCH_GUIDANCE_AUTO` | 璺ㄤ粨娉涘寲妯″紡锛堜粨搴撶櫧鍚嶅崟涓嶅啀鍙備笌 eligibility锛?| runner 榛樿 `1`锛涙樉寮?`0` 鍥炲埌鐧藉悕鍗曟ā寮?|
| `CODE_GUARD_SEARCH_GUIDANCE_PILOTS` | 璇曠偣浠撶櫧鍚嶅崟锛堜粎鏈紑 AUTO 鏃剁敓鏁堬級 | `fastify`锛堝吋瀹逛繚鐣欙級 |
| `CODE_GUARD_READ_COMPRESSION` | Read R1-R5 璇诲彇鍘嬬缉锛圧2/R3 鍙﹂渶 identity map锛?| runner 榛樿 `1`锛涙樉寮?`0` 鍏?Native |
| `CODE_GUARD_STRUCTURED_SEARCH` | Search Result Compression锛坆ridge grep 鑵匡級 | 榛樿鍏筹紱鏄惧紡 `1` 鍚敤锛坥perator flag锛?|

## 瀹屾暣鎬ф牎楠?
```powershell
# deploy_manifest.json 鍐呭惈 142 涓?payload 鏂囦欢鐨?SHA256锛涘彲鐢ㄤ换鎰忓伐鍏烽€愭枃浠舵牳瀵?# 锛坧owerShell 绀轰緥瑙?DEPLOYMENT-GUIDE.zh-CN.md锛?```

# 鍘熺悊姒傝堪

Code Agent 浼氬湪宸ュ叿杈撳嚭涓婃秷鑰楀ぇ閲忎笂涓嬫枃銆傛湸绱犵殑淇鈥斺€斻€屽叏閮藉帇缂┿€嶁€斺€旀槸澶辫触鐨勶細
瀹為獙璇佹槑锛岀洸鐩帇缂╁甫鏉ョ殑灞€閮?token 鑺傜渷锛屼細琚獙璇佹€ч噸璇伙紙verification
re-read锛夊拰杞ㄨ抗鎵板姩閮ㄥ垎鐢氳嚦鍏ㄩ儴鍚冩帀銆俆ASCO 鐨勬牳蹇冪粨璁烘槸锛?*浼樺寲鏀剁泭楂樺害渚濊禆
璇佹嵁褰㈡€?*鈥斺€旀寜璇佹嵁褰㈡€佸垎涓?Content Reduction锛堝帇缂╁凡浜х敓鐨勫唴瀹癸級涓?Exploration
Reduction锛堝噺灏戜负瀵绘壘淇℃伅鑰屼骇鐢熺殑涓婁笅鏂囷級銆?
涓€娆″伐鍏蜂簨浠剁殑楂樺眰娴佺▼锛?
```text
agent 浜嬩欢锛圥reToolUse / PostToolUse / UserPromptSubmit锛汷penCode: before/after锛?        |
        v
缁熶竴 Agent Adapter锛坅gent 妫€娴?-> 宸ュ叿鍚嶅綊涓€鍖?-> 杞借嵎褰掍竴鍖栵級
        |
        v
Capability Selector锛堜繚瀹堛€佹樉寮忚鍒欓┍鍔紱榛樿 Native锛?        |
        v
Quality Guard -> Primitive Executor -> fallback锛坒ail-open锛?        |
        v
缁撴灉閫傞厤 + telemetry锛坰elected / applied / fallback_reason锛?```

璺敱閲囩敤**淇濆畧銆佹樉寮忚鍒欓┍鍔?*鐨勭瓥鐣ワ細浠ョ‘瀹氭€ц鍒欒矾鐢变负涓伙紝涓嶄緷璧栭澶栨ā鍨嬭繘琛?鑳藉姏閫夋嫨锛涙湭鐭ユ剰鍥俱€佺紪杈戞剰鍥俱€乴exical 绮剧‘鎬ц姹傘€佽礋鍖?/ 杈圭晫鏉′欢銆佷綆缃俊搴﹀満鏅?涓€寰嬩繚鎸?Native銆?
# 瀹為獙璇佹嵁锛堟憳瑕侊級

鎸囨爣鍙ｅ緞锛?*LCR** = `(rtIO + 0.1 * cacheRead)`_鍚敤 / `(rtIO + 0.1 * cacheRead)`_Native
锛?1 = 鍑€鏀剁泭锛夛紱**TSR** = turns_鍚敤 / turns_Native锛堣川閲忎紭鍏堬級锛涘畨鍏ㄥ簳绾?=
WIR / wrong_capability / double_apply / F0 鍏ㄩ儴涓?0銆?
璇佹嵁瀹囧畽锛歳egistry 948 runs锛坋ligible 652锛夈€?/7 evidence lines resolved銆?瀹夊叏瀹囧畽 F0=0銆?
| 鑳藉姏 | 鍏抽敭鏁版嵁锛堝喕缁撳彛寰勶級 | 鐘舵€?|
| --- | --- | --- |
| Large Diagnostic | 36/36 controlled锛? 浠擄級锛宼asco 18/18 applied + model-visible锛沵acro median saving 91.9%锛圛QR 79.6-93.0锛夛紱safety 4/4 | CLOSED |
| Failure Carrier | 36/36 controlled锛沵acro median 82.6%锛?7.5-91.9锛夛紱single execution锛泂afety 5/5锛泈rong_capability=0 | CLOSED |
| Terminal-State | Lab 43/43锛?6.09% pooled锛? A/B 18/18 + Online 3752 chars model-visible | CLOSED |
| Validation Delta | Online unchanged 6299鈫?30锛汳-V3 璇箟韬唤 FP=0锛涜嚜鐒跺伐浣滄祦 repeat 鏈轰細 1/6锛坥pportunity-limited锛岃瘹瀹炶竟鐣岋級 | CLOSED-BOUNDED |
| Search Guidance | 30/30锛歵asco 娉ㄥ叆 12/12銆乶ative 0/12銆乼ask_success 24/24锛泂afety 2/2 闆惰娉ㄥ叆 | CLOSED |
| Search Result Compression | 24/24 controlled锛?5 娆?compressed greps macro median 92.7%锛圛QR 80.5-96.2锛夛紱default-off fail-closed | CLOSED锛坉efault OFF锛?|
| Read R1-R5 | R4 suppress median 96.5% / R3 94.5% / R5 58.7%锛汻2 15/15锛汻4 safety 24/24 闆?wrong_suppression | CLOSED 脳5 |
| Structural Context | G1 闈欐€佽祫鏍奸棬涓嶅彲婊¤冻璇佹槑锛涚粨鏋勬浛浠?LCR 0.74 | frozen Native |

閫愯兘鍔涜瘯楠岀粏鑺傝 [CAPABILITY-EVIDENCE.zh-CN.md](./CAPABILITY-EVIDENCE.zh-CN.md)銆?
## 鍐掔儫涓庨獙鏀?
```powershell
# 绂荤嚎鍐掔儫锛堟棤妯″瀷銆侀浂渚濊禆锛屽嚑绉掑嚭缁撴灉锛?cd examples\terminal-state-compression-smoke;  npm run smoke       # Terminal-State
cd examples\arbitration-one-winner-smoke;      npm run smoke       # 缁熶竴浠茶
cd examples\validation-delta-smoke;            npm run smoke       # Validation Delta
cd examples\failure-carrier-smoke;             npm run smoke       # Failure Carrier
cd examples\diagnostic-compression-smoke;      npm run diagnostic  # Large Diagnostic
cd examples\read-compression-smoke;            npm run smoke       # Read R1-R5
cd examples\precision-search-smoke;            npm run smoke       # 绮惧噯浠ｇ爜鎼滅储
cd examples\session-marker-smoke;              npm run smoke       # 浼氳瘽鏍囪
```

绔埌绔獙鏀舵祦绋嬭 [DEPLOYMENT-GUIDE.zh-CN.md](./DEPLOYMENT-GUIDE.zh-CN.md)銆?
# Roadmap

- [x] v0.5锛歍erminal / Validation Delta / Failure Carrier 榛樿 AUTO + 缁熶竴浠茶鍐荤粨
- [x] v0.6锛歊ead R1-R5 浠诲姟椹卞姩璇诲彇鍘嬬缉榛樿 AUTO
- [x] v0.7锛歏alidation Coverage Expansion锛圡-V3 璇箟韬唤 + Search Compression 闆嗘垚锛?- [x] v0.8-rc2锛欵xisting-Line 7/7 鏀跺彛 + Release Qualification锛坢anifest 闂寘淇锛夆啋 **Release Qualified / Pending Release Approval**
- [ ] GA 瀹℃壒 鈫?tag `tasco-v0.8`
- [ ] 1.0 鑳藉姏鎵╁睍锛堢爺鍙戠嚎锛夛細Diff/Patch 鈫?Git State/History 鈫?Dependency 鈫?Test/Build Structured 鈫?Trajectory Delta锛涘寳鏋佹槦 = Task Compression Coverage@5% 鈮?80%

# License

[MIT](./LICENSE) 鈥?Copyright (c) 2026 sunSUNQ (TASCO contributors)

# 寮曠敤

濡傛灉浣犲湪鐮旂┒涓娇鐢ㄤ簡 TASCO锛岃寮曠敤鏈粨搴擄紙璁烘枃鍙戣〃鍚庝細鍦ㄦ湰鑺傝ˉ鍏呮寮忔潯鐩級锛?
```bibtex
@misc{tasco2026,
  title        = {{TASCO}: Selective Context Optimization for Code Agents},
  author       = {TASCO contributors},
  year         = {2026},
  howpublished = {\url{https://github.com/sunSUNQ/TASCO}},
  note         = {v0.8-rc2: 7/7 existing capability lines closed and frozen (large diagnostic, failure carrier, terminal state, validation delta, search guidance + compression, read R1-R5) under one frozen arbitration contract}
}
```
