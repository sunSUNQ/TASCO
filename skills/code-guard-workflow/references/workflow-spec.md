# Workflow specification

## Evidence ladder

Use the first sufficient level:

1. Known error, filename, symbol, test name, or requirement term.
2. Exact repository search for that evidence.
3. Bounded read around matching lines or symbol definitions.
4. Direct dependency or caller read when needed to interpret the target.
5. Shallow module listing or repository map when no target is known.
6. Broader investigation only after recording why lower levels were insufficient.

Fast path: when the prompt already names the exact file(s) and the question is
directly answerable from one bounded read, start at level 1-3 immediately and
skip levels 5-6 (no repository map, no directory listing, no helper warm-up).
Escalate only when that read cannot answer the question.

## Read discipline

- Prefer a line range, symbol, or query over a full-file read.
- Read configuration and small documentation files directly when their full shape matters.
- Avoid rereading identical ranges unless the file changed.
- After editing, reread the modified region rather than the whole file.
- For large specifications, retain a requirement contract and fetch only cited evidence later.

## Search discipline

- Use exact error strings, identifiers, filenames, API names, and requirement vocabulary.
- Limit search roots and file types when known.
- Avoid recursive directory dumps and generic searches such as `config`, `handler`, or `error` without context.
- If results are large, refine the pattern before opening files.

## Edit readiness

Edit when all are true:

- The requested behavior is understood.
- The target file and local implementation region are known.
- Relevant interfaces or tests have been inspected.
- The edit can be stated as a concrete behavioral delta.

If any item is missing, collect only that missing evidence.

## Validation ladder

1. Parse, syntax, or compile check for the changed file.
2. Focused test covering the changed behavior.
3. Related module test when a shared interface changed.
4. Broader suite only when risk justifies its cost.

Report commands and outcomes. Distinguish failures caused by the change from environment failures.

## Output discipline

- Summarize findings instead of returning raw directory trees or long tool output.
- Name the relevant files and symbols.
- State uncertainty and the next evidence needed.
- Archive large raw output only when reproducibility requires it.

## Recovery

- When replacement text is not found, reread the current target region before retrying.
- When a test fails unexpectedly, inspect the first actionable failure rather than rerunning repeatedly.
- When repository scope is ambiguous, stop before writing and resolve the intended root.
- When an operation may be destructive or irreversible, require explicit user authority.
