import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_GROUPS } from "../src/plugins/skills/catalog.js";
import {
  buildMarketplaceManifest,
  MARKETPLACE_MANIFEST_PATH,
} from "./marketplace/manifest.js";

const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const outputPath = join(REPOSITORY_ROOT, MARKETPLACE_MANIFEST_PATH);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(buildMarketplaceManifest(SKILL_GROUPS), null, 2)}\n`,
);
execFileSync(
  join(REPOSITORY_ROOT, "node_modules/.bin/biome"),
  ["format", "--write", outputPath],
  { cwd: REPOSITORY_ROOT, stdio: "ignore" },
);
console.log(`Wrote ${MARKETPLACE_MANIFEST_PATH}.`);
