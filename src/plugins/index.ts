// Statically ordered — the orchestrator (Phase 1) walks this array in
// declaration order after resolving each plugin's `dependsOn`. No dynamic
// plugin discovery: anyone reading this file sees the exact execution order.
export const plugins = [];
