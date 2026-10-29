import { fileURLToPath } from "node:url";
import {
  bundledCatalogSkillDirectories,
  findRegistryMismatches,
  lintSkillAssets,
} from "./lint-skills/rules.js";

const SKILLS_ROOT = fileURLToPath(new URL("../assets/skills", import.meta.url));

const problems = [
  ...lintSkillAssets(SKILLS_ROOT),
  ...findRegistryMismatches(SKILLS_ROOT, bundledCatalogSkillDirectories()),
];
for (const problem of problems) {
  console.log(`assets/skills/${problem}`);
}
if (problems.length === 0) {
  console.log("lint-skills: every bundled skill passes");
}
process.exitCode = problems.length === 0 ? 0 : 1;
