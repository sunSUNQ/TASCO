# Gap Analysis Workflow

Classify spec requirements against implementation.

## Analysis

1. Extract the spec contract once (`scripts/spec_read_file.py <spec> --contract`).
2. For each requirement, collect evidence with exact searches and bounded reads
   (see traceability evidence rules).
3. Classify each requirement:
   - implemented: behavior exists and matches the spec;
   - partial: exists but misses constraints (validation, error handling, edge cases);
   - missing: no implementation or no reachable path.
4. For partial/missing, record the concrete gap: expected behavior vs observed
   behavior, with file/symbol evidence.

## Validation

- Check error/edge requirements separately (validation, limits, failure paths);
  a happy path without guards counts as partial.
- Cross-check related modules before declaring a gap (the behavior may live in a
  shared helper).

## Output

Return:

| Requirement | Status | Evidence | Gap detail |

Name files/symbols; distinguish "missing" from "not found yet" and say what
evidence would resolve it. Do not write the analysis to a file unless asked.
