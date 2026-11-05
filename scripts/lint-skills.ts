import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SKILL_GROUPS } from "../src/plugins/skills/catalog.js";
import {
  bundledCatalogSkillDirectories,
  findReadmeGroupTableMismatches,
  findRegistryMismatches,
  lintSkillAssets,
} from "./lint-skills/rules.js";
import {
  findMarketplaceMismatch,
  MARKETPLACE_MANIFEST_PATH,
} from "./marketplace/manifest.js";

const SKILLS_ROOT = fileURLToPath(new URL("../assets/skills", import.meta.url));
const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));
const MARKETPLACE_PATH = fileURLToPath(
  new URL(`../${MARKETPLACE_MANIFEST_PATH}`, import.meta.url),
);

const problems = [
  ...[
    ...lintSkillAssets(SKILLS_ROOT),
    ...findRegistryMismatches(SKILLS_ROOT, bundledCatalogSkillDirectories()),
  ].map((problem) => `assets/skills/${problem}`),
  ...findReadmeGroupTableMismatches(
    readFileSync(README_PATH, "utf8"),
    SKILL_GROUPS,
  ),
  ...findMarketplaceMismatch(
    readFileSync(MARKETPLACE_PATH, "utf8"),
    SKILL_GROUPS,
  ),
];
for (const problem of problems) {
  console.log(problem);
}
if (problems.length === 0) {
  console.log("lint-skills: every bundled skill passes");
}
process.exitCode = problems.length === 0 ? 0 : 1;
