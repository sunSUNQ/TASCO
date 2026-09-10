# OpenCode 运行环境契约(Windows 原生)

本会话运行在 Windows 原生环境。opencode 的 bash 工具使用 PowerShell 执行命令,请遵循以下契约。

> 说明：本文件为完整版（core + workflow），供 BROAD 任务使用。
> SIMPLE/TARGETED 任务由插件注入 core 版（windows-native-core.md）。

## 环境
- OS: Windows
- Shell: Windows PowerShell(opencode bash 工具)
- 命令风格:PowerShell 兼容命令
- Python helper 调用方式:C:\Users\sunqinghw\AppData\Local\Programs\Python\Python312\python.exe -X utf8 "<helper.py>" ...

## Hook 辅助目录(固定,不要发现/搜索/猜测)
- Hook 安装目录:D:/hook_gemini
- 辅助脚本目录:D:/hook_gemini/tools
- 临时/缓存/状态目录:<项目根>/.code-guard(由 CODE_GUARD_BASE_DIR 控制;不要在仓库里写临时文件)
- 不要用 Get-ChildItem / ListDirectory 定位 hook 辅助脚本。

## 可用辅助脚本(只走 CLI,python -c import 会被拒绝)
- 仓库结构摘要:C:\Users\sunqinghw\AppData\Local\Programs\Python\Python312\python.exe -X utf8 "D:/hook_gemini/tools/repo_map.py" "<repo_root>"
- 精确行范围读取:C:\Users\sunqinghw\AppData\Local\Programs\Python\Python312\python.exe -X utf8 "D:/hook_gemini/tools/read_file_slice.py" "<file>" <start_line> <end_line>
- 符号/主题读取:C:\Users\sunqinghw\AppData\Local\Programs\Python\Python312\python.exe -X utf8 "D:/hook_gemini/tools/smart_read_file.py" "<file>" --query "<symbol_or_topic>"
- 契约读取:C:\Users\sunqinghw\AppData\Local\Programs\Python\Python312\python.exe -X utf8 "D:/hook_gemini/tools/spec_read_file.py" "<spec>" --contract
- 安全替换:C:\Users\sunqinghw\AppData\Local\Programs\Python\Python312\python.exe -X utf8 "D:/hook_gemini/tools/safe_replace.py" "<replace_json>"

## 使用规则
- 仓库结构分析优先 repo_map.py,不要先做宽泛目录枚举。
- 源码/契约证据优先 read_file_slice.py 的有界切片。
- 符号/函数定向读取优先 smart_read_file.py。
- 复杂替换优先 safe_replace.py,JSON 放在 hook 临时目录。
- 辅助脚本用绝对路径调用。

## 编码规则
- 源码/契约/文档默认按 UTF-8 处理。
- 读中文或多语言文件用 python -X utf8 helper,避免乱码。
- 必须用 PowerShell 读文本时显式指定编码:Get-Content -Encoding UTF8 "<file>"。

## Shell 命令规则
- 不要假设 Linux/macOS 工具可用(head/tail/sed/awk/xargs/find)。
- 优先 PowerShell 原生等价:
  - head -200 => Select-Object -First 200
  - cat <file> => Get-Content -Encoding UTF8 <file>
  - grep <pattern> <file> => Select-String -Pattern <pattern> -Path <file>
  - find . -name "*.c" => Get-ChildItem -Recurse -Filter *.c
- 输出可能含非 ASCII 时先设置 UTF-8 输出。

## 治理提示
- 宽泛搜索(如 rg pattern .)会被拦截,改用内置 grep 精确符号/文件名。
- 整文件读取会被拦截,改用行范围切片。
- 无证据的编辑会被拦截,先定位目标再修改。
- 被压缩的 read/grep/shell 输出不要顺序补读下一段,改用精确搜索或切片。
