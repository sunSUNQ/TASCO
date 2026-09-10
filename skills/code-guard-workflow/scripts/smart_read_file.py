"""Produce a compact symbol index and bounded slice suggestions for a file."""

import argparse
import ast
import re
import sys
from pathlib import Path

MAX_OUTPUT_CHARS = 2000
MAX_TARGETS = 4


class SymbolInfo:
    def __init__(self, name, kind, lineno, end_lineno, parent=None):
        self.name = name
        self.kind = kind
        self.lineno = lineno
        self.end_lineno = end_lineno
        self.parent = parent

    @property
    def full_name(self):
        return f"{self.parent}.{self.name}" if self.parent else self.name


def read_text(path):
    return path.read_text(encoding="utf-8", errors="replace")


def limit_output(text):
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[: MAX_OUTPUT_CHARS - 180] + f"\n...[SMART_READ_OUTPUT_TRUNCATED]...\nraw_output_chars: {len(text)}"


def extract_identifiers(text):
    stop = {"python", "file", "path", "read", "source", "result", "return", "class", "import", "from"}
    output = []
    for item in re.findall(r"\b[A-Za-z_][A-Za-z0-9_]{2,}\b", text or ""):
        if item.lower() not in stop and item not in output:
            output.append(item)
    return output


def collect_python_symbols(text):
    symbols, errors = [], []
    try:
        tree = ast.parse(text)
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                symbols.append(SymbolInfo(node.name, "class", node.lineno, node.end_lineno or node.lineno))
                for child in node.body:
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        symbols.append(SymbolInfo(child.name, "method", child.lineno, child.end_lineno or child.lineno, node.name))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                symbols.append(SymbolInfo(node.name, "function", node.lineno, node.end_lineno or node.lineno))
    except Exception as exc:
        errors.append(f"AST parse failed: {exc!r}")
    return symbols, errors


def collect_c_like_symbols(text):
    symbols = []
    function_re = re.compile(r"^\s*(?:static\s+|inline\s+|extern\s+)*(?:[\w*]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?")
    type_re = re.compile(r"^\s*(?:typedef\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)")
    lines = text.splitlines()
    for number, line in enumerate(lines, 1):
        match = function_re.match(line)
        if match and match.group(1) not in {"if", "for", "while", "switch"}:
            symbols.append(SymbolInfo(match.group(1), "function", number, min(len(lines), number + 80)))
            continue
        match = type_re.match(line)
        if match:
            symbols.append(SymbolInfo(match.group(1), "type", number, min(len(lines), number + 40)))
    return symbols, []


def infer_targets(query, symbols):
    words = [word.lower() for word in extract_identifiers(query)]
    scored = []
    for symbol in symbols:
        name = symbol.name.lower()
        score = sum(10 if word == name else 3 if word in name or name in word else 0 for word in words)
        if score:
            scored.append((score, symbol.name))
    scored.sort(reverse=True)
    output = []
    for _, name in scored:
        if name not in output:
            output.append(name)
    return output[:MAX_TARGETS]


def slice_targets(file_path, symbols, targets, total_lines):
    matched = [symbol for symbol in symbols if symbol.name in targets]
    if not matched:
        matched = symbols[:2]
    rows = []
    for symbol in matched[:MAX_TARGETS]:
        start = max(1, symbol.lineno - 5)
        end = min(total_lines, max(symbol.lineno + 20, symbol.end_lineno + 5))
        rows.append(
            f"- symbol: {symbol.full_name}\n"
            f"  kind: {symbol.kind}\n"
            f"  suggested_range: {start}-{end}\n"
            f'  command: python "{Path(__file__).with_name("read_file_slice.py")}" "{file_path}" {start} {end}'
        )
    if not rows and total_lines:
        end = min(80, total_lines)
        rows.append(
            f"- symbol: file_header\n  kind: fallback_slice\n  suggested_range: 1-{end}\n"
            f'  command: python "{Path(__file__).with_name("read_file_slice.py")}" "{file_path}" 1 {end}'
        )
    return "\n".join(rows) or "none"


def summarize_text(file_path, text, query):
    lines = text.splitlines()
    keywords = [word.lower() for word in extract_identifiers(query)]
    hits = [(number, line) for number, line in enumerate(lines, 1) if any(word in line.lower() for word in keywords)]
    hits = hits[:MAX_TARGETS] or list(enumerate(lines[:1], 1))
    rows = []
    for number, _ in hits:
        start, end = max(1, number - 20), min(len(lines), number + 40)
        rows.append(f"- around_line_{number}: {start}-{end}")
    return "\n".join(rows) or "none"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file_path")
    parser.add_argument("--query", default="")
    parser.add_argument("--query-file", default="")
    parser.add_argument("--mode", choices=("explore", "focus", "edit"), default="focus")
    args = parser.parse_args()
    query = args.query
    if args.query_file and Path(args.query_file).exists():
        query = Path(args.query_file).read_text(encoding="utf-8", errors="replace")
    file_path = Path(args.file_path).resolve()
    if not file_path.exists():
        print(f"file does not exist: {file_path}")
        raise SystemExit(1)
    text = read_text(file_path)
    lines = text.splitlines()
    if file_path.suffix.lower() == ".py":
        symbols, errors = collect_python_symbols(text)
    elif file_path.suffix.lower() in {".c", ".cc", ".cpp", ".h", ".hpp", ".hh"}:
        symbols, errors = collect_c_like_symbols(text)
    else:
        symbols, errors = [], []
    targets = infer_targets(query, symbols)
    targets_text = slice_targets(file_path, symbols, targets, len(lines)) if symbols else summarize_text(file_path, text, query)
    output = (
        "[SMART_READ_RESULT]\n"
        "tool: smart_read_file.py\n"
        f"mode: {args.mode}\nfile: {file_path}\nsize_chars: {len(text)}\nlines: {len(lines)}\n"
        f"inferred_targets: {', '.join(targets) if targets else 'none'}\n"
        f"slice_targets:\n{targets_text}\n"
        f"errors: {'; '.join(errors) if errors else 'none'}\n"
        "relevant_snippets: [OMITTED_BY_DEFAULT]"
    )
    print(limit_output(output))


if __name__ == "__main__":
    main()
