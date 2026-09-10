"""Build a compact Markdown index or a navigation contract for spec-to-code work."""

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

def _session_subdir_from_query(query_file):
    """从 hook 写入的 query-file 路径推断会话子目录。
    query-file 位于 <root>/.code-guard/<session>/tmp/ 下。"""
    try:
        parts = Path(query_file).resolve().parts
        for i, part in enumerate(parts):
            if part.lower() == ".code-guard" and i + 1 < len(parts):
                return parts[i + 1]
    except Exception:
        pass
    return ""


def _runtime_root():
    env_base = os.environ.get("CODE_GUARD_BASE_DIR")
    return Path(env_base) if env_base else Path.cwd() / ".code-guard"


ACTIVE_CONTRACT_FILE = None  # 在 main() 中按会话目录解析

SPEC_IMPLEMENTATION_RULES = """SPEC_IMPLEMENTATION_RULES:
Function or interface existence does not prove spec compliance.
Verify every requirement against concrete production-code evidence.
Use: Requirement | Code Evidence | Status.
Status: Satisfied / Partially Satisfied / Needs Modification / Not Verified.
Do not claim no changes are needed unless every requirement is directly verified.
TODO, mock, stub, placeholder, empty implementation, or direct success return is not sufficient evidence.
The spec contract is navigation guidance, not standalone implementation evidence."""


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()


def read_text_safely(file_path):
    for encoding in ("utf-8", "utf-8-sig", "gbk", "gb18030"):
        try:
            return file_path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return file_path.read_text(encoding="utf-8", errors="ignore")


def load_query(query_file):
    path = Path(query_file) if query_file else None
    return path.read_text(encoding="utf-8", errors="replace")[:2000] if path and path.exists() else ""


def split_sections(text):
    lines = text.splitlines()
    sections = []
    current = {"title": "DOC_START", "level": 0, "start_line": 1, "lines": [], "heading_path": ["DOC_START"]}
    stack = []
    for number, line in enumerate(lines, 1):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match:
            if current["lines"]:
                current["end_line"] = number - 1
                sections.append(current)
            level, title = len(match.group(1)), match.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            current = {
                "title": title, "level": level, "start_line": number,
                "lines": [line], "heading_path": [item[1] for item in stack],
            }
        else:
            current["lines"].append(line)
    if current["lines"]:
        current["end_line"] = len(lines)
        sections.append(current)
    return sections


def keywords(text):
    stop = {"the", "and", "for", "with", "from", "this", "that", "代码", "文件", "分析", "实现"}
    output = []
    for item in re.findall(r"[A-Za-z_]\w*|[\u4e00-\u9fff]{2,}", text or ""):
        if item.lower() not in stop and item not in output:
            output.append(item)
    return output[:40]


def summarize(content, max_chars=220):
    useful = []
    for line in content.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        lower = line.lower()
        if line and (line.startswith(("- ", "* ")) or any(word in lower for word in ("must", "should", "required", "return", "error", "必须", "接口", "参数", "约束"))):
            useful.append(line)
        if len("；".join(useful)) >= max_chars:
            break
    return ("；".join(useful) or re.sub(r"\s+", " ", content).strip())[:max_chars]


def build_index(file_path, text, query, max_slice_lines):
    query_terms = [item.lower() for item in keywords(query)]
    chunks = []
    for index, section in enumerate(split_sections(text), 1):
        content = "\n".join(section["lines"])
        haystack = (section["title"] + "\n" + content).lower()
        score = sum(10 if term in section["title"].lower() else 2 if term in haystack else 0 for term in query_terms)
        start, end = section["start_line"], section["end_line"]
        chunks.append({
            "chunk_id": f"chunk_{index:03d}", "title": section["title"],
            "heading_path": section["heading_path"], "start_line": start,
            "end_line": end, "slice_start": start,
            "slice_end": min(end, start + max_slice_lines - 1),
            "chars": len(content), "score": score, "summary": summarize(content),
        })
    return {"file": str(file_path), "sha256": sha256_text(text), "chunks": chunks}


def related_chunks(index, top_k):
    chunks = index["chunks"]
    ranked = sorted(chunks, key=lambda item: (item["score"], -item["start_line"]), reverse=True)
    chosen = [item for item in ranked if item["score"] > 0][:top_k] or chunks[:top_k]
    return sorted(chosen, key=lambda item: item["start_line"])


