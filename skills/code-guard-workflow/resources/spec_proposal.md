# Spec Proposal Workflow

Produce a specification change proposal from contract ambiguity.

## Contract

1. Extract the spec contract once (`scripts/spec_read_file.py <spec> --contract`).
2. List what is explicitly specified (endpoints, fields, codes, thresholds).
3. List what is mentioned but undefined (algorithms, formats, policies).

## Proposal

1. For each ambiguity, propose a concrete default with rationale, or mark it as
   "must confirm with the requirement owner".
2. Keep proposals minimal and consistent with the existing spec sections.
3. If the proposal affects implementation, name the target files and the
   expected behavioral delta.

## Output

Return the proposal in the reply: background, decision table, changed sections,
open questions. Do not write a proposal file into the repository unless the user
explicitly asks to save it.
