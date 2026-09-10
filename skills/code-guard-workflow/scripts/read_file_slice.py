"""Read a bounded line range from a file with a small persistent cache."""

import json
import os
import sys
import time
from pathlib import Path

MAX_LINES = 100
# 缓存跟随治理体系的状态根 CODE_GUARD_BASE_DIR；未设置时回退到用户级 ~/.cac。
CACHE_FILE = (
    Path(os.environ.get("CODE_GUARD_BASE_DIR") or str(Path.home() / ".cac"))
    / "read_slice_cache.json"
)
CACHE_TTL_SEC = 10 * 60
MAX_CACHE_ENTRIES = 50
REPO_MARKERS = (".git", "WORKSPACE", "BUILD", "BUILD.bazel", "CMakeLists.txt")


def _load_cache():
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8")) if CACHE_FILE.exists() else {}
    except Exception:
        return {}


def _save_cache(cache):
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        tmp.replace(CACHE_FILE)
    except Exception:
        pass


def _normalize_path(value):
    try:
        return str(Path(value).resolve()).replace("\\", "/").lower()
    except Exception:
        return str(value).replace("\\", "/").lower()


def _prune_cache(cache):
    now = time.time()
    cache = {
        key: value for key, value in cache.items()
        if 0 <= now - float(value.get("cached_at", 0)) <= CACHE_TTL_SEC
    }
    if len(cache) > MAX_CACHE_ENTRIES:
        ordered = sorted(cache, key=lambda key: cache[key].get("cached_at", 0))
        for key in ordered[: len(cache) - MAX_CACHE_ENTRIES]:
            del cache[key]
    return cache


def _check_cache(file_path, start, end):
    cache = _prune_cache(_load_cache())
    normalized = _normalize_path(file_path)
    for entry in cache.values():
        if entry.get("file") != normalized:
            continue
        cached_start = int(entry.get("start_line", 0))
        cached_end = int(entry.get("end_line", 0))
        if cached_start <= start and cached_end >= end:
            lines = str(entry.get("content", "")).split("\n")
            left = start - cached_start
            right = end - cached_start + 1
            return lines[left:right]
    _save_cache(cache)
    return None


def _store_cache(file_path, start, end, lines):
    cache = _prune_cache(_load_cache())
    key = f"{_normalize_path(file_path)}:{start}-{end}"
    cache[key] = {
        "file": _normalize_path(file_path),
        "start_line": start,
        "end_line": end,
        "content": "\n".join(lines),
        "cached_at": time.time(),
    }
    _save_cache(_prune_cache(cache))


def normalize_input_path(raw_path):
    value = str(raw_path or "").strip().strip("\"'")
    value = value.replace("\ufeff", "").replace("\u200b", "")
    value = os.path.expandvars(os.path.expanduser(value))
    path = Path(value)
    return (Path.cwd() / path).resolve() if not path.is_absolute() else path.resolve()


def _repo_root(start):
    current = start if start.is_dir() else start.parent
    for parent in (current, *current.parents):
        if any((parent / marker).exists() for marker in REPO_MARKERS):
            return parent
    return Path.cwd()


def find_existing_file_fallback(file_path, repo_root):
    if file_path.exists():
        return file_path, "exact"
    if file_path.parent.exists():
        matches = [p for p in file_path.parent.iterdir() if p.is_file() and p.name.lower() == file_path.name.lower()]
        if len(matches) == 1:
            return matches[0], "case_insensitive_parent"
    matches = []
    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
        matches.extend(Path(root) / name for name in files if name.lower() == file_path.name.lower())
        if len(matches) > 10:
            break
    return (matches[0], "basename_unique") if len(matches) == 1 else (None, "not_found")


def print_result(file_path, start, end, total, lines, cache_hit=False):
    print("[READ_FILE_SLICE_RESULT]")
    print("tool: read_file_slice.py")
    print("status: success")
    print(f"file: {file_path}")
    print(f"range: L{start}-L{end}")
    print(f"total_lines: {total}")
    if cache_hit:
        print("[cache: hit]")
    print()
    for number, line in enumerate(lines, start):
        print(f"{number:>4}: {line}")


def fail(reason, file_path=""):
    print("[READ_FILE_SLICE_RESULT]")
    print("tool: read_file_slice.py")
    print("status: failed")
    print(f"reason: {reason}")
    if file_path:
        print(f"file: {file_path}")
    raise SystemExit(1)


def parse_args(argv):
    if len(argv) < 4:
        fail("usage: read_file_slice.py <file> <start> <end> [--repo-root <path>]")
    file_path = argv[1]
    rest = argv[2:]
    repo_root = None
    if "--repo-root" in rest:
        index = rest.index("--repo-root")
        repo_root = rest[index + 1]
        del rest[index:index + 2]
    if rest[0] in ("--start-line", "--startLine"):
        start = rest[1]
        end_flag = "--end-line" if "--end-line" in rest else "--endLine"
        end = rest[rest.index(end_flag) + 1]
    else:
        start, end = rest[:2]
    return file_path, int(str(start).lstrip("Ll")), int(str(end).lstrip("Ll")), repo_root


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raw_path, start, end, root_arg = parse_args(sys.argv)
    requested = normalize_input_path(raw_path)
    root = normalize_input_path(root_arg) if root_arg else _repo_root(requested)
    file_path, resolution = find_existing_file_fallback(requested, root)
    if not file_path:
        fail("file does not exist after fallback search", str(requested))
    start = max(1, start)
    end = min(start + MAX_LINES - 1, end)
    if end < start:
        fail("end_line is smaller than start_line", str(file_path))
    cached = _check_cache(file_path, start, end)
    if cached is not None:
        print_result(file_path, start, end, end, cached, True)
        return
    lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
    if start > len(lines):
        fail("start_line exceeds file length", str(file_path))
    end = min(end, len(lines))
    selected = lines[start - 1:end]
    _store_cache(file_path, start, end, selected)
    if resolution != "exact":
        print(f"path_resolution: {resolution}")
    print_result(file_path, start, end, len(lines), selected)


if __name__ == "__main__":
    main()
