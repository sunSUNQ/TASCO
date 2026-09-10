# Mutation / Spec-to-Code Workflow

Implement or modify a known target from a specification.

## Contract

1. Read the spec contract once (`scripts/spec_read_file.py <spec> --contract`).
2. Read the current target implementation and its tests with bounded reads.

## Edit

1. Make the smallest coherent change.
2. Prefer `scripts/safe_replace.py` for deterministic replacements with explicit
   old/new content.
3. Read back the modified region after editing.

## Validation

1. Run the narrowest test or parse check covering the change.
2. Once it passes, stop; do not re-run the same checks or re-read the same files
   to "confirm" the result.
3. Broaden validation only when the change affects shared interfaces.

Report the implemented requirements, validation commands and outcomes, and any
unresolved contract ambiguity.
