import sys
import os

# RLM 包目录解析(候选目录为"包含 rlm 包"的目录):
# 1. RLM_PACKAGE_DIR 环境变量
# 2. 项目内置的 rlm/ 包(脚本位于 tools/,项目根为其上一级)
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SCRIPT_DIR)
_RLM_PACKAGE_CANDIDATES = [
    os.environ.get("RLM_PACKAGE_DIR"),
    _PROJECT_ROOT,
]
for _rlm_dir in _RLM_PACKAGE_CANDIDATES:
    if _rlm_dir and os.path.isdir(_rlm_dir) and os.path.isdir(
        os.path.join(_rlm_dir, "rlm")
    ):
        sys.path.insert(0, _rlm_dir)
        break

import json
import traceback
from datetime import datetime

# 可选加载 .env(脚本所在目录、当前工作目录、RLM 包目录)
try:
    from dotenv import load_dotenv

    for _env_file in (
        os.path.join(_SCRIPT_DIR, ".env"),
        os.path.join(os.getcwd(), ".env"),
    ):
        if os.path.isfile(_env_file):
            load_dotenv(_env_file)
except Exception:
    pass

LOG_FILE = os.getenv("RLM_COMPRESS_LOG") or os.path.join(
    os.environ.get("CODE_GUARD_BASE_DIR") or os.path.join(os.path.expanduser("~"), ".cac"),
    "rlm_tool_compress.log"
)

COMPACTION_THRESHOLD_PCT = 0.7

# 代理处理:默认禁用代理(避免代理干扰直连端点);
# 如需走系统/环境变量配置的代理,设置 RLM_USE_SYSTEM_PROXY=1。
if os.getenv("RLM_USE_SYSTEM_PROXY") != "1":
    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"
    os.environ["HTTP_PROXY"] = ""
    os.environ["HTTPS_PROXY"] = ""
    os.environ["http_proxy"] = ""
    os.environ["https_proxy"] = ""


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")
    except Exception:
        # 日志写入失败不应中断压缩流程
        pass


def sanitize_text(text: str) -> str:
    if not isinstance(text, str):
        text = str(text)

    text = text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
    text = text.encode("gbk", errors="replace").decode("gbk", errors="replace")

    return text


def normalize_tool_name(tool_name: str) -> str:
    raw = str(tool_name or "unknown_tool").strip()
    lower = raw.lower()

    if "read" in lower and "file" in lower:
        return "read_file"
    if "grep" in lower or "search" in lower:
        return "grep_search"
    if "shell" in lower or "command" in lower or "run" in lower:
        return "run_shell_command"
    if "replace" in lower:
        return "replace"
    if "update" in lower and "topic" in lower:
        return "update_topic"

    return raw


def build_read_file_prompt(tool_name: str, tool_text: str) -> str:
    return f"""
你是一个代码编辑 Agent 的 read_file 工具输出压缩器。

你的任务是压缩一个被读取的代码文件内容，让后续代码 Agent 能继续进行代码理解、修改、调试和定位问题。

工具名称：
{tool_name}

压缩目标：
在不重新读取完整文件的情况下，后续 Agent 应该能知道这个文件的作用、结构、关键符号、关键逻辑和修改风险。

长度要求：
1. 输出必须显著短于原始内容。
2. 如果原始内容小于 8000 字符，输出必须控制在 1200 字符以内。
3. 如果原始内容在 8000～20000 字符，输出必须控制在 2000 字符以内。
4. 如果原始内容超过 20000 字符，输出必须控制在 3000 字符以内。
5. 不要复制大段原始代码。
6. 必要代码片段总量不超过 500 字符。

请重点保留：
1. 文件路径、文件名、模块名。
2. 文件整体职责和用途。
3. import / require / from / include 等依赖关系。
4. 主要 class、function、method、interface、type、export。
5. 关键变量、配置项、常量、环境变量。
6. 主流程逻辑、入口逻辑、调用链路。
7. 错误处理、异常处理、边界条件、权限、安全、IO、网络请求、数据库操作。
8. 和后续代码修改相关的关键代码片段。
9. TODO、FIXME、注释中的关键约束。
10. 如果文件很长，优先保留结构摘要和关键片段，不要逐行复述。

严格要求：
1. 不要引入原文没有的新事实。
2. 不要猜测不存在的逻辑。
3. 不要回答用户问题。
4. 不要输出寒暄。
5. 用中文输出。
6. 输出应服务于后续代码编辑，不是普通文章摘要。

输出格式：

[read_file 压缩摘要]

- 文件职责:
- 依赖关系:
- 主要结构:
- 关键函数/类:
- 关键逻辑:
- 错误处理/边界条件:
- 后续修改注意点:
- 必要代码片段:

原始 read_file 输出：

{tool_text}
""".strip()


