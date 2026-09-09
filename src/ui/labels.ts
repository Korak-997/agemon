const CAPABILITY_LABELS: Record<string, string> = {
  daemon: "Background service",
  skills: "Skills",
  "master-prompt": "Instruction files",
  crg: "code-review-graph",
  "cli-tool": "CLI tools",
};

export function capabilityLabel(capabilityId: string): string {
  return CAPABILITY_LABELS[capabilityId] ?? capabilityId;
}
