# Safety boundaries

Classify each prospective Hook denial as `deny`, `rewrite`, or `guide`.

## Deny

Retain a visible hard block when execution could cross a security, authorization, or recovery boundary:

- Access or mutation outside the locked target repository.
- Forbidden system, credential, secret, or policy-managed paths.
- Destructive filesystem or version-control operations without explicit authority.
- Uncontrolled writes, unsafe replacement payloads, or overwriting existing source through an unverified write path.
- Invalid helper arguments whose execution could target the wrong file.
- Explicit read-only task modes attempting mutation.

Hard denials must include a short stable code, the violated boundary, and one safe alternative.

## Rewrite

Silently rewrite when the requested operation has a semantics-preserving bounded form:

- Add explicit line ranges to a known file read.
- Replace broad output commands with an installed output-compression wrapper.
- Redirect a known helper invocation to its standalone CLI form.
- Narrow a repository-map command using already known scope.

Do not rewrite if quoting, shell semantics, target paths, or requested behavior would change.

## Guide

Handle these through the Skill and internal logs without a visible denial:

- Broad or repeated repository exploration.
- Full reads performed for convenience rather than necessity.
- Read/search budgets and focus budgets.
- Premature repository mapping, delegation, or specification rereads.
- Edit-pressure and workflow-phase reminders.
- Excessively verbose progress text or tool output.

When guidance is ignored repeatedly, narrow the next action programmatically if safe; do not promote an efficiency preference into a security denial.

## Compatibility default

Keep `strict` as the upgrade default. Enable `hybrid` only when the workflow Skill is installed and active. Reserve `guide` for controlled evaluation because it suppresses all policy denials.