def build_grep_search_prompt(tool_name: str, tool_text: str) -> str:
    return f"""
你是一个代码编辑 Agent 的 grep_search 工具输出压缩器。

你的任务是压缩搜索结果，让后续 Agent 能快速知道命中了哪些文件、哪些行、哪些符号，以及这些命中对代码修改有什么价值。

工具名称：
{tool_name}

长度要求：
1. 默认控制在 1500 字符以内。
2. 如果命中结果很多，优先保留和后续代码修改最相关的命中。
3. 合并重复或低价值命中，不要完整复述全部搜索输出。

请重点保留：
1. 命中的文件路径。
2. 命中的行号。
3. 命中的函数名、类名、变量名、配置名。
4. 命中附近的关键代码或文本。
5. 多个重复命中需要合并概括。
6. 如果命中结果很多，优先保留最可能影响后续修改的结果。
7. 如果能看出相关模块之间的关系，可以简要说明。
8. 如果搜索没有有效结果，需要明确说明没有有效命中。

严格要求：
1. 不要引入原文没有的新事实。
2. 不要扩写成完整代码分析。
3. 不要回答用户问题。
4. 不要输出寒暄。
5. 用中文输出。

输出格式：

[grep_search 压缩摘要]

- 搜索结论:
- 关键命中文件:
- 关键命中内容:
- 可能相关符号:
- 重复/低价值命中:
- 后续定位建议:

原始 grep_search 输出：

{tool_text}
""".strip()


def build_shell_prompt(tool_name: str, tool_text: str) -> str:
    return f"""
你是一个代码编辑 Agent 的 run_shell_command 工具输出压缩器。

你的任务是压缩命令行输出，让后续 Agent 能快速知道命令是否成功、失败原因、关键错误、测试结果或构建结果。

工具名称：
{tool_name}

长度要求：
1. 默认控制在 1500 字符以内。
2. 如果输出包含错误、异常、测试失败或构建失败，优先保留错误相关内容。
3. 如果命令成功且日志很长，只保留结论和少量关键输出。

请重点保留：
1. 执行的命令，如果原始输出中包含。
2. 成功或失败结论。
3. 失败时的异常类型、错误信息、堆栈关键帧。
4. 测试结果：passed / failed / skipped / error 数量。
5. 构建结果、安装结果、lint/typecheck 结果。
6. 关键 warning。
7. 文件路径、行号、模块名、包名。
8. 如果输出很长，保留最关键的错误上下文，不要保留大量重复日志。
9. 如果命令成功且日志很长，只保留结论和少量关键输出。

严格要求：
1. 不要引入原文没有的新事实。
2. 不要推测错误原因，除非原文明确说明。
3. 不要回答用户问题。
4. 不要输出寒暄。
5. 用中文输出。

输出格式：

[run_shell_command 压缩摘要]

- 命令结论:
- 关键错误/警告:
- 测试/构建结果:
- 相关文件和行号:
- 关键日志片段:
- 后续排查建议:

原始 run_shell_command 输出：

{tool_text}
""".strip()


def build_replace_prompt(tool_name: str, tool_text: str) -> str:
    return f"""
你是一个代码编辑 Agent 的 replace 工具输出压缩器。

你的任务是压缩代码替换工具的输出，让后续 Agent 知道替换是否成功、改了什么、是否存在失败或风险。

工具名称：
{tool_name}

长度要求：
1. 默认控制在 800 字符以内。
2. 只保留替换结果、修改文件、失败原因和必要风险。
3. 不要复述大段代码。

请重点保留：
1. 替换是否成功。
2. 被修改的文件路径。
3. 替换命中的位置、行号或片段。
4. 替换失败原因。
5. 如果没有命中，需要明确说明。
6. 如果出现格式、权限、冲突、文件不存在等问题，需要保留。

严格要求：
1. 不要引入原文没有的新事实。
2. 不要回答用户问题。
3. 不要输出寒暄。
4. 用中文输出。

输出格式：

[replace 压缩摘要]

- 替换结论:
- 修改文件:
- 关键变更:
- 失败/风险:
- 后续建议:

原始 replace 输出：

{tool_text}
""".strip()


def build_general_prompt(tool_name: str, tool_text: str) -> str:
    return f"""
你是一个代码编辑 Agent 的 AfterTool 工具输出压缩器。

你的任务是将一次工具调用结果压缩成后续 Agent 可以继续推理、编辑、调试的高价值上下文摘要。

工具名称：
{tool_name}

长度要求：
1. 默认控制在 1500 字符以内。
2. 如果内容明显和代码修改无关，可以更短。
3. 如果内容包含关键错误、关键路径、关键配置，可以适当保留更多细节。

请重点保留：
1. 和代码编辑、调试、文件理解相关的信息。
2. 文件路径、函数名、类名、变量名、配置项、命令、参数。
3. 报错信息、异常类型、堆栈关键帧、失败命令、失败原因。
4. 如果是代码内容，保留结构摘要和关键片段。
5. 如果是搜索结果，保留命中的文件、行号、关键内容。
6. 如果是命令输出，保留成功/失败结论、关键错误、测试结果。
7. 和后续修改决策有关的信息。

严格要求：
1. 不要引入原文没有的新事实。
2. 不要猜测不存在的原因。
3. 不要回答用户问题。
4. 不要输出寒暄。
5. 用中文输出。

输出格式：

[工具输出压缩摘要]

- 工具名称:
- 原始内容类型:
- 核心结论:
- 关键路径/符号:
- 关键细节:
- 错误/风险:
- 后续建议:

原始工具输出：

{tool_text}
""".strip()


