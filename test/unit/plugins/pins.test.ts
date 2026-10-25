import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as pins from "../../../src/plugins/pins.js";

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const NPM_REGISTRY_TARBALL_PATTERN =
  /^https:\/\/registry\.npmjs\.org\/(?:@[^/]+\/)?[^/]+\/-\/[^/]+\.tgz$/u;

interface ToolsLockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
}

async function readToolsJson<T>(fileName: string): Promise<T> {
  return JSON.parse(await readFile(`assets/tools/${fileName}`, "utf8")) as T;
}

describe("pins", () => {
  it("pins code-review-graph to an exact version", () => {
    expect(pins.CODE_REVIEW_GRAPH_VERSION).toMatch(EXACT_VERSION_PATTERN);
  });

  it("pins the Essentials skills to a full commit over https", () => {
    expect(pins.ESSENTIALS_SKILLS_COMMIT).toMatch(FULL_COMMIT_PATTERN);
    expect(pins.ESSENTIALS_SKILLS_REPOSITORY_URL).toMatch(/^https:\/\//u);
  });
});

describe("assets/tools lockfile", () => {
  it("declares the skills CLI at an exact version", async () => {
    const manifest = await readToolsJson<{
      dependencies: Record<string, string>;
    }>("package.json");

    expect(Object.keys(manifest.dependencies)).toEqual(["skills"]);
    expect(manifest.dependencies.skills).toMatch(EXACT_VERSION_PATTERN);
  });

  it("locks every package by integrity to a public-registry tarball", async () => {
    const manifest = await readToolsJson<{
      dependencies: Record<string, string>;
    }>("package.json");
    const lock = await readToolsJson<{
      packages: Record<string, ToolsLockPackage>;
    }>("package-lock.json");
    const lockedPackages = Object.entries(lock.packages).filter(
      ([path]) => path !== "",
    );

    expect(lock.packages["node_modules/skills"]?.version).toBe(
      manifest.dependencies.skills,
    );
    expect(lockedPackages.length).toBeGreaterThan(0);
    for (const [path, lockedPackage] of lockedPackages) {
      expect(lockedPackage.integrity, path).toMatch(/^sha512-/u);
      expect(lockedPackage.resolved, path).toMatch(
        NPM_REGISTRY_TARBALL_PATTERN,
      );
    }
  });
});
