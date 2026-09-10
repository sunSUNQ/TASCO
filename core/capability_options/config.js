"use strict";

// Capability Options V1 — configuration resolution (Phase 1: infrastructure
// only, no behavior change).
//
// Two-layer config:
//   layer 1: profile (safe = current formal default; balanced / experimental
//            are registered names but NOT release entries in Phase 1)
//   layer 2: explicit capabilities override (advanced, experiment-only)
//
// Phase 1 equivalence: resolveCapabilityOptions({}) MUST equal the frozen
// v0.1 behavior (diagnostic.semantic_compression=auto, everything else=off).

const { CAPABILITIES, DEFAULT_CAPABILITY_STATES, STATUS } = require("./schema.js");

const PROFILES = Object.freeze({
  safe: {
    label: "Safe (current formal default)",
    releaseEntry: true,
    description: "Only formally frozen & released capabilities may be enabled (v0.1 = diagnostic.semantic_compression).",
  },
  balanced: {
    label: "Balanced (reserved; NOT a release entry in Phase 1)",
    releaseEntry: false,
    description: "Registered name only; no behaviorally different preset in Phase 1.",
  },
  experimental: {
    label: "Experimental (reserved; NOT a release entry in Phase 1)",
    releaseEntry: false,
    description: "Registered name only; no behaviorally different preset in Phase 1.",
  },
});

const VALID_PROFILES = new Set(Object.keys(PROFILES));

function assertValidId(id) {
  if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, id)) {
    throw new Error(`unknown capability id: ${id}`);
  }
}

function assertValidStatus(status) {
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`invalid capability status: ${status}`);
  }
}

/**
 * Resolve user configuration into a concrete capability option set.
 * input: { profile?: string, capabilities?: { [id]: status } }
 * returns: { profile, releaseEntry, capabilities: { [id]: status } }
 */
function resolveCapabilityOptions(input) {
  const cfg = input || {};
  const profile = String(cfg.profile || "safe");
  if (!VALID_PROFILES.has(profile)) {
    throw new Error(`unknown profile: ${profile} (valid: ${[...VALID_PROFILES].join(", ")})`);
  }
  const capabilities = Object.assign({}, DEFAULT_CAPABILITY_STATES);
  const overrides = cfg.capabilities || {};
  if (typeof overrides !== "object" || overrides === null) {
    throw new Error("capabilities must be an object");
  }
  for (const [id, status] of Object.entries(overrides)) {
    assertValidId(id);
    assertValidStatus(status);
    capabilities[id] = status;
  }
  return {
    profile,
    releaseEntry: PROFILES[profile].releaseEntry,
    capabilities,
  };
}

/**
 * Load user capability options from environment (CODE_GUARD_CAPABILITY_OPTIONS,
 * JSON). Missing / invalid JSON falls back to the frozen default.
 */
function loadCapabilityOptions(env) {
  const e = env || process.env;
  const raw = String(e.CODE_GUARD_CAPABILITY_OPTIONS || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_e) {}
  return {};
}

function getCapabilityStatus(id, options) {
  assertValidId(id);
  const opts = options && options.capabilities ? options : resolveCapabilityOptions(options);
  return opts.capabilities[id];
}

/**
 * A capability is "enabled" when it may intervene (auto / canary).
 * shadow records only; off disables; native is a decision-time protective
 * status and is not part of the Phase 1 default config.
 */
function isCapabilityEnabled(id, options) {
  const status = getCapabilityStatus(id, options);
  return status === STATUS.AUTO || status === STATUS.CANARY;
}

/**
 * Release gate: the formal default must be strictly equivalent to v0.1.
 * Throws unless the resolved config equals the frozen default
 * (profile=safe, diagnostic auto, all other capabilities off).
 */
function assertFormalDefault(options) {
  const resolved = resolveCapabilityOptions(options);
  if (!resolved.releaseEntry || resolved.profile !== "safe") {
    throw new Error("Capability Options release gate: only profile=safe is a release entry in Phase 1");
  }
  for (const id of Object.keys(CAPABILITIES)) {
    const expected = DEFAULT_CAPABILITY_STATES[id];
    if (resolved.capabilities[id] !== expected) {
      throw new Error(
        `Capability Options release gate: ${id} must stay ${expected} in the formal default (got ${resolved.capabilities[id]})`
      );
    }
  }
  return true;
}

module.exports = {
  PROFILES,
  VALID_PROFILES,
  resolveCapabilityOptions,
  loadCapabilityOptions,
  getCapabilityStatus,
  isCapabilityEnabled,
  assertFormalDefault,
};
