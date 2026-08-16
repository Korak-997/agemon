import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

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

async function promptBumpType(): Promise<BumpType> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
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
  } finally {
    rl.close();
  }
}

async function promptConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
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

function ensureChangelogEntry(version: string): void {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const hasEntry =
    changelog.includes(`## ${version}`) ||
    changelog.includes(`## [${version}]`);
  if (!hasEntry) {
    throw new Error(
      `CHANGELOG.md has no "## ${version}" entry. Add one, commit, and retry.`,
    );
  }
}

function revertVersionBump(): void {
  run("git", ["checkout", "--", "package.json", "package-lock.json"]);
}

async function main(): Promise<void> {
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

  try {
    ensureChangelogEntry(nextVersion);
  } catch (error) {
    revertVersionBump();
    throw error;
  }

  console.log(
    `\nReady to release ${previousVersion} -> ${nextVersion} on '${RELEASE_BRANCH}':`,
  );
  console.log("  1. commit package.json (+ package-lock.json)");
  console.log(`  2. tag v${nextVersion}`);
  console.log(`  3. push ${RELEASE_BRANCH} and the tag to origin`);

  if (!skipConfirm && !(await promptConfirm("Proceed?"))) {
    revertVersionBump();
    console.log("Aborted. Version bump reverted.");
    return;
  }

  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `release: ${nextVersion}`]);
  run("git", ["tag", "-a", `v${nextVersion}`, "-m", `v${nextVersion}`]);
  run("git", ["push", "origin", RELEASE_BRANCH, `v${nextVersion}`]);

  console.log(
    `\nPushed v${nextVersion}. GitHub Actions will build it and publish the GitHub Release.`,
  );
}

await main();
