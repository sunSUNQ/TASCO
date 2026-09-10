# Traceability Workflow

Map specification requirements to implementation evidence.

## Workflow

1. Extract a compact requirement contract from the specification
   (`scripts/spec_read_file.py <spec> --contract` once; do not reread the spec).
2. Locate the entry point: if the prompt names the entry, read it directly;
   otherwise use `scripts/repo_map.py <repo>` for orientation.
3. For each requirement, find the smallest implementation evidence:
   - search exact requirement terms, symbols, or filenames (`grep`/`glob`);
   - read the relevant region with `scripts/read_file_slice.py <file> <start> <end>`
     or `scripts/smart_read_file.py <file> --query <symbol>`.
4. Follow the call chain only as far as needed: entry -> handler -> service ->
   data layer. Stop when the requirement is covered.
5. Identify test coverage: does a test exercise the requirement path?

## Evidence

- Record file + line/symbol for each requirement.
- Mark status: fully covered / partially covered / no evidence / contradicting.
- Never list a whole directory tree or read a full file when a slice suffices.

## Output

Return a mapping table:

| Requirement | Entry point | Implementation | Status | Test gap |

Name the files and symbols explicitly; state uncertainty and the next evidence
needed. Do not write the mapping to a file unless the user asks to save it.
