# Bug Investigation Workflow

Locate the root cause of a reported defect with bounded evidence.

## Investigate

1. Extract the failure: observed vs expected behavior, affected entry point,
   error text or failing test.
2. Search the exact failure terms or symbols and read the smallest relevant
   region with `scripts/read_file_slice.py` or `scripts/smart_read_file.py`.
3. Follow the data/call path only as far as needed: entry -> service -> cache ->
   data layer. Stop when the root cause is found.
4. Check stateful suspects: cache invalidation, TTL/expiry, stale reads, shared
   object mutation, error swallowing, ordering.

## Validate

- Confirm the root cause with a concrete trigger sequence.
- Identify the impact scope: which modules and requests are affected.

## Output

Return: root cause (file + logic), trigger conditions, impact scope, and a
minimal fix recommendation. Name files and symbols; do not write analysis files
unless the user asks to save them.