def build_prompt(tool_name: str, tool_text: str) -> str:
    normalized = normalize_tool_name(tool_name)

    if normalized == "read_file":
        return build_read_file_prompt(normalized, tool_text)

    if normalized == "grep_search":
        return build_grep_search_prompt(normalized, tool_text)

    if normalized == "run_shell_command":
        return build_shell_prompt(normalized, tool_text)

    if normalized == "replace":
        return build_replace_prompt(normalized, tool_text)

    return build_general_prompt(normalized, tool_text)


def main():
    raw = sys.stdin.read()

    try:
        payload = json.loads(raw or "{}")
    except Exception:
        payload = {}

    tool_name = sanitize_text(payload.get("tool_name", "unknown_tool"))
    tool_name = normalize_tool_name(tool_name)
    tool_text = sanitize_text(payload.get("tool_text", ""))

    if not tool_text:
        print(json.dumps({
            "compressed": "",
            "reason": "empty_tool_text",
            "tool_name": tool_name,
            "raw_chars": 0,
            "compressed_chars": 0
        }, ensure_ascii=False))
        return

    try:
        from rlm import RLM
        import rlm

        log(f"using rlm from: {rlm.__file__}")
        log(f"compress start tool={tool_name}, raw_chars={len(tool_text)}")

        compress_prompt = build_prompt(tool_name, tool_text)
        compress_prompt = sanitize_text(compress_prompt)

        log(
            f"prompt built tool={tool_name}, "
            f"prompt_chars={len(compress_prompt)}"
        )

        # 本机安装的 RLM 不支持 zhipuai 后端,统一走 OpenAI 兼容协议:
        # 智谱 BigModel 的 OpenAI 兼容端点为 https://open.bigmodel.cn/api/paas/v4/。
        # 如需其他服务商/本地 vLLM,通过环境变量覆盖即可。
        backend = os.getenv("RLM_BACKEND", "openai")
        model_name = os.getenv("RLM_MODEL", "qwen3-8b")
        api_key = os.getenv("ZHIPUAI_API_KEY") or os.getenv("OPENAI_API_KEY")
        base_url = (
            os.getenv("ZHIPUAI_BASE_URL")
            or os.getenv("RLM_BASE_URL")
            or "https://open.bigmodel.cn/api/paas/v4/"
        )

        if not api_key:
            raise RuntimeError(
                "No LLM API key configured: set ZHIPUAI_API_KEY or OPENAI_API_KEY "
                "(or put it in a .env next to the hook / RLM package)."
            )

        log(
            f"rlm client config tool={tool_name}, backend={backend}, "
            f"model={model_name}, base_url={base_url}, api_key_set={bool(api_key)}"
        )

        rlm_client = RLM(
            backend=backend,
            backend_kwargs={
                "model_name": model_name,
                "api_key": api_key,
                "base_url": base_url,
            },
            environment="local",
            environment_kwargs={},
            max_depth=1,
            max_iterations=1,
            compaction=True,
            compaction_threshold_pct=COMPACTION_THRESHOLD_PCT,
            verbose=False,
            logger=None,
        )

        result = rlm_client.completion(compress_prompt)
        log("after rlm.completion")

        compressed = getattr(result, "response", None)
        if compressed is None:
            compressed = getattr(result, "content", None)
        if compressed is None:
            compressed = str(result)

        compressed = sanitize_text(compressed)

        log(
            f"compressed tool={tool_name}, "
            f"raw={len(tool_text)}, "
            f"compressed={len(compressed)}"
        )

        print(json.dumps({
            "compressed": compressed,
            "reason": "compressed",
            "tool_name": tool_name,
            "raw_chars": len(tool_text),
            "compressed_chars": len(compressed)
        }, ensure_ascii=False))

    except Exception as e:
        err = traceback.format_exc()

        log(
            f"compress failed tool={tool_name}: {repr(e)}\n"
            f"{err}"
        )

        print(json.dumps({
            "compressed": "",
            "reason": "compress_failed",
            "tool_name": tool_name,
            "error": repr(e),
            "traceback": err,
            "raw_chars": len(tool_text),
            "compressed_chars": 0
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
