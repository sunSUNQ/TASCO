# OpenCode 运行环境契约(Windows 原生) - Core

本会话运行在 Windows 原生环境。opencode 的 bash 工具使用 PowerShell 执行命令,请遵循以下契约。

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

## 可用辅助脚本(只走 CLI,参数错误时 hook 会提示正确用法)
- repo_map.py:仓库结构摘要
- read_file_slice.py:精确行范围读取
- smart_read_file.py:符号/主题定向读取
- spec_read_file.py:契约读取
- safe_replace.py:安全替换
- 调用方式:python -X utf8 "D:/hook_gemini/tools/<脚本>.py" ...;参数缺失或格式错误时,hook 会自动补全或提示正确命令。

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
