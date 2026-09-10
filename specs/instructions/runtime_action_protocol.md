# Code Guard Action Recovery 协议（只在发生治理拦截后注入）

当工具调用被治理拦截（BLOCK_* / STOP_EVIDENCE_*）时，按下面的协议执行，
不要盲目重试同一次调用：

1. 先读错误信息中的 **Expected next action**，按它执行下一步。
2. 原生 edit 被拦截（BLOCK_NATIVE_REPLACE_UNSTABLE）：不要重试 edit 工具，
   直接执行错误中给出的 **Generated command**（safe_replace.py + 会话 tmp
   目录下的预校验 JSON）。
3. safe_replace.py 必须带一个 replace JSON 路径参数；不要传行号、不要用
   `--help` 试探、不要执行 safe_replace_test.json。
4. 证据不足（verified_code_evidence_missing）：先用
   `read_file_slice.py <file> <start> <end>` 或 `smart_read_file.py --query
   <symbol>` 读取目标函数，再重试编辑。
