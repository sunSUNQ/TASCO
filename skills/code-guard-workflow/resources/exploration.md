# Exploration Workflow

Bounded orientation when the target is unknown.

## Orientation

1. Use `scripts/repo_map.py <repo>` for an initial structure summary (one call).
2. Read top-level docs and build config in bounded slices when their shape
   matters.

## Search

1. Prefer exact searches: filenames, symbols, API names, error strings.
2. Use `glob` for known patterns and `grep` for exact terms; limit roots and
   file types when known.
3. Read matches with `scripts/read_file_slice.py` or
   `scripts/smart_read_file.py` instead of full files.

## Stop

- Stop when the target files are identified.
- Do not dump directory trees or repeat the same search.
- Do not continue searching only for completeness.
