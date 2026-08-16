import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";

const RELEASE_BRANCH = "master";
const BUMP_TYPES = ["patch", "minor", "major"] as const;
type BumpType = (typeof BUMP_TYPES)[number];

function isBumpType(value: string): value is BumpType {
  return (BUMP_TYPES as readonly string[]).includes(value);
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "inherit" });
}

function runCapture(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function readPackageVersion(): string {
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

// A single readline interface is shared across every prompt in the run.
// Piped, non-TTY stdin (e.g. `printf "patch\ny\n" | npm run deploy`) is not
// reliably re-readable by a second interface once the first one closes —
// creating one per prompt silently hangs the second question forever.
let promptInterface: Interface | undefined;

function getPromptInterface(): Interface {
  if (!promptInterface) {
    promptInterface = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return promptInterface;
}

function closePromptInterface(): void {
  promptInterface?.close();
  promptInterface = undefined;
}

async function promptBumpType(): Promise<BumpType> {
  const rl = getPromptInterface();
  for (;;) {
    const answer = (
      await rl.question(`Select version bump (${BUMP_TYPES.join("/")}): `)
    )
      .trim()
      .toLowerCase();
    if (isBumpType(answer)) {
      return answer;
    }
    console.log(`Please enter one of: ${BUMP_TYPES.join(", ")}`);
  }
}

async function promptConfirm(message: string): Promise<boolean> {
  const rl = getPromptInterface();
  const answer = await rl.question(`${message} [y/N] `);
  return answer.trim().toLowerCase() === "y";
}

function ensureOnReleaseBranch(): void {
  const branch = runCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== RELEASE_BRANCH) {
    throw new Error(
      `Releases must be cut from '${RELEASE_BRANCH}' (currently on '${branch}').`,
    );
  }
}

function ensureCleanWorkingTree(): void {
  const status = runCapture("git", ["status", "--porcelain"]);
  if (status.length > 0) {
    throw new Error(
      "Working tree is not clean. Commit or stash changes before deploying.",
    );
  }
}

function hasChangelogEntry(version: string): boolean {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  return (
    changelog.includes(`## ${version}`) || changelog.includes(`## [${version}]`)
  );
}

function lastReleaseTag(): string | undefined {
  try {
    return runCapture("git", ["describe", "--tags", "--abbrev=0"]);
  } catch {
    return undefined;
  }
}

function commitSubjectsSince(ref: string | undefined): string[] {
  const range = ref ? `${ref}..HEAD` : "HEAD";
  const log = execFileSync("git", ["log", range, "--pretty=format:%s"], {
    encoding: "utf8",
  });
  return log
    .split("\n")
    .map((subject) => subject.trim())
    .filter((subject) => subject.length > 0)
    .filter((subject) => !subject.startsWith("release:"))
    .filter(
      (subject) => !/^docs: add \d+\.\d+\.\d+ changelog entry/i.test(subject),
    );
}

function draftChangelogEntry(version: string): string {
  const subjects = commitSubjectsSince(lastReleaseTag());
  const bullets =
    subjects.length > 0
      ? subjects.map((subject) => `- ${subject}`).join("\n")
      : "- No notable changes recorded.";
  return `## ${version}\n\n${bullets}\n`;
}

function insertChangelogEntry(entry: string): void {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const lines = changelog.split("\n");
  const headingIndex = lines.findIndex((line) => line.startsWith("# "));
  const insertAt = headingIndex === -1 ? 0 : headingIndex + 1;
  lines.splice(insertAt, 0, "", entry.trimEnd());
  writeFileSync(
    "CHANGELOG.md",
    `${lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()}\n`,
  );
}

function revertVersionBump(): void {
  run("git", ["checkout", "--", "package.json", "package-lock.json"]);
}

async function main(): Promise<void> {
  try {
    await deploy();
  } finally {
    closePromptInterface();
  }
}

async function deploy(): Promise<void> {
  const args = process.argv.slice(2);
  const skipConfirm = args.includes("--yes");
  const requestedBump = args.find(isBumpType);

  ensureOnReleaseBranch();
  ensureCleanWorkingTree();

  console.log("Syncing with origin...");
  run("git", ["pull", "--ff-only", "origin", RELEASE_BRANCH]);

  console.log("\nRunning quality checks (lint, typecheck, test, build)...");
  run("npm", ["run", "lint"]);
  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);
  run("npm", ["run", "build"]);

  const bumpType = requestedBump ?? (await promptBumpType());
  const previousVersion = readPackageVersion();

  run("npm", ["version", bumpType, "--no-git-tag-version"]);
  const nextVersion = readPackageVersion();

  if (!hasChangelogEntry(nextVersion)) {
    const draft = draftChangelogEntry(nextVersion);
    console.log(
      `\nNo "## ${nextVersion}" entry in CHANGELOG.md. Drafted one from commit history:\n`,
    );
    console.log(draft);

    if (!skipConfirm && !(await promptConfirm("Use this changelog entry?"))) {
      revertVersionBump();
      console.log(
        `Aborted. Add a "## ${nextVersion}" entry to CHANGELOG.md yourself, then retry.`,
      );
      return;
    }

    insertChangelogEntry(draft);
  }

  console.log(
    `\nReady to release ${previousVersion} -> ${nextVersion} on '${RELEASE_BRANCH}':`,
  );
  console.log("  1. commit package.json (+ package-lock.json + CHANGELOG.md)");
  console.log(`  2. tag v${nextVersion}`);
  console.log(`  3. push ${RELEASE_BRANCH} and the tag to origin`);

  if (!skipConfirm && !(await promptConfirm("Proceed?"))) {
    revertVersionBump();
    run("git", ["checkout", "--", "CHANGELOG.md"]);
    console.log("Aborted. Version bump reverted.");
    return;
  }

  run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
  run("git", ["commit", "-m", `release: ${nextVersion}`]);
  run("git", ["tag", "-a", `v${nextVersion}`, "-m", `v${nextVersion}`]);
  run("git", ["push", "origin", RELEASE_BRANCH, `v${nextVersion}`]);

  console.log(
    `\nPushed v${nextVersion}. GitHub Actions will build it and publish the GitHub Release.`,
  );
}

await main();
