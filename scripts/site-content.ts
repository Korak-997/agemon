import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createProgram } from "../src/cli/index.js";
import { errorMessage } from "../src/core/error-message.js";
import { SKILL_GROUPS } from "../src/plugins/skills/catalog.js";
import { generateSiteContent } from "./site-content/generate.js";

const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;

const repositoryRoot = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    "install-sh": {
      type: "string",
      default: join(repositoryRoot, "install.sh"),
    },
    sha256sums: { type: "string" },
    "release-tag": { type: "string" },
  },
});

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

try {
  const releaseTag = values["release-tag"];
  if (releaseTag !== undefined && !RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error(
      `--release-tag ${JSON.stringify(releaseTag)} is not a release tag like v1.2.3`,
    );
  }
  if ((releaseTag === undefined) !== (values.sha256sums === undefined)) {
    throw new Error("--release-tag and --sha256sums must be given together");
  }
  generateSiteContent({
    repositoryRoot,
    websiteRoot: join(repositoryRoot, "website"),
    skillGroups: SKILL_GROUPS,
    skillsRoot: join(repositoryRoot, "assets", "skills"),
    program: createProgram(() => {}),
    installScriptPath: resolve(values["install-sh"]),
    sha256SumsPath: values.sha256sums && resolve(values.sha256sums),
    releaseTag,
    repositoryRef: releaseTag ?? currentCommit(),
  });
  console.log(
    "site-content: generated the website's pages from the repository",
  );
} catch (error) {
  console.error(`site-content: ${errorMessage(error)}`);
  process.exitCode = 1;
}
