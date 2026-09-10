"""Apply one controlled text replacement described by a JSON file."""

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

MAX_DIFF_LINES = 120


def build_limited_diff(file_path, before, after):
    diff = list(difflib.unified_diff(
        before.splitlines(), after.splitlines(),
        fromfile=f"a/{file_path.name}", tofile=f"b/{file_path.name}",
        lineterm="", n=3,
    ))
    return diff if len(diff) <= MAX_DIFF_LINES else diff[:60] + ["...[diff truncated]..."] + diff[-40:]


def compact(text):
    return "\n".join(line.strip() for line in str(text).splitlines() if line.strip())


def clamp_text(text, max_chars=1200):
    text = str(text or "")
    return text if len(text) <= max_chars else text[:max_chars] + "\n...[CANDIDATE_TEXT_TRUNCATED]..."


def fuzzy_find(text, pattern):
    target = compact(pattern)
    lines = text.splitlines(keepends=True)
    expected = max(1, len(pattern.splitlines()))
    for start in range(len(lines)):
        buffer = ""
        for end in range(start, min(len(lines), start + max(expected + 5, 80))):
            buffer += lines[end]
            if compact(buffer) == target:
                return buffer
            if len(buffer) > max(100, len(pattern) * 2):
                break
    return None


def compact_for_match(text):
    text = re.sub(r"/\*.*?\*/", "", str(text), flags=re.S)
    text = re.sub(r"//.*", "", text)
    return re.sub(r"\s+", "", text)


def find_similar_blocks(text, old_string, max_blocks=3):
    lines = text.splitlines()
    expected = max(3, len(old_string.splitlines()))
    target = compact_for_match(old_string)
    results = []
    for size in range(max(1, expected - 2), expected + 3):
        for start in range(max(0, len(lines) - size + 1)):
            block = "\n".join(lines[start:start + size])
            candidate = compact_for_match(block)
            if not target or not candidate:
                continue
            score = difflib.SequenceMatcher(None, target, candidate).ratio()
            if score >= 0.55:
                results.append((score, start + 1, start + size, block))
    results.sort(reverse=True)
    output, seen = [], set()
    for score, start, end, block in results:
        if (start, end) in seen:
            continue
        seen.add((start, end))
        output.append({"score": score, "start_line": start, "end_line": end, "text": block})
        if len(output) >= max_blocks:
            break
    return output


def print_header(file_path, status):
    print("[SAFE_REPLACE_RESULT]")
    print("tool: safe_replace.py")
    print(f"file: {file_path}")
    print(f"status: {status}")


def fail(file_path, reason, exit_code=1):
    print_header(file_path, "failed")
    print(f"reason: {reason}")
    raise SystemExit(exit_code)


def validate_new_string(new_string):
    suspicious = [
        r"\buint\d+_t\s*,", r"\bint\d*_t\s*,", r"\bchar\s*,",
        r"\bstruct\s+\w+\s*,", r"\.\w+\s*,\s*=", r"\bif\s*\(\s*\)",
        r"\bfor\s*\(\s*;\s*;\s*\)", r"==\s+=",
    ]
    return next((pattern for pattern in suspicious if re.search(pattern, new_string)), None)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("replace_json")
    args = parser.parse_args()
    json_path = Path(args.replace_json).resolve()
    if not json_path.exists():
        fail(json_path, "replace json not found")
    try:
        data = json.loads(json_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        fail(json_path, f"invalid json: {exc}")
    file_path = Path(data.get("file_path", "")).resolve()
    old_string = str(data.get("old_string", ""))
    new_string = str(data.get("new_string", ""))
    instruction = str(data.get("instruction", ""))
    if not file_path.exists():
        fail(file_path, "file not found")
    if not old_string:
        fail(file_path, "old_string is empty")
    if not new_string and not data.get("allow_empty_new_string", False):
        fail(file_path, "empty new_string requires allow_empty_new_string=true")
    text = file_path.read_text(encoding="utf-8-sig", errors="replace")
    count = text.count(old_string)
    matched = old_string
    mode = "exact_match"
    if count == 0:
        matched = fuzzy_find(text, old_string)
        mode = "fuzzy_whitespace_match"
        if not matched:
            print_header(file_path, "failed")
            print("reason: old_string not found")
            for index, item in enumerate(find_similar_blocks(text, old_string), 1):
                print(f"candidate_{index}: lines={item['start_line']}-{item['end_line']} score={item['score']:.3f}")
                print(clamp_text(item["text"]))
            raise SystemExit(1)
    elif count > 1:
        fail(file_path, f"old_string matched multiple times: {count}")
    bad_pattern = validate_new_string(new_string)
    if bad_pattern:
        fail(file_path, f"suspicious generated syntax: {bad_pattern}")
    start_index = text.find(matched)
    start_line = text[:start_index].count("\n") + 1
    old_lines = max(1, matched.count("\n") + 1)
    new_lines = max(1, new_string.count("\n") + 1)
    after = text.replace(matched, new_string, 1)
    diff = build_limited_diff(file_path, text, after)
    file_path.write_text(after, encoding="utf-8")
    print_header(file_path, "success")
    print(f"mode: {mode}")
    print(f"instruction: {instruction}")
    print(f"changed_lines: {start_line}-{start_line + max(old_lines, new_lines) - 1}")
    print("```diff")
    print("\n".join(diff))
    print("```")


if __name__ == "__main__":
    main()
