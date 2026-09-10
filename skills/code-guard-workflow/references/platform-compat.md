# Platform compatibility

## Enforcement modes

Configure `CODE_GUARD_ENFORCEMENT_MODE`:

- `strict`: preserve every existing Hook denial.
- `hybrid`: retain only hard safety denials; suppress workflow and efficiency denials.
- `guide`: suppress all Hook denials and rely on the Skill or platform instructions.

Unknown values must fall back to `strict`.

## Suppressed denial behavior

Return a normal allow result without `reason`, `permissionDecision`, `permissionDecisionReason`, or `additionalContext`. Write the original denial code to the private Hook log for diagnostics. This prevents Claude Code or Gemini-compatible clients from rendering a block card.

## Platform limitations

- A Skill guides model behavior but cannot intercept tool execution.
- A specification or project instruction has the same limitation.
- Post-tool output replacement, compression, and archival still require a Hook or platform capability.
- Clients control how genuine permission denials are rendered; a hard denial cannot reliably be hidden.

## Rollout

1. Install and validate the Skill.
2. Run the existing Hook suite in `strict` mode.
3. Run focused compatibility tests in `hybrid` mode.
4. Enable `hybrid` for normal sessions.
5. Review suppressed-denial logs before removing legacy workflow policy code.
