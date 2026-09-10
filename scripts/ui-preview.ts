import {
  cancel,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  progress,
  select,
  spinner,
} from "@clack/prompts";
import { describeOperation } from "../src/plugins/proposed-operation.js";
import { renderBanner } from "../src/ui/banner.js";
import { renderRunSummary } from "../src/ui/summary.js";
import { theme } from "../src/ui/theme.js";

const animate = process.argv.includes("--slow");
const beatMs = animate ? 600 : 90;

function beat(multiplier = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, beatMs * multiplier));
}

function bailIfCancelled(value: unknown): void {
  if (isCancel(value)) {
    cancel("Preview cancelled.");
    process.exit(0);
  }
}

const instructionFilesOperation = describeOperation({
  capabilityId: "master-prompt",
  resourceId: "rule-file:AGENTS.md",
  targetPath: "AGENTS.md",
  action: "create",
  riskClass: "writes-config",
  requiresConsent: true,
  preview: { kind: "note", text: "write agemon's managed block" },
});

const codeReviewGraphOperation = describeOperation({
  capabilityId: "crg",
  resourceId: "package:code-review-graph",
  targetPath: "code-review-graph",
  action: "install-package",
  riskClass: "executes",
  requiresConsent: true,
  preview: { kind: "note", text: "pipx install code-review-graph" },
});

function previewEnvironmentLine(): void {
  log.step(theme.heading("Environment"));
  log.info("5/5 tools present — python3, pip, pipx, uv, code-review-graph");
}

async function previewGate(): Promise<void> {
  note(
    [
      "No .gitignore here. agemon needs /.agemon/ ignored so its regenerated",
      "state is never committed.",
      theme.dim("→ .gitignore"),
    ].join("\n"),
    theme.heading("Gate 1/4 — Workspace isolation"),
  );

  const choice = await select({
    message: "Create .gitignore with /.agemon/?",
    options: [
      { value: "approve", label: "Proceed" },
      { value: "decline", label: "Skip" },
      { value: "show-diff", label: "Show diff" },
    ],
    initialValue: "decline",
  });
  bailIfCancelled(choice);
  log.info(theme.dim(`resolved: ${String(choice)}`));
}

async function previewConflict(): Promise<void> {
  note(
    "CLAUDE.md already carries hand-written rules that differ from agemon's block.",
    theme.heading("Conflict — CLAUDE.md"),
  );

  const choice = await select({
    message: "How should agemon resolve CLAUDE.md?",
    options: [
      { value: "keep-mine", label: "Keep yours" },
      { value: "show-theirs", label: "Show agemon's" },
      { value: "skip", label: "Skip" },
    ],
    initialValue: "skip",
  });
  bailIfCancelled(choice);
  log.info(theme.dim(`resolved: ${String(choice)}`));
}

async function previewSkillMultiselect(): Promise<void> {
  const picked = await multiselect({
    message: "Optional skill groups to install",
    options: [
      { value: "design", label: "Design (4)", hint: "UI, diagrams, artifacts" },
      {
        value: "security",
        label: "Security (3)",
        hint: "review, threat-model",
      },
      { value: "data", label: "Data (5)", hint: "dataviz, notebooks" },
      { value: "docs", label: "Docs (2)", hint: "reference writing" },
      { value: "ops", label: "Ops (3)", hint: "deploy, schedule" },
      { value: "web", label: "Web (4)", hint: "framework integrations" },
    ],
    required: false,
    initialValues: [],
  });
  bailIfCancelled(picked);
  log.info(theme.dim(`selected: ${(picked as string[]).join(", ") || "none"}`));
}

async function previewApplyProgress(): Promise<void> {
  const capabilitySpinner = spinner({ indicator: "timer" });
  capabilitySpinner.start("Applying Instruction files  [1/2]");
  await beat(4);
  capabilitySpinner.message("Applying code-review-graph  [2/2]");
  await beat(4);
  capabilitySpinner.stop("Applied 2 capabilities");

  const stagingBar = progress({ style: "heavy", max: 7 });
  stagingBar.start("Staging files");
  for (let staged = 1; staged <= 7; staged += 1) {
    await beat();
    stagingBar.advance(1, `Staging files  ${staged}/7`);
  }
  stagingBar.stop("Staged 7 files");
}

function previewSummaries(): void {
  note(
    renderRunSummary({
      kind: "success",
      applied: [instructionFilesOperation, codeReviewGraphOperation],
      nextSteps: [
        "commit agemon.toml so teammates and CI reconcile the same way",
      ],
    }),
    theme.heading("Summary — success"),
  );

  note(
    renderRunSummary({
      kind: "declined",
      skipped: [
        { label: "code-review-graph", reason: "declined at the install gate" },
      ],
    }),
    theme.heading("Summary — declined"),
  );

  note(
    renderRunSummary({
      kind: "partial",
      appliedCount: 3,
      problems: ["daemon verify failed — service not active"],
    }),
    theme.heading("Summary — partial"),
  );

  note(
    renderRunSummary({
      kind: "failure",
      message: "daemon registration exploded",
      restored: ["restored AGENTS.md"],
      reverted: ["crg"],
      manualCleanup: ["crg: pipx uninstall unavailable"],
    }),
    theme.heading("Summary — failure"),
  );
}

async function main(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.log(
      "ui:preview needs a real terminal — run it directly, not piped or in CI.",
    );
    return;
  }

  console.log(renderBanner("agemon", "UI preview gallery"));
  intro(theme.heading(`agemon — UI preview${animate ? " (slow)" : ""}`));

  previewEnvironmentLine();
  await previewGate();
  await previewConflict();
  await previewSkillMultiselect();
  await previewApplyProgress();
  previewSummaries();

  outro(theme.ok("preview complete"));
}

await main();
