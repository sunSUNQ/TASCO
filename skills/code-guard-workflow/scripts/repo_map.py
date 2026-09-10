# -*- coding: utf-8 -*-
"""Generate a bounded, compact repository structure map."""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

IGNORE_DIRS = {
    ".git", ".hg", ".svn", ".idea", ".vscode", "__pycache__",
    "node_modules", "vendor", "third_party", "external", "build",
    "dist", "out", "target", ".gradle", "bin", "obj", "tmp", "temp",
}
IGNORE_SUFFIXES = {
    ".pyc", ".class", ".o", ".obj", ".so", ".dll", ".exe", ".a",
    ".zip", ".gz", ".7z", ".png", ".jpg", ".gif", ".pdf", ".log",
}
IMPORTANT_NAMES = {
    "readme.md", "requirements.txt", "pyproject.toml", "package.json",
    "go.mod", "cargo.toml", "pom.xml", "build.gradle", "cmakelists.txt",
    "makefile", "dockerfile", "tsconfig.json",
}
SOURCE_DIRS = {"src", "source", "include", "lib", "modules", "test", "tests", "tools"}


def safe_rel(path, root):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def normalize_focus(values):
    output = []
    for value in values or []:
        for part in str(value).replace(",", " ").replace("|", " ").split():
            part = part.lower().strip()
            if len(part) >= 3 and part not in output:
                output.append(part)
    return output[:30]


def visible_entries(directory, extra_ignore, hide_tests, hide_third_party):
    output, ignored = [], 0
    try:
        entries = sorted(directory.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
    except OSError:
        return output, ignored
    for entry in entries:
        name = entry.name.lower()
        if entry.is_dir():
            blocked = name in IGNORE_DIRS or name in extra_ignore or name.startswith(".")
            blocked |= hide_tests and name in {"test", "tests", "ut", "spec", "specs"}
            blocked |= hide_third_party and name in {"third_party", "vendor", "external", "node_modules", "venv", ".venv"}
        else:
            blocked = entry.suffix.lower() in IGNORE_SUFFIXES or name.endswith((".min.js", ".bundle.js"))
            blocked |= hide_tests and (name.startswith("test_") or "_test." in name)
        if blocked:
            ignored += 1
        else:
            output.append(entry)
    return output, ignored


class BoundedWriter:
    def __init__(self, max_chars):
        self.max_chars = max_chars
        self.parts = []
        self.size = 0
        self.truncated = False

    def write(self, text=""):
        if self.truncated:
            return
        line = str(text) + "\n"
        if self.size + len(line) > self.max_chars:
            self.parts.append("...[REPO_MAP_TRUNCATED]\n")
            self.truncated = True
            return
        self.parts.append(line)
        self.size += len(line)

    def value(self):
        return "".join(self.parts).rstrip()


def scan(root, max_depth, extra_ignore, focus, hide_tests, hide_third_party):
    stack = [(root, 0)]
    dirs = files = 0
    extensions = Counter()
    important, focus_hits, candidate_dirs = [], [], []
    while stack:
        directory, depth = stack.pop()
        if depth > max_depth:
            continue
        dirs += 1
        entries, _ = visible_entries(directory, extra_ignore, hide_tests, hide_third_party)
        for entry in entries:
            relative = safe_rel(entry, root)
            lower = relative.lower()
            if entry.is_dir():
                if entry.name.lower() in SOURCE_DIRS:
                    candidate_dirs.append(relative + "/")
                if any(term in lower for term in focus):
                    focus_hits.append(relative + "/")
                if depth < max_depth:
                    stack.append((entry, depth + 1))
            else:
                files += 1
                extensions[entry.suffix.lower() or "[no_ext]"] += 1
                if entry.name.lower() in IMPORTANT_NAMES:
                    important.append(relative)
                if any(term in lower for term in focus):
                    focus_hits.append(relative)
    return dirs, files, extensions, important[:40], focus_hits[:80], candidate_dirs[:40]


def render_tree(root, writer, max_depth, max_items, extra_ignore, hide_tests, hide_third_party):
    def walk(directory, depth, prefix):
        if depth > max_depth or writer.truncated:
            return
        entries, ignored = visible_entries(directory, extra_ignore, hide_tests, hide_third_party)
        shown = entries[:max_items]
        for index, entry in enumerate(shown):
            last = index == len(shown) - 1 and len(entries) == len(shown)
            branch = "└── " if last else "├── "
            writer.write(f"{prefix}{branch}{entry.name}{'/' if entry.is_dir() else ''}")
            if entry.is_dir() and depth < max_depth:
                walk(entry, depth + 1, prefix + ("    " if last else "│   "))
        omitted = len(entries) - len(shown)
        if omitted or ignored:
            writer.write(f"{prefix}└── ...[omitted={omitted}, ignored={ignored}]")
    writer.write(f"{root.name}/")
    walk(root, 0, "")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root")
    parser.add_argument("--max-depth", type=int, default=2)
    parser.add_argument("--max-files-per-dir", type=int, default=8)
    parser.add_argument("--max-chars", type=int, default=5000)
    parser.add_argument("--max-items", type=int, default=80)
    parser.add_argument("--hide-tests", action="store_true")
    parser.add_argument("--hide-third-party", action="store_true")
    parser.add_argument("--ignore-dir", action="append", default=[])
    parser.add_argument("--focus", action="append", default=[])
    return parser.parse_args()


def main():
    args = parse_args()
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        print(f"[REPO_MAP_ERROR]\nreason: root is not a directory\nroot: {root}")
        return 2
    focus = normalize_focus(args.focus)
    extra_ignore = {item.lower() for item in args.ignore_dir}
    depth = max(0, args.max_depth)
    per_dir = max(1, args.max_files_per_dir)
    writer = BoundedWriter(max(1000, args.max_chars))
    stats = scan(root, depth, extra_ignore, focus, args.hide_tests, args.hide_third_party)
    dirs, files, extensions, important, hits, candidates = stats
    writer.write("[REPO_MAP_READY]")
    writer.write("tool: repo_map.py")
    writer.write(f"root: {root}")
    writer.write(f"dirs_scanned: {dirs}")
    writer.write(f"files_seen: {files}")
    writer.write("top_file_exts: " + ", ".join(f"{ext}:{count}" for ext, count in extensions.most_common(12)))
    writer.write("\n## Focus Entry Points")
    for item in (hits or important or candidates)[:20]:
        writer.write(f"- {item}")
    writer.write("\n## Compact Tree")
    render_tree(root, writer, depth, per_dir, extra_ignore, args.hide_tests, args.hide_third_party)
    print(writer.value())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
