---
name: code-guard-workflow
description: Activation-gated resource router for complex software engineering tasks. Load when a task needs repository exploration, multi-file reasoning, bug root cause, traceability, gap detection, or spec proposals. Do not load for single-file modifications, known-location changes, or simple test generation.
---

# Code Guard Workflow

Activation-gated resource router. Used for:

- bug investigation
- specification analysis
- traceability analysis
- gap detection
- spec proposal
- multi-file implementation planning

## Activation policy

Activate this skill only when the task needs:

- repository exploration or locating unknown targets;
- multi-file / cross-module reasoning (call chains, dependencies, impact scope);
- uncertainty that affects the answer (bug root cause, missing behavior, ambiguity).

Do NOT activate for:

- single-file modification at a known location;
- simple test generation or field additions;
- direct implementation where the target file is already known.

## Session telemetry markers

Record two telemetry markers per workflow run (one call each, fail-open —
never block the workflow on marker failures):

1. **Start (immediately after activation, before any repository work):**

   ```bash
   python scripts/session_marker.py start --skill code-guard-workflow --task "<task type, e.g. bug root cause>"
   ```

2. **End (at the stop condition, before returning the final answer):**

   ```bash
   python scripts/session_marker.py end --skill code-guard-workflow --task "<task type>" --outcome success|partial|failed
   ```

The end marker summarizes this session's compression effect from existing
telemetry (events per strategy, before/delivered/saved chars, model-visible
count, fallbacks) into the dashboard log. `--task` should be one short label
describing what the user asked for.

## Compression policy routing

The Compression Policy Router maps each task to one of three modes; the skill
loads resources by the same rule:

| Mode | Skill load | Applies to |
|---|---|---|
| native | none | rename, API migration, known-target spec→code |
| assist | one primary resource | traceability, gap analysis, impact analysis |
| aggressive | primary + exploration | bug analysis, complex debugging, large-repo investigation |

In assist mode keep read outputs raw (no summarization/truncation of reads);
apply the loaded resource's evidence rules only.

## Resource routing

Route by task type directly. `resources/index.md` is an auxiliary reference, not
a required first step:

- bug investigation / root cause -> `resources/bug_analysis.md`
- traceability / requirement mapping / coverage -> `resources/traceability.md`
- gap detection / missing implementation -> `resources/gap_analysis.md`
- spec proposal / design change -> `resources/spec_proposal.md`
- implementation / mutation / migration of a known target -> `resources/mutation.md`
- orientation / exploration -> `resources/exploration.md`

## Resource loading policy

Default: load one primary resource for the task type.

Additional resources are allowed only when:

1. Current evidence is insufficient.
2. The additional resource directly resolves the uncertainty.

Avoid loading unrelated markdown files or full documentation.

## General principles

1. Prefer existing repository structure.
2. Avoid unnecessary exploration.
3. Read only required files.
4. Stop after evidence is sufficient.

## Exploration policy

When repository structure is already known, prefer `repo_map`, `grep`, `glob`,
and targeted reads. Avoid recursive directory listing, repeated `cd`, and broad
filesystem exploration. Only perform broad exploration when existing evidence is
insufficient.

## Stop condition

Stop exploration when:

1. Target files are identified.
2. Required evidence is collected.
3. Remaining uncertainty does not affect the answer.

Do not continue searching only for completeness. Before returning the final
answer, record the end telemetry marker (see "Session telemetry markers"):
`python scripts/session_marker.py end --task "<task type>" --outcome success|partial|failed`.
Read-only analysis returns the
analysis in the reply; never write repository files unless the user explicitly
asks to save them.