def cache_key(file_path, query, mode, max_lines, top_k):
    stat = file_path.stat()
    raw = f"{file_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|{sha256_text(query)}|{mode}|{max_lines}|{top_k}|4"
    return sha256_text(raw)[:32]


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def build_contract(file_path, index, query, top_k):
    chosen = related_chunks(index, top_k)
    contract_text = "\n".join(f"{item['title']}: {item['summary']}" for item in chosen)[:1600]
    symbols = []
    for item in chosen:
        for symbol in re.findall(r"\b[A-Za-z_]\w{2,}\b", item["title"] + " " + item["summary"]):
            if ("_" in symbol or re.search(r"[a-z][A-Z]", symbol)) and symbol not in symbols:
                symbols.append(symbol)
    # 禁止读取缓存目录：保留旧布局兼容条目，并动态追加当前运行时根
    # （跟随 CODE_GUARD_BASE_DIR，未设置时为 <cwd>/.code-guard）。
    forbidden = [
        ".cac/spec_cache",
        ".cac\\spec_cache",
        ".code-guard/spec_cache",
        ".code-guard\\spec_cache",
    ]
    runtime_spec_cache = str(_runtime_root() / "spec_cache").replace("\\", "/")
    if runtime_spec_cache not in forbidden:
        forbidden.append(runtime_spec_cache)
    return {
        "task_mode": "spec_to_code", "source_spec": str(file_path),
        "contract_text": contract_text + "\n\n" + SPEC_IMPLEMENTATION_RULES,
        "spec_implementation_rules": SPEC_IMPLEMENTATION_RULES,
        "target_domains": [], "target_symbols": [],
        "candidate_symbols": symbols[:40], "required_keywords": keywords(query)[:40],
        "forbidden_paths": forbidden,
        "read_policy": {"max_slice_lines": 80, "max_total_read_chars": 20000},
    }


def print_index(file_path, text, index, cache_file, top_k):
    print("[SPEC_INDEX_COMPACT]")
    print(f"file: {file_path}\nchars: {len(text)}\nsections: {len(index['chunks'])}\ncache_index: {cache_file}")
    print("\nNote: full document parsed; only compact navigation is shown.")
    helper = Path(__file__).with_name("read_file_slice.py")
    for number, item in enumerate(related_chunks(index, top_k), 1):
        print(f"\n{number}. {item['chunk_id']} {item['title']}")
        print(f"   lines: {item['start_line']}-{item['end_line']}")
        print(f"   suggest_slice: {item['slice_start']}-{item['slice_end']}")
        print(f"   summary: {item['summary']}")
        print(f'   command: python "{helper}" "{file_path}" {item["slice_start"]} {item["slice_end"]}')


def print_contract(contract, active_contract_file):
    print("[SPEC_CONTRACT_READY]")
    print("phase_hint: focus")
    print(f"contract_file: {active_contract_file}")
    print(f"source_spec: {contract['source_spec']}")
    print("\ncontract_text:")
    print(contract["contract_text"][:1800])
    print("\ncandidate_symbols:")
    print(", ".join(contract["candidate_symbols"]) or "none")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file_path")
    parser.add_argument("--query-file", default="")
    parser.add_argument("--top-k", type=int, default=4)
    parser.add_argument("--max-slice-lines", type=int, default=80)
    parser.add_argument("--contract", action="store_true")
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args()
    file_path = Path(args.file_path).resolve()
    if not file_path.exists():
        print(f"[SPEC_READ_ERROR] file not found: {file_path}")
        return 1
    query = load_query(args.query_file)
    mode = "contract" if args.contract else "compact"
    # 会话目录:优先从 query-file 推断;否则根目录。
    session_sub = _session_subdir_from_query(args.query_file)
    root = _runtime_root()
    session_root = root / session_sub if session_sub else root
    cache_dir = session_root / "spec_cache"
    contract_dir = session_root / "task_contracts"
    active_contract_file = contract_dir / "active_contract.json"
    ACTIVE_CONTRACT_FILE = active_contract_file
    cache_file = cache_dir / f"{cache_key(file_path, query, mode, args.max_slice_lines, args.top_k)}.{mode}.json"
    text = read_text_safely(file_path)
    index = build_index(file_path, text, query, args.max_slice_lines)
    if args.contract:
        contract = build_contract(file_path, index, query, args.top_k)
        save_json(active_contract_file, contract)
        save_json(cache_file, {"contract": contract, "index": index, "text_chars": len(text)})
        print_contract(contract, active_contract_file)
    else:
        save_json(cache_file, {"index": index, "text_chars": len(text)})
        print_index(file_path, text, index, cache_file, args.top_k)
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    os.environ["PYTHONIOENCODING"] = "utf-8"
    raise SystemExit(main())
