import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMarketplaceManifest,
  findMarketplaceMismatch,
  MARKETPLACE_MANIFEST_PATH,
} from "../../../scripts/marketplace/manifest.js";
import { SKILL_GROUPS } from "../../../src/plugins/skills/catalog.js";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..");

describe("buildMarketplaceManifest", () => {
  const manifest = buildMarketplaceManifest(SKILL_GROUPS);

  it("offers every vendored group as a plugin", () => {
    expect(manifest.plugins.map((plugin) => plugin.name)).toEqual(
      SKILL_GROUPS.map((group) => `agemon-${group.id}`),
    );
  });

  it("points each plugin at a directory holding that group's skills", () => {
    for (const group of SKILL_GROUPS) {
      const plugin = manifest.plugins.find(
        (candidate) => candidate.name === `agemon-${group.id}`,
      );
      for (const skill of group.skills) {
        expect(
          existsSync(
            join(REPOSITORY_ROOT, plugin?.source ?? "", skill.id, "SKILL.md"),
          ),
        ).toBe(true);
      }
    }
  });
});

describe("findMarketplaceMismatch", () => {
  it("accepts the committed manifest", () => {
    const committed = readFileSync(
      join(REPOSITORY_ROOT, MARKETPLACE_MANIFEST_PATH),
      "utf8",
    );

    expect(findMarketplaceMismatch(committed, SKILL_GROUPS)).toEqual([]);
  });

  it("reports a manifest that no longer matches the catalog", () => {
    const stale = JSON.stringify({ name: "agemon", plugins: [] });

    expect(findMarketplaceMismatch(stale, SKILL_GROUPS)).toEqual([
      `${MARKETPLACE_MANIFEST_PATH} does not match the skill catalog; run 'npm run marketplace' and commit the result`,
    ]);
  });

  it("reports a manifest that is not JSON", () => {
    expect(findMarketplaceMismatch("not json", SKILL_GROUPS)).toHaveLength(1);
  });
});
